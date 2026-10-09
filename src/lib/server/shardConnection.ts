import 'server-only'

import type { ShardManagerAPIRouter } from '@leanprover/workbench-shard-manager'
import { type BackendId, SHARD_MANAGER_SOCK } from '@leanprover/workbench-shared'
import { createTRPCClient, httpLink } from '@trpc/client'
import { Pool } from 'undici'

import { type Project } from '@/prisma/generated/client'

import { type User } from './auth'
import { getDb } from './db'

export interface UnknownEditorSession {
  sessionId: string
  viewerId: string
  viewerUsername: string
  projectId: string
  createdAt: Date
}

/** Admin-visible information about a running editor session. */
export interface EditorSessionInfo {
  sessionId: string
  viewerId: string
  viewerUsername: string
  ownerUsername: string
  projectId: string
  projectName: string
  createdAt: Date
}

const dispatcher = new Pool('http://shard-connection-goes-over-uds/', { connect: { socketPath: SHARD_MANAGER_SOCK } })
const shardConnection = createTRPCClient<ShardManagerAPIRouter>({
  links: [
    httpLink({
      url: 'http://shard-connection-goes-over-uds/',
      fetch(url, init) {
        const options = { ...(init ?? {}), dispatcher }
        return fetch(url, options)
      },
    }),
  ],
})

/** Names of the package sets the project's mount must overlay. */
async function packageSetsOf(project: Project): Promise<string[]> {
  const rows = await getDb().projectPackageSet.findMany({ where: { projectId: project.id } })
  return rows.map(({ packageSet }) => packageSet)
}

export class ShardCoordinator {
  /**
   * Lease the project's shared {@link ProjectMountHandle}, building it if none exists.
   *
   * Publications use the same overlay mount as vscode sessions, and they can write to each
   * other's directories. Making this work correctly requires acquiring a lease from the
   * shard manager when we need to create a publication, and releasing it when we're done.
   * This can be somewhat simplified if and when publication-building is moved to shards.
   */
  async acquireProjectMount(owner: User, project: Project): Promise<AsyncDisposable & { readonly bindArgs: string[] }> {
    const { leaseId, bindArgs } = await shardConnection.acquireProjectMount.mutate({
      owner,
      project,
      packageSets: await packageSetsOf(project),
    })

    return {
      bindArgs,
      async [Symbol.asyncDispose]() {
        await shardConnection.releaseProjectMount.mutate({ leaseId })
      },
    }
  }

  /** Starts a session for `viewer` to read/edit `project` owned by `owner`,
   * reusing a current session if one already exists.
   * Assumes that `viewer` has permissions to view `project`.
   * Returns the path to the corresponding VSCode `iframe`. */
  async ensureSession(viewer: User, owner: User, project: Project): Promise<string> {
    const response = await shardConnection.ensureSession.mutate({
      viewer,
      owner,
      project,
      packageSets: await packageSetsOf(project),
    })
    return response.iframeUrl
  }

  async killSession(projectId: string, sessionId: string): Promise<void> {
    await shardConnection.killSession.mutate({ projectId, sessionId })
  }

  /** Start the backends a live view of `project` needs, reusing `viewer`'s existing ones.
   * Assumes that `viewer` has permission to view `project`.
   * Returns the browser URL of each backend that started. */
  async ensureView(
    viewer: User,
    owner: User,
    project: Project,
    backends: BackendId[],
  ): Promise<Partial<Record<BackendId, string>>> {
    const response = await shardConnection.ensureView.mutate({
      viewer,
      owner,
      project,
      packageSets: await packageSetsOf(project),
      backends,
    })
    return response.backends
  }

  async killViewSession(projectId: string, sessionId: string): Promise<void> {
    await shardConnection.killViewSession.mutate({ projectId, sessionId })
  }

  /** Return the path to `sessionId`'s VS Code UDS if `userId` is allowed to view it,
   * else `undefined`. */
  async socketPathForViewer(userId: string, sessionId: string): Promise<string | undefined> {
    const response = await shardConnection.getSocketPath.query({ sessionId })
    return response?.viewerId === userId ? response.socketPath : undefined
  }

  /** Return the path to live view session `sessionId`'s bridge UDS
   * if `userId` is allowed to view it, else `undefined`. */
  async viewSocketPathForViewer(userId: string, sessionId: string): Promise<string | undefined> {
    const response = await shardConnection.getViewSocketPath.query({ sessionId })
    return response?.viewerId === userId ? response.socketPath : undefined
  }

  async ensureHomeDirectory(user: User) {
    return shardConnection.ensureUserHomeDir.mutate(user)
  }

  async listSessions(): Promise<(EditorSessionInfo | UnknownEditorSession)[]> {
    const result: (EditorSessionInfo | UnknownEditorSession)[] = []
    const sessions = await shardConnection.listSessions.query()
    for (const { projectId, servers } of sessions) {
      const project = await getDb().project.findUnique({
        where: { id: projectId },
        select: { name: true, user: { select: { name: true } } },
      })
      if (!project) {
        console.error(`internal error: no database record for project with ID ${projectId}`)
      }
      for (const s of servers) {
        if (project) {
          result.push({
            sessionId: s.uuid,
            viewerId: s.viewer.id,
            viewerUsername: s.viewer.name,
            ownerUsername: project.user.name,
            projectId,
            projectName: project.name,
            createdAt: new Date(s.createdAt),
          })
        } else {
          result.push({
            sessionId: s.uuid,
            viewerId: s.viewer.id,
            viewerUsername: s.viewer.name,
            projectId,
            createdAt: new Date(s.createdAt),
          })
        }
      }
    }
    return result
  }
}

/* NB: if shardConnection gains any state that would need to survive HMR,
 * this object should be attached to globalThis */
const shardCoordinator = new ShardCoordinator()
export function getShardCoordinator(): ShardCoordinator {
  return shardCoordinator
}
