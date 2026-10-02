# Feature: View Implementations

status: proposed

## Goal

Make "view" the single concept covering every way of presenting a
project: a statically built document served from the publish origin, a
live server-backed interface served from the app origin, or something
that is both. Today the only view mechanism is publishing, and it handles
only the static case.

Every view is **implemented in the workbench**. Adding one is a workbench
change: a new entry in a registry that is a compiled-in array. There is
no installing a view into a running instance.

Most of a view's JavaScript may still live outside this repository. A
view's browser client is allowed to be an npm dependency, developed and
released on its own schedule, which the workbench imports. That is the
modularity worth having now, and it needs no loading machinery, no
plugin contract, and no new admin surface.

## What exists today

Publishing is the only view mechanism, and it is closed:

- `ArtifactKind<Config>` in `src/lib/server/artifacts.ts` carries an
  `id`, `displayName`, a Zod validator for the view's entry in the
  project's declaration, a `plan(config): BuildPlan`, and a
  `describe(config)`. `ARTIFACT_KINDS` holds exactly one entry,
  `versoKind`.
- A project declares what it publishes in `workbench-publish.json`,
  mapping view id to that view's configuration.
- `startPublish` runs `BuildPlan.script` (a file under the workbench's
  `scripts/`) under bwrap, with the project as cwd and a staging
  directory bound at `/publish/out`. `finishPublish` moves
  `BuildPlan.siteDir` into `getPublicationDir(id)`.
- Publications are served anonymously from the publish origin:
  nginx resolves the directory through `/api/pub-route/resolve`.
- `/[userName]/[projectName]/[kind]` exists but only redirects to the
  publish origin.

Live views are designed in `plans/HELLO-VIEW.md` and proved out on
`branch-hello-world-view`, against the pre-shard-manager base. Nothing
is on main.

`plans/PUBLISH-ARTEFACTS.md` is older than what shipped and partly
overtaken by it. It assumes publishing snapshots the project and serves
each publication from a read-only mount, because it anticipated
publishing views that need a Lean process behind them. What shipped
snapshots the build output instead, and serves it as static files with no
mount and no process. Read that document for its reasoning about origins,
cookies, and durable URLs, not for its data model.

Mechanisms a view relies on without reinventing: tracked commands with
streamed output, the `/_file/<dirToken>/` route for serving project
files, and the `/_vs/<sessionId>/` nginx location that resolves its
upstream socket from an `auth_request` response header, so a new session
kind needs no per-session nginx configuration.

Project templates (`getTemplatesDir()`) and package sets
(`getPackageSetsDir()`, mounted as read-only overlay lowers by
`buildProjectMount`) are adjacent but stay separate: they shape the
projects a view presents, and are not part of a view's implementation.

## The view concept

A view is identified by a string id and declares what it needs.

| Capability | Values | `verso` | `hello` | blocks game |
|---|---|---|---|---|
| build | a sandboxed command, or none | `publish-verso.sh` | none | `lake build` |
| artifact | what the build produces | an HTML site | none | gamedata JSON |
| publish | `site`, `data`, or not publishable | site | no | data |
| live | an app-origin route, or none | no | yes | yes |
| backends | `lean-lsp`, `collab`, or none | none | `lean-lsp` | `lean-lsp` |
| client | an npm dependency, or workbench-local | none | local | npm |
| project data | which project paths the client may read | none | one file's text | `.lake/gamedata/` |
| access | publications are public; live routes need an account | public | viewer | viewer |

Publishing and live serving are independent facets, and a view needs at
least one. `verso` publishes and has no live route. `hello` has a live
route and nothing to publish. A game has both: its build writes gamedata
into the project tree, a live route plays against that tree through a
Lean session, and the same gamedata can be published for other code to
fetch.

**A live view always requires an account.** A live view gives the visitor
a Lean process, and a Lean process is expensive enough that handing one
to unauthenticated traffic is a denial-of-service risk we decline to
take. Accounts are what make that cost attributable and limitable. So the
two facets differ in who can reach them, and not by configuration:
publications are public files anyone may fetch, while a live route
requires a logged-in user who can access the project, with `live.access`
choosing only between the owner and anyone the project is visible to.

There is therefore no anonymous live view, and the design does not
represent one. Sharing a live view means the other person needs an
account on the instance. A view that wants to reach a wider audience
publishes an artifact instead, which is what the `data` shape is for: the
expensive part stays behind an account and the result does not.

