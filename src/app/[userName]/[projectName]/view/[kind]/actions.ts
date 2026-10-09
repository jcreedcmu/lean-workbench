'use server'

import { zProjectName, zUserName } from '@leanprover/workbench-shared'
import { getProjectDir } from '@leanprover/workbench-shared/node'
import z from 'zod'

import { requireProjectAccess, submitAction } from '@/lib/server/util'
import { startViewBuild } from '@/lib/server/viewBuild'
import { detectViews } from '@/lib/server/views'
import { type ActionResponse } from '@/lib/util'

const zBuildTarget = z.object({
  userName: zUserName,
  projectName: zProjectName,
  kind: z.string(),
})

/** Rebuild the artifact one of the project's live views reads out of the project tree.
 *
 * Anyone who may see the view may rebuild it:
 * the build writes only into the project tree, which they can already edit. */
export const rebuildView = submitAction(
  zBuildTarget,
  async ({ userName, projectName, kind }): Promise<ActionResponse<boolean>> => {
    const { owner, project } = await requireProjectAccess(userName, projectName)
    const manifest = await detectViews(getProjectDir(owner, project.id))
    if (manifest.type === 'missing') return { error: 'This project no longer declares any views.' }
    if (manifest.type === 'invalid') return { error: manifest.error }

    const view = manifest.views.find(v => v.id === kind)
    if (!view) return { error: `This project does not declare a '${kind}' view.` }
    if ('error' in view) return { error: view.error }
    if (!view.build) return { error: `The '${kind}' view builds nothing.` }

    return startViewBuild(owner, project, kind, view.build)
  },
)
