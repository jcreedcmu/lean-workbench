/** Browser-side Lean LSP client.
 *
 * Talks to a `lake serve` process bridged to a WebSocket by {@link LeanLspHandle}.
 * Each WebSocket frame carries one JSON-RPC message (the bridge adds/strips the
 * `Content-Length` stdio framing), so this is a thin hand-rolled JSON-RPC client:
 * no `monaco`, no `vscode-languageclient`. */

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** Minimal JSON-RPC 2.0 client over a WebSocket. */
export class JsonRpcWebSocket {
  private nextId = 1
  private pending = new Map<number, Pending>()

  /** Resolves when the socket closes, carrying the server's close code and reason. */
  readonly closed: Promise<CloseEvent>

  private constructor(
    private readonly ws: WebSocket,
    /** Invoked for server-initiated notifications (id-less messages). */
    private readonly onNotify: (method: string, params: unknown) => void,
  ) {
    const { promise, resolve } = Promise.withResolvers<CloseEvent>()
    this.closed = promise
    ws.addEventListener('close', ev => {
      // A closed socket (e.g. the `lake serve` behind it exited) can never answer; fail
      // in-flight requests rather than let them hang, since there is no per-request timeout.
      this.rejectPending(new Error(ev.reason === '' ? 'The Lean server connection closed.' : ev.reason))
      resolve(ev)
    })
  }

  /** Resolves once the socket is open. */
  static connect(
    path: string,
    onNotify: (method: string, params: unknown) => void = () => {},
  ): Promise<JsonRpcWebSocket> {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${location.host}${path}`)
    const client = new JsonRpcWebSocket(ws, onNotify)
    ws.onmessage = ev => client.onMessage(String(ev.data))
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(client)
      ws.onerror = () => reject(new Error(`Could not reach the Lean server at ${path}.`))
    })
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  private rejectPending(error: unknown) {
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  private onMessage(data: string) {
    const msg = JSON.parse(data) as {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }
    if (typeof msg.id !== 'number') {
      // Server-initiated notification (e.g. diagnostics, file progress); the caller drives requests.
      if (typeof msg.method === 'string') this.onNotify(msg.method, msg.params)
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'JSON-RPC error'))
    else p.resolve(msg.result)
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notify(method: string, params?: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  close(): void {
    this.ws.close()
  }
}

/** LSP severity for a diagnostic that means the document is wrong, from the LSP specification. */
export const LSP_SEVERITY_ERROR = 1

/** One thing Lean reports about a document. */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  /** 1 error, 2 warning, 3 information, 4 hint; absent when the server does not say. */
  severity?: number
  message: string
}

/** LSP `Hover.contents` is one of several shapes; reduce it to plain text. */
function hoverText(contents: unknown): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(hoverText).join('\n')
  if (contents && typeof contents === 'object' && 'value' in contents) {
    return String(contents.value)
  }
  return ''
}

/** A Lean LSP session for one live view, reused across identifier lookups.
 *
 * The socket is opened by {@link connect} and held for the life of the page: the server
 * reclaims a view that has none attached. Once it closes, the session is finished and
 * reports why through `onEnd`; the server has torn down the Lean process behind it, so
 * the page must be reloaded to get another. */
export class LeanLspSession {
  private client: JsonRpcWebSocket | undefined
  private connecting: Promise<JsonRpcWebSocket> | undefined
  private opened = false
  private version = 0
  private baseText = ''
  private readonly uri: string
  /** Diagnostics most recently published for {@link uri}. */
  private diagnostics: LspDiagnostic[] = []
  /** Why the session finished, once it has. */
  private ended: string | undefined

  constructor(
    private readonly opts: {
      /** Browser path of the view's WebSocket endpoint. */
      path: string
      /** Where the Lean server sees the project, which is its workspace root. */
      projectDir: string
      /** Project-relative path of the scratch document lookups are elaborated in. */
      fileName: string
      /** Fetches the source that precedes the lookup in that document; called afresh on connect.
       * Without it a lookup resolves only what the project's Lean environment provides by default. */
      loadContext?: () => Promise<string>
      /** Called once, with a message for the user, when the session finishes. */
      onEnd: (reason: string) => void
    },
  ) {
    this.uri = `file://${opts.projectDir}${opts.fileName}`
  }