**Views are not grouped.** Two presentations of similar material are two
views, even when they are close cousins. The classic and blocks Lean game
clients are separate views: they differ in everything the workbench can
see, and what they have in common is an upstream Lean library and an
upstream gamedata format the workbench never parses. Shared code is
shared upstream, through a Lake dependency or an npm dependency. Nothing
in the design offers a way to group views, and nothing should.

**One view or several?** Variation that an author picks between belongs
in a view's config; variation an author wants *both of at once* has to be
separate views. The constraint is mechanical: a project's view
declaration is a map keyed by view id, and `Publication` is unique on
`(projectId, kind)`, so one project gets at most one configuration and at
most one publication per view. Verso's genres are therefore config, since
a project publishes one Verso document. Classic and blocks games are
separate views, since a project should be able to offer both at once, at
two URLs.

A view contributes no Lean code. A view that expects the projects it
presents to depend on a Lean library, such as a game framework with its
own `@[server_rpc_method]` extensions, is describing a property of those
*projects*. Lean dependencies of a project are what templates and
package sets are for.

## Interfaces

### The registry

`ARTIFACT_KINDS` becomes `VIEWS`, still a compiled-in array, holding
`ViewDefinition`s that generalize today's `ArtifactKind`:

```ts
interface ViewDefinition<Config> {
  id: string
  displayName: string
  /** Validates this view's entry in the project's view declaration. */
  zConfig: z.ZodType<Config>
  /** One-line summary of the declared view, shown to the project's owner. */
  describe(config: Config): string
  /** How to build this view's artifact; absent for a view that builds nothing.
   *  `BuildPlan.siteDir` names the part of the staging directory that is the
   *  artifact, as it does today. */
  build?(config: Config): BuildPlan
  /** What the artifact becomes at the publish origin, if anything.
   *  Publications are public. */
  publish?: { shape: 'site' | 'data' }
  /** The app-origin route, if any. A live view always requires an
   *  account; `access` only decides whether `isPublic` is enough. */
  live?: {
    backends: BackendId[]
    Client: ViewClientComponent
    access: 'owner' | 'viewer'
  }
}
```

At least one of `publish` and `live` is present. A definition is ordinary
workbench code and may import whatever it needs from `@/lib/server`.

`BuildPlan.script` keeps naming a file under the workbench's `scripts/`,
as `publish-verso.sh` does; a script may invoke a CLI that arrives as an
npm dependency. `build` is a function of the config, so it may select
among several scripts, not only vary their arguments. That is what lets
one view cover build paths that differ more than a flag: Verso's config
can become a discriminated union over genre and literate mode, with
`build` dispatching to whichever script each needs and `siteDir`
following from it.

For a live view, `Client` is the React component the route renders, and
the definition supplies the props it needs: the backend URLs the route
was given and any project-data URLs minted through
`/_file/<dirToken>/`. A live view with a `build` reads its own artifact
out of the project tree through those URLs, with no publication
involved, which means it shows the last build rather than the current
source. That is the right default for an author iterating, and it makes
a visible "rebuild" action part of such a view's interface.

### Definitions

- A **view** is a way of presenting a project. A project declares
  which views it supports. A URL route requests a particular view.
- A **build** is a (most likely sandboxed) command that produces an **artifact**.
- An **artifact** is data that can be used to render a view. Some views
  require artifacts to render their view, and some may not.
- A **publication** is particular kind of artifact that can be
  immediately served as html.

Not all artifacts are publications. For example, a game's artifact is
a json blob that summarizes all of the game data JSON. When a user
plays the game, this data is read from the project tree

This is why `ArtifactKind` is the name to retire rather than the word
"artifact": today's `ArtifactKind` is a kind of *view*, while the
artifact is what its build produces. The renames are
`src/lib/server/artifacts.ts` to `views.ts`, `ArtifactKind` to
`ViewDefinition`, `ARTIFACT_KINDS` to `VIEWS`, `DetectedArtifact` to
`DeclaredView`, `detectArtifact` to `detectView`,
`PublishManifest.artifacts` to `.views`, and the owner-facing
`"does not declare a '<kind>' artifact"` to `"... view"`. `BuildPlan`,
`siteDir`, and anything naming build output keep the word.

### Serving a data artifact

A `site` publication is what the publish origin does today: directory
requests rewrite to `index.html`, symlinks are refused, and
`X-Content-Type-Options: nosniff` is set.

A `data` publication is fetched by code rather than visited. Two
differences from `site` to settle when the first one ships:

