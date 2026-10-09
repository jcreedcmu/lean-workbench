'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'

import ErrorBox from '@/app/components/ErrorBox'
import { LeanLspSession, LSP_SEVERITY_ERROR, type LspDiagnostic } from '@/lib/leanLspClient'
import type { ViewClientProps } from '@/lib/server/views'

import { TOY_GAME_DATA_FILE, type ToyGame, type ToyGameLevel, zToyGame } from './toyGame'

/** Project-relative scratch document attempts are elaborated in.
 * It need not exist on disk: the LSP holds the text the session sends it. */
const PLAY_FILE = 'ToyGamePlay.lean'

/** Fetch and validate the game data the project's last build generated. */
async function fetchGame(baseUrl: string): Promise<ToyGame> {
  const response = await fetch(baseUrl + TOY_GAME_DATA_FILE)
  if (!response.ok) throw new Error(`Could not read ${TOY_GAME_DATA_FILE}: ${response.statusText}`)
  const parsed = zToyGame.safeParse(await response.json())
  if (!parsed.success) throw new Error(`${TOY_GAME_DATA_FILE} is not game data: ${parsed.error.issues[0]!.message}`)
  return parsed.data
}

/** The level's statement proved by the player's tactic block, as a whole Lean document. */
function attemptDocument(level: ToyGameLevel, tactics: string): string {
  const indented = tactics
    .split('\n')
    .map(line => '  ' + line)
    .join('\n')
  return `${level.statement} := by\n${indented}\n`
}

/** Whether Lean reports the attempt as a finished proof.
 * `sorry` closes any goal, and Lean reports having used it as a warning rather than an error,
 * so a solved level is one with no errors and no mention of `sorry`. */
function isSolved(diagnostics: LspDiagnostic[]): boolean {
  return !diagnostics.some(d => d.severity === LSP_SEVERITY_ERROR || /\bsorry\b/.test(d.message))
}

/** A toy Lean game, played against a live Lean process.
 *
 * The levels come out of the project tree rather than a publication,
 * so they are whatever the last build wrote, which the rebuild control above replaces. */
export default function ToyGameClient({ projectDir, backends, data }: ViewClientProps) {
  const game = data['game']
  const gameUrl = game && 'url' in game ? game.url : undefined
  const path = backends['lean-lsp']

  /** Set when the view's Lean server is gone for good, with a message explaining why. */
  const [ended, setEnded] = useState<string | null>(null)

  const sessionRef = useRef<LeanLspSession | null>(null)
  sessionRef.current ??= new LeanLspSession({
    path: path ?? '',
    projectDir,
    fileName: PLAY_FILE,
    onEnd: setEnded,
  })
  // Hold the socket open for as long as the page is here: the server reclaims an idle view.
  useEffect(() => {
    const session = sessionRef.current!
    session.connect()
    return () => session.close()
  }, [])

  const { data: loaded, error: loadError } = useSWR<ToyGame, unknown>(
    gameUrl && ['toy-game', gameUrl],
    () => fetchGame(gameUrl!),
    { revalidateOnFocus: false },
  )

  const [selected, setSelected] = useState(0)
  const [tactics, setTactics] = useState('')
  /** The submitted tactic block, tagged with a submission count so that
   * resubmitting the same one runs a fresh check instead of reading SWR's cache. */
  const [attempt, setAttempt] = useState<{ n: number; level: ToyGameLevel; tactics: string } | null>(null)

  // A failed round-trip is diagnostic, so surface it here rather than to an error boundary.
  const {
    data: diagnostics,
    error: checkError,
    isLoading: checking,
  } = useSWR<LspDiagnostic[], unknown>(
    attempt && ['toy-game-check', attempt.n],
    () => sessionRef.current!.check(attemptDocument(attempt!.level, attempt!.tactics)),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )

  if (gameUrl === undefined) {
    return <p className='empty'>This game has not been built yet. Rebuild it to generate its levels.</p>
  }
  if (!path) return <ErrorBox>This view has no Lean server.</ErrorBox>
  if (loadError) return <ErrorBox>{loadError instanceof Error ? loadError.message : String(loadError)}</ErrorBox>
  if (!loaded) return <p className='empty'>Loading levels…</p>

  const level = loaded.levels[Math.min(selected, loaded.levels.length - 1)]!

  return (
    <>
      <h1>{loaded.title}</h1>
      {ended !== null && <ErrorBox>{ended} Reload the page to start a new session.</ErrorBox>}
      <ol className='toy-game-levels'>
        {loaded.levels.map((l, i) => (
          <li key={l.name}>
            <button
              className={i === selected ? 'primary' : ''}
              onClick={() => {
                setSelected(i)
                setTactics('')
                setAttempt(null)
              }}
            >
              {l.name}
            </button>
          </li>
        ))}
      </ol>
      <pre className='lean-hover'>{attemptDocument(level, tactics || 'sorry')}</pre>
      <p className='publish-card-detail'>{level.hint}</p>
      <form
        onSubmit={e => {
          e.preventDefault()
          setAttempt(prev => ({ n: (prev?.n ?? 0) + 1, level, tactics }))
        }}
      >
        <textarea
          className='toy-game-tactics'
          value={tactics}
          onChange={e => setTactics(e.target.value)}
          placeholder='tactic block, e.g. simp'
          rows={4}
        />
        <button className='primary' type='submit' disabled={ended !== null || tactics.trim() === ''}>
          Check
        </button>
      </form>
      {checking ? (
        <p>Checking with Lean…</p>
      ) : checkError ? (
        <ErrorBox>{checkError instanceof Error ? checkError.message : String(checkError)}</ErrorBox>
      ) : diagnostics ? (
        isSolved(diagnostics) ? (
          <p className='toy-game-solved'>Solved.</p>
        ) : (
          <pre className='lean-hover'>
            {diagnostics.map(d => `${d.range.start.line + 1}: ${d.message}`).join('\n\n')}
          </pre>
        )
      ) : null}
    </>
  )
}
