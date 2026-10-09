'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'

import ErrorBox from '@/app/components/ErrorBox'
import { LeanLspSession } from '@/lib/leanLspClient'
import type { ViewClientProps } from '@/lib/server/views'

/** Project-relative scratch document that lookups are elaborated in.
 * It need not exist on disk: the LSP holds the text the session sends it. */
const PROBE_FILE = 'Hello.lean'

/** Project file prepended to the scratch document,
 * so that lookups resolve what the project itself defines and not only Lean core. */
export const HELLO_CONTEXT_FILE = 'Main.lean'

/** Interactive probe that a live view reaches a Lean process with no VS Code in the loop:
 * the `lake serve` behind the view's WebSocket answers hover queries
 * for whatever identifier you type, against the project's own source as context. */
export default function HelloClient({ projectDir, backends, data: dataDirs }: ViewClientProps) {
  const path = backends['lean-lsp']
  const context = dataDirs['context']

  /** Set when the view's Lean server is gone for good, with a message explaining why. */
  const [ended, setEnded] = useState<string | null>(null)

  const sessionRef = useRef<LeanLspSession | null>(null)
  sessionRef.current ??= new LeanLspSession({
    path: path ?? '',
    projectDir,
    fileName: PROBE_FILE,
    // Read on every (re)connect rather than once on render,
    // so a reconnect picks up edits made in the editor since the page loaded.
    loadContext: async () => {
      if (!context || 'missing' in context) return ''
      const response = await fetch(context.url + HELLO_CONTEXT_FILE)
      return response.ok ? response.text() : ''
    },
    onEnd: setEnded,
  })
  // Hold the socket open for as long as the page is here: the server reclaims an idle view.
  useEffect(() => {
    const session = sessionRef.current!
    session.connect()
    return () => session.close()
  }, [])

  const [input, setInput] = useState('Nat.add')
  /** The submitted identifier, tagged with a submission count so that
   * resubmitting the same one runs a fresh lookup instead of reading SWR's cache. */
  const [query, setQuery] = useState<{ n: number; identifier: string } | null>(null)

  // The LSP round-trip is diagnostic, so surface failures here rather than to an error boundary.
  const { data, error, isLoading } = useSWR<string | null, unknown>(
    query && ['lean-lookup', query.n, query.identifier],
    () => sessionRef.current!.lookup(query!.identifier),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )

  if (!path) return <ErrorBox>This view has no Lean server.</ErrorBox>

  return (
    <>
      <h1>Hello, Lean LSP</h1>
      <p>
        Querying a standalone <code>lake serve</code> on this project, with <code>{HELLO_CONTEXT_FILE}</code> loaded as
        context. Type an identifier (e.g. <code>Nat.add</code>) to see its type and docstring.
      </p>
      {ended !== null ? (
        <ErrorBox>{ended} Reload the page to start a new view.</ErrorBox>
      ) : (
        <>
          <form
            onSubmit={e => {
              e.preventDefault()
              const identifier = input.trim()
              setQuery(prev => (identifier ? { n: (prev?.n ?? 0) + 1, identifier } : null))
            }}
          >
            <input value={input} onChange={e => setInput(e.target.value)} placeholder='identifier' />
            <button type='submit'>Look up</button>
          </form>
          {query === null ? null : isLoading ? (
            <p>Looking up {query.identifier}…</p>
          ) : error ? (
            <ErrorBox>
              <pre>{String(error instanceof Error ? error.message : error)}</pre>
            </ErrorBox>
          ) : data ? (
            <pre className='lean-hover'>{data}</pre>
          ) : (
            <p>
              No information for <code>{query.identifier}</code>.
            </p>
          )}
        </>
      )}
    </>
  )
}
