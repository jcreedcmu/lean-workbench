# Feature: Publish a Verso document

## Goal

Let the owner of a Lean project produce **publications**.
The first example will be a static website, built once from the project's current contents,
served anonymously from a **separate origin** at a stable URL.
Eventually this will generalize to websites that can interact with a language server
with access to the project's lean files.

The first (and initially only) kind of publishable artefact is a **Verso document**.
The design puts the artefact-kind-specific parts behind one small interface
so that a second kind (a Lean game, a slide deck) is an addition rather than a refactor.

## Shape of the thing

```
browser                    app origin (localhost:3000)                       sandbox
   |                              |                                             |
   |-- GET /u/p/publish --------> publish/page.tsx                              |
   |                              |  requireProjectOwner                        |
   |                              |  detectPublishable(projectDir)              |
   |<-- kind cards + Publish -----|                                             |
   |                              |                                             |
   |-- POST startPublish -------> startTrackedCommand('publish-<id>-verso')      |
   |                              |  bwrap ------------------------------------> lake build
   |<== SSE /api/tracked-command/<key> (live output) <--- pty <----------------- lake exe … --output /publish/out
   |                              |                                             |
   |                              |  on exit 0: swap staging -> publications/<pubId>
   |                              |             upsert Publication row
   |
   |-- GET pub.localhost:3000/alice/book/verso/ --> nginx --> resolve subrequest --> Publication
   |                                                   alias -> /data/publications/<pubId>/index.html
                                                       (no cookies, no session, no login)
```

The feature is: **run a build in a sandbox, keep its output, serve it statically.**
Everything below is detail on one of those three.

For the current example, the output is only HTML, but in the future it might include other kinds of data
(for example .json files for the data of lean games)
This probably won't matter too much since we'll mostly think of publication through the lens of filesystem
operations that transport all such files at once into the right place.

### Why this is smaller than `branch-hello-world-view`

`branch-hello-world-view` is a more speculative effort that we're deferring for now.

That branch's `plans/PUBLISH-ARTEFACTS.md` assumes every publication needs a live *view backend*:
a read-only overlay mount of a project snapshot,
a sandboxed process booted per visitor,
an nginx `auth_request` gate,
per-user concurrency caps and idle reaping,
and a second session/identity system on the publish origin.

A Verso document needs none of that.
Its build output is a directory of static files.
Once the files exist, serving them is `alias` in nginx,
and there is nothing to authenticate because the content is public by construction.

We keep from that plan the decisions that still apply
(snapshot semantics, cross-origin serving, resolution by unique id)
and drop the machinery that only server-interactive artefacts need.
The interactive case is not designed here; it can be added later
as an artefact kind that declares itself interactive,
without disturbing the static path.

## Eligibility: `workbench-publish.json`

A project is publishable as kind *K* iff its root holds a `workbench-publish.json`
whose top level is a JSON object with *K* as a key.

```json
{
  "verso": { "genre": "manual", "exe": "generate-book" }
}
```

The file is a map from artefact kind to that kind's configuration,
so one project can declare several publishable artefacts,
and an unrecognised key is ignored rather than being an error
(a project may be shared with a workbench that has more kinds registered than this one).

The manifest states *what the artefact is*, not specifically *how to build it*.
It's meant to be as declarative as reasonably possible,
although it might contain configuration data in the future.
`genre` is the Verso document type. `exe` is the Lake executable target that generates it.
Everything else is the framework's business:

| Question | Answered by |
|---|---|
| Which executable generates the document? | `exe` |
| Where does the generator write? | `--output`, a directory the workbench chooses |
| Which subdirectory of that is the site? | the genre (`manual` -> `html-multi`, `blog` -> `.`) |
| Where does the site end up being served? | the workbench |

`exe` is deliberately redundant with the lakefile. The alternatives are all worse.
Lake cannot be asked: `lake query` requires the caller to name the targets, target syntax
has no wildcard, and no command lists a package's executables. Parsing the lakefile is
unreliable, since `lakefile.lean` is arbitrary Lean code. Observing which binary appears in
`.lake/build/bin/` after a build makes publication depend on a directory happening to hold
exactly one entry, which stale binaries from a renamed target, or a second executable added
later, would quietly break. A name the author already chose, restated in a format that is
always parseable, is worth the duplication.

### The artefact-kind interface

`src/lib/server/artefacts.ts`

