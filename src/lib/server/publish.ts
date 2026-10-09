import 'server-only'

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { existsAsync, getPublicationDir } from '@leanprover/workbench-shared/node'

import { getConfig, isPublishingEnabled } from '@/lib/server/config'
import { getDb } from '@/lib/server/db'
import { type TrackedCommandExit } from '@/lib/util'
import { type Prisma, type Project } from '@/prisma/generated/client'

import { type BuildPlan } from './views'

/** First segment of a publication's durable URL.
    TODO(#132): ensure there is no user named "pub" */
export const PUB_DURABLE_PREFIX = 'pub'

function getPubBaseUrl(): string {
  const cfg = getConfig()
  if (!isPublishingEnabled(cfg)) throw new Error('internal error: publication URL built while publishing is disabled')
  return cfg.pubBaseUrl
}

/** The "friendly" URL for a publication. it names whichever publication is current
 * for this project and kind. */
export function publicationUrl(ownerName: string, projectName: string, kind: string): string {
  return `${getPubBaseUrl()}/${ownerName}/${projectName}/${kind}/`
}

/** An internal URL that names a publication irrespective of user or project name. */
export function durablePublicationUrl(publicationId: string): string {
  return `${getPubBaseUrl()}/${PUB_DURABLE_PREFIX}/${publicationId}/`
}

/** Swap a finished build's output into place, or discard it.
 *
 * A failed build leaves any existing publication exactly as it was.
 * So does one whose publication went away while it ran:
 * {@link priorPub} is the id of the row the build set out to replace,
 * and a build that no longer has one has been overtaken by the owner.
 *
 * The URL 404s briefly while the directories are exchanged;
 * avoiding that would mean a database lookup in front of every static asset.
 *
 * The caller owns the staging directory, and removes it whether this throws or not. */
export async function finishPublish(
  project: Project,
  kind: string,
  plan: BuildPlan,
  stagingDir: string,
  exit: TrackedCommandExit,
  priorPub: string | undefined,
) {
  if (exit.type !== 'success') return
  if (plan.siteDir === undefined) throw new Error('the build declares no site directory, so it publishes nothing')

  const siteDir = path.join(stagingDir, plan.siteDir)
  if (!(await existsAsync(siteDir))) {
    throw new Error(`the build wrote no '${plan.siteDir}' directory, so it produced no site`)
  }

  const db = getDb()
  const where = { projectId_kind: { projectId: project.id, kind } }
  const current = (await db.publication.findUnique({ where }))?.id
  if (priorPub !== undefined && current !== priorPub) return

  const id = current ?? crypto.randomUUID()

  // Before moving anything: if the project has been deleted, the foreign key fails here,
  // while the output is still in staging for the caller to remove.
  await db.publication.upsert({
    where,
    create: { id, projectId: project.id, kind },
    update: { updatedAt: new Date() },
  })

  const liveDir = getPublicationDir(id)
  const replacedDir = `${stagingDir}-replaced`

  // Why rename-then-rm the old directory?
  // - avoid a partially deleted publication being visible
  // - get to a state where the new publication *is* visible as soon as possible
  //   because the renames are fast and the recursive rm might be slower.
  //
  // Why not atomically swap a symlink?
  // - We must for security reasons disable symlinks from being
  //   followed by nginx *inside* publications, because otherwise
  //   malicious publications could exfiltrate other parts of the
  //   filesystem that they're not meant to. For now, prefer a big
  //         disable_symlinks on;
  //  in nginx-pub.conf.template to avoid any future accidents.
  //  The disadvantage of the lack of atomicity here is mild; the
  //  user might get a transient 404 if their timing is very
  //  unlikely. We could consider having a database entry be the
  //  "pointer" to the filesystem position of the current
  //  publication version. If we move to keeping multiple versions
  //  of a publication we should probably do this.
  if (await existsAsync(liveDir)) await fs.rename(liveDir, replacedDir)
  await fs.rename(siteDir, liveDir)
  await fs.rm(replacedDir, { recursive: true, force: true })
}

/** Take the matching publications out of service and remove their files.
 *
 * Rows go first: a publication is live exactly while its row exists,
 * so an interruption here leaves unreferenced directories
 * rather than rows pointing at files that are gone. */
export async function deletePublications(where: Prisma.PublicationWhereInput): Promise<void> {
  const db = getDb()
  const publications = await db.publication.findMany({ where })
  await db.publication.deleteMany({ where })
  await Promise.all(publications.map(p => fs.rm(getPublicationDir(p.id), { recursive: true, force: true })))
}
