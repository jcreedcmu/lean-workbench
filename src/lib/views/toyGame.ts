import z from 'zod'

/** Project-relative directory a toy game's build writes its data into.
 * Must match `GAME_DIR` in `scripts/build-toy-game.sh`. */
export const TOY_GAME_DATA_DIR = '.lake/toy-game'

/** File the generator writes, and the only one the client reads. */
export const TOY_GAME_DATA_FILE = 'game.json'

/** One puzzle: a Lean statement to prove, and a nudge towards proving it. */
export const zToyGameLevel = z.object({
  name: z.string(),
  /** Lean statement the player proves, up to and including the `:=`-less theorem header. */
  statement: z.string(),
  hint: z.string(),
})

/** What a toy game's build generates, and what a published toy game serves. */
export const zToyGame = z.object({
  title: z.string(),
  levels: z.array(zToyGameLevel).min(1),
})

export type ToyGame = z.infer<typeof zToyGame>
export type ToyGameLevel = z.infer<typeof zToyGameLevel>
