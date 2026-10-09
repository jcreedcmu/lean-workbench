import 'server-only'

import fs from 'node:fs/promises'
import path from 'node:path'

import { bwrapProjectDir } from '@leanprover/workbench-shared'
import {
  BWRAP_ARGS,
  bwrapHomeDir,
  getElanDir,
  getScriptsDir,
  makeTempBuildDir,
} from '@leanprover/workbench-shared/node'

import { type User } from '@/lib/server/auth'
import { getConfig } from '@/lib/server/config'
import { getDb } from '@/lib/server/db'
import {
  countRunningTrackedCommands,
  getUserTrackedCommandState,
  startTrackedCommand,
} from '@/lib/server/trackedCommand'
import { type ActionResponse } from '@/lib/util'
import { type Project } from '@/prisma/generated/client'

import { finishPublish } from './publish'
import { getShardCoordinator } from './shardConnection'
import { type BuildPlan, VIEWS } from './views'

const VIEW_BUILD_KEY_PREFIX = 'view-build-'

/** Tracking key of a project's build of one view.
 * One build at a time per project and view, whichever facet asked for it,
 * falls out of `startTrackedCommand` refusing a key that is already running. */
export function viewBuildKey(projectId: string, kind: string): string {
  return `${VIEW_BUILD_KEY_PREFIX}${projectId}-${kind}`
}

/** Where the sandbox sees the workbench's scripts. */
const SANDBOX_SCRIPTS_DIR = '/publish/scripts'
/** Where the sandbox sees the staging directory that the build writes into. */
const SANDBOX_OUT_DIR = '/publish/out'

/** Start a sandboxed build of one of `project`'s views,
 * streaming its output to `owner` under {@link viewBuildKey}.
 *
 * Resolves once the build has been started, not when it finishes.
 * A build whose view publishes has its output swapped into place by an `exit` listener,
 * so publishing completes whether or not a browser is still watching.
 * A build that only writes into the project tree, which is what a live view reads,
 * needs nothing further once the command exits. */
export async function startViewBuild(
  owner: User,
  project: Project,
  kind: string,
  plan: BuildPlan,
): Promise<ActionResponse<boolean>> {
  if (
    countRunningTrackedCommands(key => key.startsWith(VIEW_BUILD_KEY_PREFIX)) >= getConfig().maxConcurrentPublishBuilds
  ) {
    return {
      error:
        'The server has reached the limit of how many view builds can be active at the same time. Try again later.',
    }
  }

  const trackingKey = viewBuildKey(project.id, kind)
  // `startTrackedCommand` below is what actually claims the key.
  // Checking first only avoids building an overlay mount we would immediately tear down.
  if (getUserTrackedCommandState(owner, trackingKey)?.status === 'running') return { ok: false }

  const publishes = VIEWS.find(v => v.id === kind)?.publish !== undefined && plan.siteDir !== undefined

  // If there was a prior publication, the id of it, or `undefined`
  // otherwise. `finishPublish` will check for the prior publication.
  // If it's missing, we interpret this as the owner unpublished while
  // the build ran, and the output is discarded rather than reviving
  // the publication.
  const priorPub = publishes
    ? (await getDb().publication.findUnique({ where: { projectId_kind: { projectId: project.id, kind } } }))?.id
    : undefined

  await using stack = new AsyncDisposableStack()

  const stagingDir = await makeTempBuildDir(trackingKey)

  // Must be the shared mount: a second overlay on the same upper layer would corrupt the project.
  const mount = stack.use(await getShardCoordinator().acquireProjectMount(owner, project))

  const { homeDir } = await getShardCoordinator().ensureHomeDirectory(owner)
  const elanDir = getElanDir()
  const sandboxHomeDir = bwrapHomeDir(owner.name)

  const emitter = startTrackedCommand(
    trackingKey,
    { kind: 'user', userId: owner.id },
    'bwrap',
    // prettier-ignore
    [
      ...BWRAP_ARGS,
      '--ro-bind', elanDir, elanDir,
      '--ro-bind', getScriptsDir(), SANDBOX_SCRIPTS_DIR,
      // `lake` needs a writable home for its caches.
      '--bind', homeDir, sandboxHomeDir,
      '--bind', stagingDir, SANDBOX_OUT_DIR,
      '--setenv', 'HOME', sandboxHomeDir,
      '--setenv', 'ELAN_HOME', elanDir,
      '--setenv', 'PATH', `${elanDir}/bin:/usr/local/bin:/usr/bin:/bin`,
      // The overlay mount makes `lake`'s dependency clones look dubiously owned to Git
      // (CVE-2022-24765); see the same workaround in `VscodeServerHandle.start`.
      '--setenv', 'GIT_CONFIG_COUNT', '1',
      '--setenv', 'GIT_CONFIG_KEY_0', 'safe.directory',
      '--setenv', 'GIT_CONFIG_VALUE_0', '*',
      ...mount.bindArgs,
      '--chdir', bwrapProjectDir(project.name),
      '--',
      path.join(SANDBOX_SCRIPTS_DIR, plan.script), SANDBOX_OUT_DIR, ...plan.args,
    ],
  )
  if (!emitter) return { ok: false }

  emitter.on('exit', exit => {
    void (async () => {
      try {
        try {
          if (publishes) await finishPublish(project, kind, plan, stagingDir, exit, priorPub)
        } finally {
          await mount[Symbol.asyncDispose]()
          await fs.rm(stagingDir, { recursive: true, force: true })
        }
      } catch (e: unknown) {
        console.error(`[viewBuild] ${project.id}/${kind} did not complete: ${String(e)}`)
      }
    })()
  })

  // The build owns the mount lease from here on.
  stack.move()
  return { ok: true }
}
