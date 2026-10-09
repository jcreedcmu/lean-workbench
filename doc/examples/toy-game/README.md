# Toy game example project

A project the workbench's `toy-game` view can present.
Paste these files into a project made from the basic template,
replacing its `lakefile.toml`, and keep that project's `lean-toolchain`.

- `GenerateGame.lean` is the generator.
  `lake exe generateGame --output DIR` writes `DIR/game.json`,
  holding a title and three levels, each a name, a Lean statement, and a hint.
- `workbench-publish.json` declares the `toy-game` view
  and names the Lake target that generates the levels.

Rebuild the view from `/<user>/<project>/view/toy-game`
to generate the levels and play them.
Publishing the same view serves `game.json` from the publish origin
for other code to fetch.
