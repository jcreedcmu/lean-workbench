import Lean.Data.Json

open Lean

structure Level where
  name : String
  statement : String
  hint : String
deriving ToJson

structure Game where
  title : String
  levels : Array Level
deriving ToJson

def game : Game where
  title := "Three Easy Pieces"
  levels := #[
    { name := "Reflexivity"
      statement := "theorem reflexivity (n : Nat) : n = n"
      hint := "Both sides are the same term, so `rfl` closes it." },
    { name := "Zero on the right"
      statement := "theorem add_zero_again (n : Nat) : n + 0 = n"
      hint := "`simp` knows this one, and so does `omega`." },
    { name := "Commuting"
      statement := "theorem add_comm_again (m n : Nat) : m + n = n + m"
      hint := "Try `omega`, or induct on `n` with `induction n`." }
  ]

/-- Write the game's levels as `game.json` in the directory named by `--output`. -/
def main (args : List String) : IO UInt32 := do
  let outDir : System.FilePath ← match args with
    | ["--output", dir] => pure dir
    | _ => do
      IO.eprintln "usage: generateGame --output DIR"
      return 1
  IO.FS.createDirAll outDir
  IO.FS.writeFile (outDir / "game.json") ((toJson game).pretty ++ "\n")
  return 0