```ts
/** How to build one kind of publishable artefact. */
interface ArtefactKind<Config = unknown> {
  /** Key under which this kind appears in `workbench-publish.json`. */
  readonly id: string
  readonly displayName: string
  /** Validates this kind's entry in the manifest. */
  readonly zConfig: z.ZodType<Config>
  /** How to build an artefact declared by this config. */
  plan(config: Config): BuildPlan
}

interface BuildPlan {
  /** Script under `scripts/`, run inside the sandbox with the project as its cwd.
   * Receives the staging directory as `$1`. */
  script: string
  /** Further arguments, after the staging directory. */
  args: string[]
  /** Directory, relative to the staging directory, that becomes the published site. */
  siteDir: string
}

const ARTEFACT_KINDS: ArtefactKind[] = [versoKind]

/** Kinds this project declares, with their parsed configs,
 * plus per-kind parse errors to show the owner. */
function detectPublishable(projectDir: string): Promise<DetectedArtefact[]>
```

`versoKind` parses `{ genre: 'manual' | 'blog', exe: string }` and plans

```ts
{ script: 'publish-verso.sh', args: [config.exe],
  siteDir: config.genre === 'manual' ? 'html-multi' : '.' }
```

`exe` is validated against the same shape Lake accepts for a target name,
so it cannot smuggle shell metacharacters or path separators into the build command.

A new artefact kind is a new `ArtefactKind` and a new script.
Detection, sandboxing, streaming, staging, and serving are shared and untouched.

A malformed manifest is something the owner can fix,
so it is rendered on the publish page as an error message rather than thrown to a boundary.

### Why the genre is declared rather than inferred

Both Verso genres accept `--output DIR`,
so the workbench could pass one directory and afterwards probe for `DIR/html-multi`.
Declaring the genre is preferable because
the publish page can label and describe the artefact before any build has ever run,
and because a build that produces an unexpected layout should be an error, not a guess.

## Building

`src/lib/server/publish.ts`, `scripts/publish-verso.sh`

The build is a tracked command (`src/lib/server/trackedCommand.ts`)
whose child process is `bwrap`, so its output streams to the browser over SSE
through the existing `SimpleTTY` / `TrackedCommandForm` pair.
Tracking key: `publish-<projectId>-<kind>`, which satisfies the key's URL-safety check
and makes "one build at a time per project and kind" fall out of
`startTrackedCommand` returning `null` when the key is busy.

### The sandbox

Same shape as `VscodeServerHandle.start`, minus the editor:

- `BWRAP_ARGS`
- `--ro-bind` the elan directory at its own path; `ELAN_HOME` and `PATH` set to it
- `--bind` the owner's home directory at `bwrapHomeDir(owner.name)`, with `HOME` set;
  `lake` needs a writable home for its caches
- the `GIT_CONFIG_*` `safe.directory` trio, for the same reason VS Code needs it:
  the overlay mount makes `lake`'s dependency clones look dubiously owned
- `--ro-bind` the repo's `scripts/` at a fixed sandbox path
- `--bind` the staging directory at `/publish/out`
- the project bind args, and `--chdir` into the project

Network is **not** unshared, as elsewhere in the codebase,
which is what lets `lake build` fetch Verso the first time.

The project mount **must** be acquired from `EditorSessionManager`'s existing
`RcMap` of `ProjectMountHandle`s, not built independently:
`buildProjectMount` mounts the overlay at a fixed per-project path
with the project directory as the writable upper layer,
so a second independent mount of a project that already has an editor open
would stack overlays on one upper layer.
This adds one method:

```ts
class EditorSessionManager {
  /** Lease the shared overlay mount for `project`, building it if necessary. */
  async acquireProjectMount(owner: User, project: Project): Promise<Lease<ProjectMountHandle>>
}
```

The lease is released when the build process exits, whatever the exit status.

`--die-with-parent` is in `BWRAP_ARGS`, so a Next.js restart kills an in-flight build.
In dev that means HMR can interrupt a long build; the owner reruns it.

### `scripts/publish-verso.sh OUT_DIR EXE`

```
[[ progress 1/2 Building Lean project ]]
lake --no-ansi --keep-toolchain build
[[ progress 2/2 Generating document ]]
lake --no-ansi exe "$EXE" --output "$OUT_DIR"
```

`lake exe` fails on its own, with a message naming the target, when `exe` does not match
anything the project builds. That is the error an author sees after renaming the target in
their lakefile without updating the manifest, and it says enough to act on.
The `[[ progress i/n name ]]` lines are the convention `SimpleTTY` already parses into a progress bar.