  /** Open the connection. Call once, on mount: an unattached view is reclaimed server-side. */
  connect(): void {
    void this.ensureClient().catch((err: unknown) => this.end(err instanceof Error ? err.message : String(err)))
  }

  private end(reason: string): void {
    if (this.ended !== undefined) return
    this.ended = reason
    this.opts.onEnd(reason)
  }

  private onNotify(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return
    const published = params as { uri?: string; diagnostics?: LspDiagnostic[] }
    if (published.uri !== this.uri) return
    this.diagnostics = published.diagnostics ?? []
  }

  private async open(): Promise<JsonRpcWebSocket> {
    const [client, baseText] = await Promise.all([
      JsonRpcWebSocket.connect(this.opts.path, (method, params) => this.onNotify(method, params)),
      this.opts.loadContext?.() ?? '',
    ])
    void client.closed.then(ev => this.end(ev.reason === '' ? 'The Lean server connection closed.' : ev.reason))
    this.baseText = baseText
    const rootUri = `file://${this.opts.projectDir.replace(/\/$/, '')}`
    await client.request('initialize', {
      processId: null,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: 'project' }],
    })
    client.notify('initialized', {})
    this.client = client
    this.opened = false
    return client
  }

  private ensureClient(): Promise<JsonRpcWebSocket> {
    if (this.ended !== undefined) return Promise.reject(new Error(this.ended))
    if (this.client?.isOpen) return Promise.resolve(this.client)
    this.connecting ??= this.open().finally(() => (this.connecting = undefined))
    return this.connecting
  }

  /** Make `text` the whole scratch document and wait until Lean has finished elaborating it. */
  private async elaborate(client: JsonRpcWebSocket, text: string): Promise<void> {
    const version = ++this.version
    if (this.opened) {
      client.notify('textDocument/didChange', {
        textDocument: { uri: this.uri, version },
        contentChanges: [{ text }],
      })
    } else {
      client.notify('textDocument/didOpen', {
        textDocument: { uri: this.uri, languageId: 'lean4', version, text },
      })
      this.opened = true
    }
    // Answers once every diagnostic for `version` or later has been emitted,
    // so whatever the caller reads next sees a fully elaborated document.
    // Note the bare `uri`: these params are not a `TextDocumentIdentifier`.
    await client.request('textDocument/waitForDiagnostics', { uri: this.uri, version })
  }

  /** Elaborate `text` as the whole scratch document and return what Lean reports about it. */
  async check(text: string): Promise<LspDiagnostic[]> {
    const client = await this.ensureClient()
    this.diagnostics = []
    await this.elaborate(client, text)
    return this.diagnostics
  }

  /** Look up `identifier` in the project's context, returning the LSP's hover text
   * (type plus docstring), or `null` if it resolves to nothing. */
  async lookup(identifier: string): Promise<string | null> {
    const client = await this.ensureClient()

    const base = this.baseText.endsWith('\n') ? this.baseText : this.baseText === '' ? '' : this.baseText + '\n'
    const checkLine = base.split('\n').length - 1
    await this.elaborate(client, `${base}#check ${identifier.replace(/\s+/g, ' ').trim()}\n`)

    // `#check <id>` places the identifier at character 7, just past "#check ", on the last line.
    const hover = await client.request<{ contents: unknown } | null>('textDocument/hover', {
      textDocument: { uri: this.uri },
      position: { line: checkLine, character: 7 },
    })
    const info = hover ? hoverText(hover.contents).trim() : ''
    return info === '' ? null : info
  }

  /** Finish the session without reporting it to `onEnd`; the page is going away. */
  close(): void {
    this.ended ??= 'The page closed the session.'
    this.client?.close()
  }
}
