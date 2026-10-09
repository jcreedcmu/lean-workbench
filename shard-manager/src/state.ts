import type { CollabServerHandle } from './collabServer.ts'
import type { LeanLspHandle } from './leanLsp.ts'
import type { ProjectMountHandle } from './projectMount.ts'
import { RcMap } from './rcMap.ts'
import type { VscodeServerHandle } from './vscodeServer.ts'

/** projectId ↦ shared {@link ProjectMountHandle}
 *
 * Exactly one of these should exist per open project.
 * Leased by the project's collab-server,
 * by every VS Code server editing the project,
 * and by every live view's backend reading it. */
export const mounts = new RcMap<string, ProjectMountHandle>()

/** projectId ↦ shared {@link CollabServerHandle}
 *
 * Exactly one of these should exist per open project.
 * Leased by every VS Code server editing the project. */
export const collabServers = new RcMap<string, CollabServerHandle>()

/** projectId ↦ [{@link VscodeServerHandle}s editing that project]
 *
 * Invariant: only contains *usable* servers,
 * that is ones which haven't been signaled to shut down or crashed.
 * Servers are removed immediately from this map when shutdown begins,
 * and resources are cleaned up afterwards. */
export const vscServers = new Map<string, VscodeServerHandle[]>()

/** projectId ↦ [{@link LeanLspHandle}s serving live views of that project]
 *
 * A live view boots a bare `lake serve` in place of a whole editor.
 * Like {@link vscServers}, entries are removed as soon as shutdown begins. */
export const lspServers = new Map<string, LeanLspHandle[]>()
