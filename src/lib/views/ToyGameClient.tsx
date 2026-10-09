'use client'

import { useState } from 'react'
import useSWR from 'swr'

import ErrorBox from '@/app/components/ErrorBox'
import type { ViewClientProps } from '@/lib/server/views'

import { TOY_GAME_DATA_FILE, type ToyGame, zToyGame } from './toyGame'

/** Fetch and validate the game data the project's last build generated. */
async function fetchGame(baseUrl: string): Promise<ToyGame> {
  const response = await fetch(baseUrl + TOY_GAME_DATA_FILE)
  if (!response.ok) throw new Error(`Could not read ${TOY_GAME_DATA_FILE}: ${response.statusText}`)
  const parsed = zToyGame.safeParse(await response.json())
  if (!parsed.success) throw new Error(`${TOY_GAME_DATA_FILE} is not game data: ${parsed.error.issues[0]!.message}`)
  return parsed.data
}

/** A toy Lean game, played against the level list the project's own build generated.
 *
 * The data comes out of the project tree rather than a publication,
 * so it is whatever the last build wrote, which the rebuild control above replaces. */
export default function ToyGameClient({ data }: ViewClientProps) {
  const game = data['game']
  const gameUrl = game && 'url' in game ? game.url : undefined
  const [selected, setSelected] = useState(0)

  const { data: loaded, error } = useSWR<ToyGame, unknown>(
    gameUrl && ['toy-game', gameUrl],
    () => fetchGame(gameUrl!),
    { revalidateOnFocus: false },
  )

  if (gameUrl === undefined) {
    return <p className='empty'>This game has not been built yet. Rebuild it to generate its levels.</p>
  }
  if (error) return <ErrorBox>{error instanceof Error ? error.message : String(error)}</ErrorBox>
  if (!loaded) return <p className='empty'>Loading levels…</p>

  const level = loaded.levels[Math.min(selected, loaded.levels.length - 1)]!

  return (
    <>
      <h1>{loaded.title}</h1>
      <ol className='toy-game-levels'>
        {loaded.levels.map((l, i) => (
          <li key={l.name}>
            <button className={i === selected ? 'primary' : ''} onClick={() => setSelected(i)}>
              {l.name}
            </button>
          </li>
        ))}
      </ol>
      <pre className='lean-hover'>{level.statement}</pre>
      <p className='publish-card-detail'>{level.hint}</p>
    </>
  )
}