### Staging and the swap

Publications live at `<data>/publications/<pubId>/`, added to `shared/node/directories.ts`
as `getPublicationsDir()`.

The staging directory is `<data>/publications/.staging/<projectId>-<kind>/`,
created empty by the server before the build and bound into the sandbox.
It is named after the project rather than the publication
because a publication id is only minted once a build has succeeded.

On exit status 0 the server, outside the sandbox:

1. renames the live directory (if any) aside,
2. renames `staging/<siteDir>` into place as `publications/<pubId>/`,
3. deletes the aside directory and whatever else the build left in staging,
4. upserts the `Publication` row.

On any other exit status it deletes the staging directory and leaves any existing
publication exactly as it was. This all happens in an `exit` listener on the tracked
command's emitter, so it does not depend on a browser still watching.

There is a brief window during the swap in which the URL 404s.
Making that window disappear would mean pointing at build-numbered directories
and resolving the pointer per request, which would put a database lookup in front of
every static asset. Not worth it.

A global cap on concurrent publish builds
(`MAX_CONCURRENT_PUBLISH_BUILDS`) bounds the cost of many owners
publishing at once; over the cap, the server action reports "the
server has reached the limit of how many publication builds can be
active at the same time, try again later" as an `ActionResponse`
error.

## Serving

### Data model

```prisma
model Publication {
  /// UUID; the publication's durable identity, and its directory under `publications/`.
  id        String   @id
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  projectId String
  /// Artefact kind, matching a key in the project's `workbench-publish.json`.
  kind      String
  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt

  @@unique([projectId, kind])
  @@map("publication")
}
```

Republishing reuses the row, so a publication's durable URL never changes.
Today there is one publication per project and kind and no version history,
which is what `@@unique([projectId, kind])` states.

The id stays distinct from the project id because versioned publications are a likely
future. A version is a publication in its own right: its own build, its own directory, its
own durable URL, with the readable URL naming whichever one is current. Lifting the
restriction later means dropping that unique constraint and adding a "current" pointer,
and changes nothing about how a publication is identified, built, stored, or served.

**A publication is live exactly while its row exists.** Every request resolves through the
database (below), so unpublishing is a row deletion and removing the directory is cleanup.
`deleteProject` cascades to the rows, so a deleted project stops serving even though its
project files are kept; the same action removes its directories.

### URLs

Two shapes, both on the publish origin, both serving the same bytes:

```
http://pub.localhost:3000/alice/basic-book/verso/…     readable
http://pub.localhost:3000/_pub/<pubId>/…               durable
```

The readable URL resolves `(owner name, project name, kind)` to whichever publication is
current. It is what the app links to and what stays in the visitor's address bar. It is
**not** a redirect: it serves the publication's files directly, as `PUBLISH-ARTEFACTS.md`
decision 4 anticipated.

The durable URL names one publication. It survives a user or project rename, and once
versions exist it is how a specific version is addressed. The `_pub` prefix is reserved
rather than pretty because a user could otherwise be named `p`, which would make
`/p/alice/verso` ambiguous between the two shapes; `_` cannot start a user name.

On the **app** origin, `/[userName]/[projectName]/[kind]` is a 302 to the readable publish
URL, so a link built in the app's own address space lands on the right origin. Next.js
matches static segments before dynamic ones, so `publish` (and later `edit`) stay siblings
of the `[kind]` catch-all.

### Resolution

Neither shape can be a plain `alias`: the directory is named by publication id, and the
slug does not appear in the filesystem at all. Both go through the `auth_request`
subrequest pattern that `/_file/` already uses.

`/api/pub-route/resolve` reads `X-Auth-URI`, accepts either shape, and answers 200 with
`X-Publication-Dir`, or 404. It **must not** call `requireAuth`: publications are public
and the publish origin carries no cookies. It is an `internal` nginx location, so a browser
cannot reach it directly.

Resolving on the leading segments only, rather than on the whole URI, lets nginx append the
remaining path itself and lets the cache hold one verdict per publication instead of one
per asset. The cost of this arrangement is that publications stop serving when Next.js is
down, where a bare `alias` would have kept working.

Nginx gains a second `server` block, and the app's block becomes `default_server`:

