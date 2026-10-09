import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'

import { type BaseProject, type BaseUser, bwrapProjectDir, WS_VIEW_DISPLACED } from '@leanprover/workbench-shared'
import { BWRAP_ARGS, bwrapHomeDir, getElanDir } from '@leanprover/workbench-shared/node'
import { type WebSocket, WebSocketServer } from 'ws'

import { ensureUserHomeDir } from './user.ts'

/** Name of the LSP bridge UDS file. */
const LSP_SOCKET_FILENAME = 'lsp.sock'

/** How long a handle survives with no WebSocket attached before reclaiming itself. */
const LSP_IDLE_TIMEOUT_MS = 5 * 60_000

/** How many `lake serve` processes may run at once across all views.
 * Each is a full Lean instance, so this is a memory ceiling rather than a fairness policy. */
const MAX_LAKE_SERVES = 8

/** WebSocket close code, from RFC 6455 section 7.4.1. */
const WS_TRY_AGAIN_LATER = 1013

/** Running `lake serve` count, against {@link MAX_LAKE_SERVES}. */
let lakeServes = 0

/** Bridge a WebSocket to a `lake serve` child's stdio.
 *
 * The browser exchanges one JSON-RPC message per WebSocket frame,
 * while `lake serve` speaks `Content-Length`-framed JSON-RPC over stdio;
 * this translates between the two framings.
 * Returns the function that unbinds both directions. */
function bridge(ws: WebSocket, proc: ChildProcess): () => void {
  let stdoutBuf = Buffer.alloc(0)
  let failed = false

  /** Give up on this connection.
   * A stdio stream we cannot frame is unrecoverable:
   * skipping ahead to the next parsable header would silently drop whole messages,
   * including ones already buffered behind the offending bytes.
   * Closing the socket runs the caller's teardown, which kills the process. */
  const fail = (why: string) => {
    failed = true
    const head = JSON.stringify(stdoutBuf.subarray(0, 200).toString('utf-8'))
    console.error(`[LeanLspHandle] ${why}; closing connection. Buffer began with ${head}`)
    stdoutBuf = Buffer.alloc(0)
    ws.close(1011, 'LSP stream desynchronized')
  }

  const onStdout = (chunk: Buffer) => {
    if (failed) return
    stdoutBuf = Buffer.concat([stdoutBuf, chunk])
    // Emit as many complete Content-Length frames as are buffered.
    for (;;) {
      const headerEnd = stdoutBuf.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const header = stdoutBuf.subarray(0, headerEnd).toString('ascii')
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i)
      if (!lengthMatch) {
        fail('read a header carrying no Content-Length')
        return
      }
      const bodyStart = headerEnd + 4
      const bodyLength = Number(lengthMatch[1])
      if (stdoutBuf.length < bodyStart + bodyLength) break
      ws.send(stdoutBuf.subarray(bodyStart, bodyStart + bodyLength).toString('utf-8'))
      stdoutBuf = stdoutBuf.subarray(bodyStart + bodyLength)
    }
  }

  const onMessage = (data: Buffer) => {
    const body = data.toString('utf-8')
    proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  proc.stdout!.on('data', onStdout)
  ws.on('message', onMessage)
  return () => {
    proc.stdout!.off('data', onStdout)
    ws.off('message', onMessage)
  }
}

/** Manages a standalone Lean LSP endpoint (`lake serve`) for a view of a project.
 * Non-reusable; construct a new handle to start a new endpoint.
 *
 * Unlike the editor's VS Code server this needs no extra sandboxed workspace:
 * `lake serve` is the whole backend, run in the same shared project mount.
 *
 * At most one WebSocket is attached at a time, with its own `lake serve` bridged
 * to its stdio; a new connection displaces the old one, so a viewer's open views
 * of a project cost one Lean instance rather than one per tab. Every connection
 * therefore starts from a clean LSP `initialize` handshake.
 *
 * The attached socket is also the handle's liveness signal: with none attached
 * for {@link LSP_IDLE_TIMEOUT_MS} the handle disposes itself, releasing its
 * project mount lease. */
export class LeanLspHandle implements AsyncDisposable {
  /** Unique ID of this LSP endpoint; also the nginx route segment. */
  readonly uuid = crypto.randomUUID()
  /** Directory holding the bridge UDS file. */
  readonly socketDir = `/tmp/lsp-${this.uuid}/`
  /** Host path to the bridge UDS file. */
  readonly socketPath = path.join(this.socketDir, LSP_SOCKET_FILENAME)

  readonly viewer
  readonly project

  constructor(viewer: BaseUser, project: BaseProject) {
    this.viewer = viewer
    this.project = project
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.started = promise
    this.resolveStarted = resolve
    this.rejectStarted = reject
    // A view whose page never connects is reclaimed like one whose page went away.
    this.armIdleTimer()
  }

  private startCalled = false
  /** Resolves once the bridge socket is listening; rejects on startup failure. */
  readonly started: Promise<void>
  private readonly resolveStarted: () => void
  private readonly rejectStarted: (err: unknown) => void

  /** `bwrap` args binding the project directory, applied to each connection's `lake serve`. */
  private projectBindArgs: string[] = []
  /** The attached socket and the teardown that unbinds it, kills its process, and closes it. */
  private connection: { ws: WebSocket; teardown: () => void } | undefined
  /** Runs {@link Symbol.asyncDispose} once no socket has been attached for long enough. */
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disposing: Promise<void> | undefined
  private disposables = new AsyncDisposableStack()
  /** The viewer's persistent home directory, resolved by {@link start}. */
  private homeDir = ''

