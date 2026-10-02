# Implementation plan: view implementations

status: proposed

Companion to `plans/VIEW-IMPLEMENTATIONS.md`,
which this assumes for the concepts, the interfaces, and the reasoning.
This document says only what order to build it in.

Each numbered item is one pull request of roughly 300 lines changed.
PRs 1 through 10 reach the milestone worth reaching first:
a **toy game view**, built from Lean source in the project
and played in the browser against a live `lake serve`,
with no dependency on any client package outside this repository.
That milestone exercises every column of the capability table at once,
which is the only way to find out whether the interfaces hold.

## Decisions to settle before PR 2

- **The declaration file keeps its name.** `workbench-publish.json`
  becomes the project's view declaration for both facets,
  since renaming it would break every project that has one.
  The constant stays `PUBLISH_MANIFEST_FILE` or becomes `VIEW_MANIFEST_FILE`
  naming the same string.
- **The old app-origin path.** `/[userName]/[projectName]/[kind]` exists today
  and only redirects to the publish origin.
  Either keep it as a redirect to `view/[kind]`, or drop it and accept
  that app-origin bookmarks 404.
  Publication URLs on the publish origin are unaffected either way.

## Phase "One Registry"

### 1. Rename `ArtifactKind` to `ViewDefinition`

`src/lib/server/artifacts.ts` to `views.ts`,
`ArtifactKind` to `ViewDefinition`, `ARTIFACT_KINDS` to `VIEWS`,
`DetectedArtifact` to `DeclaredView`, `detectArtifact` to `detectView`,
`detectPublishable` to `detectViews`, `PublishManifest.views`,
and the owner-facing `"does not declare a '<kind>' artifact"` to `"... view"`.
`BuildPlan`, `siteDir`, and the `Publication` model keep their words.

Touches `views.ts`, `publish.ts`, `[kind]/page.tsx`,
`publish/page.tsx`, `publish/actions.ts`, `PublishCard.tsx`.
Mechanical, no behavior change, so it reviews in one pass
and keeps the rename noise out of PR 2.

### 2. Capability fields on `ViewDefinition`

`plan(config)` becomes the optional `build?(config)`,
`BuildPlan.siteDir` becomes optional (a build need not publish),
and `publish?: { shape: 'site' | 'data' }` appears,
with `verso` declaring `{ shape: 'site' }`.
Declare the `live?` field's type here too, with no view using it yet,
so PR 6 adds a registry entry rather than a type.

`DeclaredView` carries the facets alongside the resolved build,
and the publish page lists only views that declare `publish`.
`startPublishing` refuses a view with no `build`.
Nothing observable changes: `verso` is still the only view.

## Phase "Separate Route"

### 3. Move the route to `/view/[kind]`

`src/app/[userName]/[projectName]/view/[kind]/page.tsx` resolves the view in `VIEWS`,
reads the project's declaration, and dispatches on facets:
`publish` redirects to the publish origin as today,
`live` is a `notFound()` stub until PR 6.
A view the project does not declare is a 404 even when the registry knows it,
so the declaration is what enables a view on a project.

Adds `requireProjectAccess(userName, projectName)` to `src/lib/server/util.ts`,
the `canAccessProject` counterpart of `requireProjectOwner`,
returning `{ viewer, owner, project }` and 404ing rather than 403ing.
Adds the project page's link to each declared view.

## Phase "Live Mode"

### 4. `LeanLspHandle` in the shard manager

Forward-port `src/lib/server/leanLspServer.ts` from `branch-hello-world-view`
into `shard-manager/src/leanLsp.ts`:
`lake serve` spawned under bwrap on a lease of the project's shared `ProjectMountHandle`,
a `ws` server on a per-handle UDS bridging WebSocket frames
to `Content-Length`-framed JSON-RPC on the child's stdio,
one connection at a time with a new one displacing the old,
an idle timeout that disposes the handle and releases its mount lease,
and a global cap on concurrent `lake serve` processes.

Two simplifications over the proof of concept:
the shard manager is its own process, so the `Object.setPrototypeOf` rehydration
across HMR goes away and the counter lives in a module binding;
and `mounts.acquire` is already there to lease from.
`state.ts` gains `lspServers: Map<projectId, LeanLspHandle[]>`
next to `vscServers`.

Nothing reaches this yet, which is the point: it lands and is reviewed on its own.

### 5. Reaching the backend from the browser

- `shard-manager/src/manager.ts`: `ensureView`, `getViewSocketPath`, `killViewSession`,
  mirroring `ensureSession`, `getSocketPath`, `killSession`.
  `ensureView(viewer, owner, project, backends)` takes the backend list,
  so the registry decides what starts and the shard manager does not learn view ids.
