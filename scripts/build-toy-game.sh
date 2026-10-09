#!/bin/bash
# Build a toy game's data and write a copy into the staging directory.
# Runs inside a bwrap sandbox, with the project as its working directory.
#
# The generator writes into the project tree, which is what the live view reads;
# the staged copy is what publishing takes.
#
# usage: build-toy-game.sh OUT_DIR EXE
#
# example:
# build-toy-game.sh /publish/out generate-game

set -euo pipefail

OUT_DIR="$1"; shift 1
EXE="$1"; shift 1

# Must match `TOY_GAME_DATA_DIR` in `src/lib/server/views.ts`.
GAME_DIR=".lake/toy-game"

echo "[[ progress 1/3 Building Lean project ]]"
lake --no-ansi --keep-toolchain build

echo "[[ progress 2/3 Generating game data ]]"
mkdir -p "$GAME_DIR"
lake --no-ansi exe "$EXE" --output "$GAME_DIR"

echo "[[ progress 3/3 Staging game data ]]"
cp -r "$GAME_DIR/." "$OUT_DIR/"