  private get description(): string {
    return `lean-lsp ${this.uuid} (project ${this.project.id}, viewer ${this.viewer.id})`
  }

  /** Whether shutdown has begun. Such a handle must not be handed out again. */
  get isDisposing(): boolean {
    return this.disposing !== undefined
  }

  /** Browser path that reaches this endpoint through the nginx `/_lsp/` route. */
  get lspSocketUrl(): string {
    return `/_lsp/${this.uuid}/`
  }

  /** Reclaim the handle unless a socket attaches within {@link LSP_IDLE_TIMEOUT_MS}. */
  private armIdleTimer(): void {
    if (this.disposing) return
    this.idleTimer ??= setTimeout(() => void this[Symbol.asyncDispose](), LSP_IDLE_TIMEOUT_MS).unref()
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Signal the endpoint to start listening. May only be called once; await {@link started}. */
  start(
    /** Arguments to `bwrap` that bind the project directory. Placed at the end. */
    projectBindArgs: string[],
  ): void {
    if (this.startCalled) throw new Error(`Tried to start ${this.description} more than once.`)
    if (this.disposing) throw new Error(`${this.description} was disposed before start.`)
    this.startCalled = true
    this.projectBindArgs = projectBindArgs
    ;(async () => {
      await fs.mkdir(this.socketDir, { recursive: true })
      this.disposables.defer(async () => {
        await fs.rm(this.socketDir, { recursive: true, force: true })
      })

      // The viewer's home directory gives `lake` a writable place for its caches.
      this.homeDir = await ensureUserHomeDir(this.viewer)

      const wss = new WebSocketServer({ noServer: true })
      const httpServer = createServer()
      httpServer.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
      })
      wss.on('connection', ws => this.handleConnection(ws))
      this.disposables.defer(async () => {
        this.connection?.teardown()
        await new Promise<void>(resolve => httpServer.close(() => resolve()))
      })

      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(this.socketPath, resolve)
      })
    })().then(this.resolveStarted, this.rejectStarted)
  }

  /** Spawn a `lake serve` inside the project's bwrap sandbox. */
  private spawnLakeServe(): ChildProcess {
    const sandboxHomeDir = bwrapHomeDir(this.viewer.name)
    return spawn(
      'bwrap',
      // prettier-ignore
      [
        ...BWRAP_ARGS,
        '--ro-bind', getElanDir(), getElanDir(),
        '--bind', this.homeDir, sandboxHomeDir,
        '--setenv', 'HOME', sandboxHomeDir,
        '--setenv', 'ELAN_HOME', getElanDir(),
        '--setenv', 'PATH', `${getElanDir()}/bin:/usr/local/bin:/usr/bin:/bin`,
        // The overlay mount makes `lake`'s dependency clones look dubiously owned to Git
        // (CVE-2022-24765); see the same workaround in `VscodeServerHandle.start`.
        '--setenv', 'GIT_CONFIG_COUNT', '1',
        '--setenv', 'GIT_CONFIG_KEY_0', 'safe.directory',
        '--setenv', 'GIT_CONFIG_VALUE_0', '*',
        '--chdir', bwrapProjectDir(this.project.name),
        ...this.projectBindArgs,
        '--',
        path.join(getElanDir(), 'bin', 'lake'), 'serve',
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    )
  }

  /** Give a new connection its own `lake serve`, tearing both down when either ends.
   * The connection displaces any earlier one, and keeps the handle alive while it lasts. */
  private handleConnection(ws: WebSocket): void {
    // Displace first, so a view that is merely reconnecting frees its own slot
    // and is never refused in favour of itself. The reason reaches the displaced tab.
    this.connection?.ws.close(WS_VIEW_DISPLACED, 'This view was opened again elsewhere.')
    this.connection?.teardown()

    if (lakeServes >= MAX_LAKE_SERVES) {
      console.warn(`${this.description}: refused, ${lakeServes} Lean servers already running`)
      ws.close(WS_TRY_AGAIN_LATER, 'Too many Lean servers are running right now.')
      return
    }

    this.disarmIdleTimer()
    const proc = this.spawnLakeServe()
    lakeServes++
    const unbind = bridge(ws, proc)
    let torn = false
    const teardown = () => {
      if (torn) return
      torn = true
      lakeServes--
      if (this.connection?.ws === ws) {
        this.connection = undefined
        this.armIdleTimer()
      }
      unbind()
      proc.kill()
      ws.close()
    }
    this.connection = { ws, teardown }
    proc.on('error', err => {
      console.error(`error in ${this.description}: ${String(err)}`)
      teardown()
    })
    proc.on('close', () => teardown())
    ws.on('close', () => teardown())
  }

  /** Add a callback to the LIFO {@link AsyncDisposableStack} that runs on disposal. */
  addDisposable(f: () => Promise<void>) {
    this.disposables.defer(f)
  }

  /** Shut the endpoint down and release its resources.
   * Repeated calls produce the same promise. Must be invoked after a `start()` failure. */
  async [Symbol.asyncDispose]() {
    if (this.disposing) return this.disposing
    this.disarmIdleTimer()
    this.disposing = (async () => {
      if (this.startCalled) {
        await this.started.catch(() => {})
      } else {
        this.rejectStarted(new Error(`${this.description} was disposed before start.`))
      }
      await this.disposables.disposeAsync()
    })()
    await this.disposing
  }
}