- `ShardCoordinator`: `ensureView` and `viewSocketPathForViewer`.
- `nginx.conf.template`: an `/_lsp/<session_id>/` regex location
  copied from `/_vs/`, resolving its upstream through
  `auth_request_set $socket_path $upstream_http_x_socket_path`,
  plus the `location /_lsp/ { return 404; }` guard.
  No per-session nginx file, as with `/_vs/`.
- `src/app/api/auth-route/lsp/route.ts`: the `/_vs` gate with the URI pattern changed.

After this PR a websocket URL minted by hand reaches a live Lean.

### 6. The `hello` view

The first end-to-end live view, and the reusable browser client.

- `src/lib/leanLspClient.ts`: the proof of concept's `LeanLspSession`.
  JSON-RPC over the websocket, `initialize`, `didOpen`, `textDocument/hover`,
  diagnostics synchronization, and reconnect.
- The `live` facet's client contract, which every later view depends on:
  `Client` receives `{ config, backends: Record<BackendId, string>, data: Record<string, string> }`.
  `data` is empty until PR 7.
  The route in PR 3 grows its `live` branch: resolve access per `live.access`,
  call `ensureView` with `live.backends`, render `Client`.
- `hello` in `VIEWS`: `live` only, no `build`, no `publish`, client workbench-local.
  Owner opens `/alice/proj/view/hello`, types an identifier, sees its type.

### 7. Project data URLs

`live.projectData?(config): Record<string, string>` maps a prop name
to a project-relative directory.
The route mints one signed dir token per entry with `mintSignedDirToken`
and passes `/_file/<token>/` base URLs as the client's `data`.
One token per directory rather than one for the project tree,
so the capability names only what the view asked for.

A directory that does not exist yet fails `verifySignedDirToken`'s `realpath`
and the client sees a 403 on every fetch under it.
The route therefore reports the directory's absence to the client as such,
so a view can say "not built yet" instead of "forbidden".

### 8. Build without publishing

Split `startPublish` into `startViewBuild(owner, project, kind, plan)`,
which runs the script under bwrap as a tracked command and resolves,
and the existing `exit` listener work, which only attaches
when the view declares `publish` and the plan has a `siteDir`.
`publishTrackingKey` becomes `viewBuildKey`, so one build at a time
per project and view regardless of which facet asked for it.

A `live` view's route renders a rebuild control above its `Client`,
reusing `TrackedCommandForm` as `PublishCard` does.

### 9. Toy game view, part 1: gamedata

- `scripts/build-toy-game.sh`: `lake build`, then run the configured exe
  so it writes `game.json` into `.lake/toy-game/` in the project tree,
  then copy that directory into the staging directory for publication.
  The in-tree copy is what the live view reads; the staged copy is what publishing takes.
- The `toy-game` entry in `VIEWS`: `build` from `{ exe }`,
  `publish: { shape: 'data' }`, `live` with `backends: ['lean-lsp']`
  and `projectData` naming `.lake/toy-game/`.
- The client renders the level list from `game.json`, validated with Zod:
  each level a name, a Lean statement, and a hint. No Lean yet.
- An example project under `doc/examples/toy-game/`:
  a `lakefile.toml` with one exe target, about thirty lines of Lean
  emitting three levels, and a `workbench-publish.json`.
  Pasted into a project made from the basic template.
  Turning it into a project template belongs to the game plan's
  "Author's Loop" phase, not here.

### 10. Toy game view, part 2: play

The client sends the selected level's statement with the player's tactic block
as a document through the `lean-lsp` backend,
waits for diagnostics, and reports solved when there are
no errors and no `sorry`.
Reuses `leanLspClient.ts` from PR 6 for everything but the win condition.

**Milestone.** A project builds its own gamedata from Lean source,
a published copy of that gamedata is fetchable,
and a logged-in viewer plays the game against a live Lean process
with no VS Code and no external client package.

## Phase "Data Publications"

### 11. The `data` publication shape

Settle the two differences `VIEW-IMPLEMENTATIONS.md` lists.
`nginx-pub.conf.template` sets `Access-Control-Allow-Origin` per publication shape
rather than for the whole origin,
which means `/api/pub-route/resolve` reports the shape
and the location acts on it.
A directory request under a `data` publication answers deliberately
instead of 404ing on a missing `index.html`.

Verso is unaffected: `site` keeps exactly today's behavior.

## Phase "Operations"

### 12. Caps and visibility

A per-user cap on live backends alongside the global one from PR 4,
with the refusal reaching the client as a message rather than a bare socket close.
`listSessions` and the admin sessions page report live view sessions
next to editor sessions, with the view id and the backends each holds.

## Phase "Imported Client"

### 13. A client from npm

The blocks game client as a dependency, which the game plan's
"Shipped Package" phase produces.
Confirms that a route can hand a library everything environment-specific as props,
and that nothing in the registry or the route cares
where a `live` view's client came from.

## Phase "Written Down"

### 14. `doc/views.md`

The definition's fields, where a build script goes,
what a client library must look like to be importable,
and which backends exist.
