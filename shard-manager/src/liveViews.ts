import type { BackendId, BaseProject, BaseUser } from '@leanprover/workbench-shared'

import { LeanLspHandle } from './leanLsp.ts'
import { buildProjectMount } from './projectMount.ts'
import { lspServers, mounts } from './state.ts'

/** Browser URL of each backend that started, keyed by backend id. */
export type BackendUrls = Partial<Record<BackendId, string>>

/** Start the backends a live view of `project` needs, reusing `viewer`'s existing ones.
 * Assumes that `viewer` has permission to view `project`.
 *
 * The caller names the backends, so the view registry decides what runs
 * and the shard manager never learns which view asked. */
export async function ensureView(
  viewer: BaseUser,
  owner: { id: string; name: string },
  project: BaseProject,
  packageSets: string[],
  backends: BackendId[],
): Promise<BackendUrls> {
  const urls: BackendUrls = {}
  if (backends.includes('lean-lsp')) urls['lean-lsp'] = await ensureLeanLsp(viewer, owner, project, packageSets)
  return urls
}

/** The URL of `viewer`'s Lean LSP endpoint on `project`, starting one if they have none.
 *
 * The endpoint shares the editor's ref-counted {@link ProjectMountHandle},
 * so a live view and the editor run against a single mount. */
async function ensureLeanLsp(
  viewer: BaseUser,
  owner: { id: string; name: string },
  project: BaseProject,
  packageSets: string[],
): Promise<string> {
  const existing = (lspServers.get(project.id) ?? []).find(s => s.viewer.id === viewer.id && !s.isDisposing)
  if (existing) {
    await existing.started
    return existing.lspSocketUrl
  }

  await using stack = new AsyncDisposableStack()
  // Suffices to put `lsp` on the stack: everything else is added as a disposable to it.
  const lsp = stack.use(new LeanLspHandle(viewer, project))
  lsp.addDisposable(async () => {
    lspServers.set(
      project.id,
      (lspServers.get(project.id) ?? []).filter(s => s !== lsp),
    )
  })
  // Store before any `await` so that concurrent calls for the same viewer reuse this handle.
  lspServers.set(project.id, [...(lspServers.get(project.id) ?? []), lsp])

  const mountLease = await mounts.acquire(project.id, () => buildProjectMount(owner, project, packageSets))
  lsp.addDisposable(async () => mountLease[Symbol.asyncDispose]())

  lsp.start(mountLease.value.bindArgs)
  await lsp.started

  // Resources allocated successfully, dispose later when the endpoint actually exits.
  stack.move()
  return lsp.lspSocketUrl
}