- **CORS.** `nginx-pub.conf.template` sets no
  `Access-Control-Allow-Origin`, so a data publication cannot be fetched
  by JavaScript from another origin today. Decide whether `data`
  publications are world-fetchable, and set the header per publication
  shape rather than for the whole origin.
- **No index rewriting.** The existing `rewrite ^(.+)/$ $1/index.html`
  only fires on directory requests, so it is harmless for file fetches,
  but a `data` publication should answer a directory request with
  something deliberate rather than a 404 from a missing `index.html`.

**Anonymous live views are deliberately not representable.** A live
route hands the visitor a Lean process, so it requires an account to
avoid resource exhaustion by untrusted anonymous users.

### A view's client as an npm dependency

A live view's client is imported, not served from a separate bundle:

```ts
import { BlocksGame } from '@leanprover/lean-blocks-client'
```

Turbopack bundles it with the rest of the app's client code, so there is
no asset route to write and no versioned URL path. This is the ordinary
way an application consumes a React component library, and it asks
nothing unusual of the library:

- Ship ESM as a library build, with `react` and `react-dom` as
  `peerDependencies`.
- Mark the entry `'use client'`, or let the workbench wrap it in a thin
  client component, since the route rendering it is a Server Component.
- Import its own CSS, fonts, and other assets from its own modules, so
  the bundler resolves and emits them.
- Take everything environment-specific as props. A client that reads
  `window.location` to find its backend, or assumes a base path, cannot
  be mounted by a route that decides those.

Only the last of these is particular to this design; the rest is what
publishing any React library involves. The work is in the conversion: the
blocks client is an application today, with an `index.html` and a
`build.outDir` of `client/dist`, so it has to become a library build. The
Lean game authoring plan's "Shipped Package" phase owns that.

### Routing

Views move to `/[userName]/[projectName]/view/[kind]`, so dispatching to
a view is clearly separated from the project's own routes and from
`publish/` and `preview/`. The route resolves the view in the registry,
then: a view with a `live` facet resolves access, starts the declared
backends, and renders the view's `Client`; a publish-only view redirects
to the publish origin as today.

The publish origin keeps its current URL shape,
`<pubBaseUrl>/<owner>/<project>/<kind>/`, since nothing is dispatched
there and every path under it is a publication. The app route and the
publication URL therefore no longer mirror each other; adding `/view/`
to the publish origin for symmetry would break existing published links,
so it is deliberately not proposed.

### Division of ownership

Three workbench concepts meet around a view, and each keeps one owner.

- **Package sets and templates belong to the project.** They exist to
  give a user's project prebuilt Lean dependencies and a starting tree.
  An administrator who wants a project shaped for a given view makes a
  template the existing way, including `create-gitrepo.sh`, which builds
  a package set and a template together from an arbitrary repository.
- **Build scripts belong to the view.** How to turn a project into this
  view's artifacts is view-specific, the way `publish-verso.sh` is.
- **Backends belong to the workbench.** `lean-lsp`, `collab`, and the
  editor are workbench-owned processes that a view selects among.

## Phases

### Phase "One Registry"

Turn `ArtifactKind` into `ViewDefinition` with the capability fields
above, and `ARTIFACT_KINDS` into `VIEWS`. `verso` remains the only view,
`publish: { shape: 'site' }` the only facet in use, and nothing
observable changes.
`detectPublishable` and the publish page read the registry. The point is
to prove the shape against the view that already works in production.

### Phase "Separate Route"

Move the view route to `/[userName]/[projectName]/view/[kind]` and have
it dispatch on which facets the view has: a `live` view renders, a
publish-only view redirects to the publish origin. Still only `verso`,
so the change is purely in routing.

### Phase "Live Mode"

Forward-port `plans/HELLO-VIEW.md` onto the shard-manager architecture as
the `lean-lsp` backend: a handle that runs `lake serve` under bwrap on
the shared `ProjectMountHandle`, bridges a websocket to its stdio over a
Unix socket, and is reached through an `/_lsp/<sessionId>/` nginx
location mirroring `/_vs/`. Add the `live` facet and ship
`hello` as the first live view, with its client workbench-local. This is
the phase the Lean game authoring plan's "Workbench Seat" depends on.

### Phase "Imported Client"

A live view whose client is an npm dependency, which confirms that a
route can hand a library everything environment-specific as props. The
blocks game client is the first case, and the Lean game authoring plan's
"Shipped Package" phase produces it.

### Phase "Written Down"

A short guide for adding a view: the definition's fields, where the build
script goes, what a client library must look like to be importable, and
which backends exist.