```nginx
server {                       # app: unchanged, now explicitly the default
    listen 3000 default_server;
    server_name localhost;
    …
}

server {                       # publications: static files, nothing else
    listen 3000;
    server_name $PUB_HOST;

    # /_pub/<pubId>/… or /<owner>/<project>/<kind>/…
    # The /_pub branch must come first; PCRE takes the leftmost alternative that matches.
    location ~ ^(?<pub_ref>/_pub/[^/]+|/[^/]+/[^/]+/[^/]+)(?<pub_rest>/.*)?$ {
        if ($pub_rest = '') { return 301 $uri/; }
        rewrite ^(.+)/$ $1/index.html last;

        set $auth_route_uri $pub_ref;
        set $auth_route_cache_key $pub_ref;
        auth_request /api/pub-route/resolve;
        auth_request_set $pub_dir $upstream_http_x_publication_dir;

        alias $pub_dir$pub_rest;
        disable_symlinks on;          # the files came out of a sandbox
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin always;
    }

    location ^~ /api/pub-route/ {     # subrequest target, same shape as /api/auth-route/
        internal;
        proxy_pass http://127.0.0.1:3002;
        proxy_pass_request_body off;
        proxy_set_header X-Auth-URI $auth_route_uri;
        proxy_cache auth_route_cache;
        proxy_cache_key $auth_route_cache_key;
        proxy_cache_valid 200 10m;
    }

    location / { return 404; }        # the app is not reachable on this origin
}
```

`$PUB_HOST` is filled by the `envsubst` step in `start.sh` that already templates the
nginx config.

Verso's Manual genre emits page-relative links
(`VersoManual/Html.lean` builds a `relativeRoot` of `./` and `../` segments),
so a manual serves correctly under either prefix.
The Blog genre builds paths from a site root and may emit root-absolute links;
if that breaks under a prefix, the fix is the growth path below,
not a change to any of the above.

`Content-Security-Policy: sandbox` is deliberately **not** set here,
unlike on `/_file/`. An opaque origin would break the document's own `fetch` of its
search index and data files. Isolation comes from the separate origin instead.

The residual risk that leaves is publication-to-publication:
all publications share one origin, so one document's scripts can reach another's
`localStorage` and set cookies the other will see. For public static documents that is
tolerable. Serving each publication from `<pubId>.pub.<host>` closes it, and would also
make root-absolute links work; that needs wildcard DNS and a wildcard certificate in
production, so it is left as the growth path. The durable URL already names publications
by id, so that move is a change of separator.

### Configuration

One environment variable, `WORKBENCH_PUB_BASE_URL`, defaulted in `start.sh` and exported
so that nginx and Next.js cannot disagree about it:

```bash
WORKBENCH_PUB_BASE_URL="${WORKBENCH_PUB_BASE_URL:-http://pub.localhost:3000}"
PUB_HOST="${WORKBENCH_PUB_BASE_URL#*://}"; PUB_HOST="${PUB_HOST%%/*}"; PUB_HOST="${PUB_HOST%%:*}"
```

It is deployment infrastructure rather than an admin-editable preference,
so it belongs in the environment and not in `config.json`.
`install.sh` should pass it through to the generated compose file.

### Testing origin separation locally

Chrome and Firefox both resolve any `*.localhost` name to loopback with no DNS and no
`/etc/hosts` entry, and the container already publishes port 3000 on 127.0.0.1.
So the dev default works out of the box:

1. Log in at `http://localhost:3000` and publish a document.
2. Open `http://pub.localhost:3000/alice/basic-book/verso/`. It renders while logged out,
   and in another browser entirely, as does its `/_pub/<pubId>/` form.
3. In devtools, confirm no better-auth session cookie is sent to `pub.localhost`.
   This holds because better-auth's cookies are host-only; assert that, because a cookie
   set with `Domain=localhost` *would* reach `pub.localhost` and that would be a cookie
   attribute bug rather than a failure of this design.
4. `http://pub.localhost:3000/`, `http://pub.localhost:3000/api/auth/session`, and
   `http://pub.localhost:3000/api/pub-route/resolve` all 404.
5. `http://localhost:3000/alice/basic-book/verso` 302s to the publish origin.

What this does **not** prove: whether the browser treats `localhost` and `pub.localhost`
as cross-*site* depends on whether `localhost` counts as a public suffix, so `SameSite`
behaviour here is not necessarily production behaviour. Production should put the publish
origin on a distinct registrable domain, which is exactly what the environment variable is for.

## Access control and the tracked-command route

Publishing is an owner-only action:
`requireProjectOwner(userName, projectName)` in `src/lib/server/util.ts`
resolves viewer, owner, and project, interrupting with 404 when the viewer is not the
owner, so the route does not leak the existence of other people's projects.

The tracked-command SSE route is admin-only today
(`/api/admin/tracked-command/[key]`, `requireAdmin()`),
and `TrackedCommandForm` hardcodes that path and imports its two probe actions from
`@/app/admin/actions`. Publishing needs the same machinery for a non-admin user, so:

- `TrackedCommandState` gains an owner, recorded by `startTrackedCommand`:
  `{ kind: 'admin' } | { kind: 'user', userId: string }`.
  Plain data, not a closure, so it survives HMR alongside the rest of the state in `globalThis`.
- The route moves to `/api/tracked-command/[key]` and authorises against that owner:
  admins pass everything, a user passes their own commands.
- `isTrackedCommandRunning` / `isTrackedCommandAvailable` move out of `@/app/admin/actions`
  into a non-admin module and apply the same check.
- `SimpleTTY` uses the new path.

Existing admin callers pass `{ kind: 'admin' }` and are otherwise unchanged.

## User interface

`src/app/[userName]/[projectName]/publish/page.tsx` — a Server Component, owner-only,
which calls `await connection()` before touching server state
(it reads the project directory, so it must not run during prerendering or `<Link>` prefetch).

It renders one card per kind the manifest declares:

- the kind's display name and config summary,
- the publication's URL and last-published time, if it has one,
- a `TrackedCommandForm` wired to `startPublish`, with `initiallyWatchingTTY` so that
  reopening the page during a build rejoins the running build's output,
  and `successAction` refreshing the route so the new URL appears,
- an Unpublish button once a publication exists.

If the manifest is missing, the page explains what `workbench-publish.json` is and shows
the example. If it is malformed, it says so.

`ProjectRow` gains a Publish link to that route. It does not try to determine eligibility,
since that would mean reading every project's directory to render the project list.

Publishing does not change the project's own visibility: a private project can have a
public publication, and the page says so plainly next to the button.

## Implementation plan

Each step builds and lints on its own.

1. `chore: serve tracked command output to non-admin owners` —
   owner on `TrackedCommandState`, route move, `SimpleTTY` path, probe actions relocated.
   No new behaviour.
2. `refactor: share the project mount with non-editor sandboxes` —
   `EditorSessionManager.acquireProjectMount`, plus `requireProjectOwner` in `util.ts`.
3. `feat: publishable artefact kinds` —
   `workbench-publish.json`, `ArtefactKind`, `detectPublishable`, the Verso kind.
   Pure detection; nothing runs yet.
4. `feat: build a publication in a sandbox` —
   `scripts/publish-verso.sh`, the bwrap invocation, staging and the swap,
   the `Publication` model and its migration, `getPublicationsDir()`,
   publication deletion wired into `deleteProject`.
5. `feat: serve publications from a separate origin` —
   the nginx server block, `/api/pub-route/resolve`, `WORKBENCH_PUB_BASE_URL` in
   `start.sh` and `install.sh`.
6. `feat: publish page` — the route, the cards, the `ProjectRow` link,
   and the app-origin `[kind]` redirect.
7. `doc: publishing` — `doc/DEVELOPMENT.md` gains the data-volume entry for
   `publications/`, the origin-separation test, and the manifest format.

## Acceptance

1. A project whose root has `{"verso":{"genre":"manual"}}` shows a Publish action;
   one without the file explains what is missing.
2. Publishing streams `lake build` and generator output live, with a progress bar,
   and survives closing and reopening the page mid-build.
3. On success the page shows `pub.localhost/alice/basic-book/verso/`, which renders the
   book anonymously in a browser that has never authenticated, keeps that URL in the
   address bar, and serves the same bytes as its `/_pub/<pubId>/` form.
4. Republishing replaces the content at both URLs.
5. Unpublishing, and deleting the project, both stop serving; renaming the user or the
   project moves the readable URL and leaves the durable one alone.
6. No app session cookie is sent to the publish origin, and the app is not reachable there.
7. Publishing while the project's editor is open uses the one existing overlay mount,
   and releasing the build's lease leaves the editor's mount alone.

## Open questions

- Orphaned publication directories: a directory whose row is gone is dead weight rather
  than exposure, since resolution is by row. Nothing sweeps for them yet.
- Retention of a publication when its project is deleted. Cascade-and-delete is chosen here
  because it is what "unpublish" already has to do; keeping history would need an owner for
  the files after the project is gone.
