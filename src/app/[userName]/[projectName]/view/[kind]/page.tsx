import path from 'node:path'

import { bwrapProjectDir, zProjectName, zUserName } from '@leanprover/workbench-shared'
import { existsAsync, getProjectDir } from '@leanprover/workbench-shared/node'
import { type Route } from 'next'
import { notFound, redirect } from 'next/navigation'
import { connection } from 'next/server'
import z from 'zod'

import ErrorBox from '@/app/components/ErrorBox'
import { getConfig, isPublishingEnabled } from '@/lib/server/config'
import { mintSignedDirToken, signedDirBaseUrl } from '@/lib/server/dirToken'
import { publicationUrl } from '@/lib/server/publish'
import { getShardCoordinator } from '@/lib/server/shardConnection'
import { requireProjectAccess } from '@/lib/server/util'
import { detectViews, type ViewData, VIEWS } from '@/lib/server/views'

/** Grant read access to one project-relative directory a view declared.
 *
 * A directory the project does not have is reported as absent rather than as a URL:
 * a token naming it would fail verification, and every fetch under it would 403,
 * which a client cannot tell from a directory it may not read.
 * So is one that resolves outside the project, which a view may not reach. */
async function grantViewData(projectDir: string, relDir: string): Promise<ViewData> {
  const dir = path.resolve(projectDir, relDir)
  const inProject = dir === projectDir || dir.startsWith(projectDir + path.sep)
  if (!inProject || !(await existsAsync(dir))) return { missing: relDir }
  return { url: signedDirBaseUrl(mintSignedDirToken(dir)) }
}

const zParams = z.object({
  userName: zUserName,
  projectName: zProjectName,
  kind: z.string(),
})

type Params = z.infer<typeof zParams>

/** One view of a project, dispatched on the facets the view declares.
 *
 * A view with nothing live is a redirect to the publication the publish origin serves,
 * which is public, so it consults neither the viewer nor the project.
 * A view with a `live` facet needs an account, and is enabled on a project
 * only by that project's own declaration. */
export default async function ViewPage({ params: params_ }: { params: Promise<Params> }) {
  // Reading the project directory is too expensive for prerendering or a <Link> prefetch.
  await connection()

  const parsed = zParams.safeParse(await params_)
  // 400 would be better, but RSCs can't return a Response and there is no 400 helper in Next.js.
  if (!parsed.success) notFound()
  const { userName, projectName, kind } = parsed.data

  const definition = VIEWS.find(v => v.id === kind)
  if (!definition) notFound()

  if (!definition.live) {
    if (!definition.publish || !isPublishingEnabled(getConfig())) notFound()
    redirect(publicationUrl(userName, projectName, kind) as Route)
  }

  const { viewer, owner, project } = await requireProjectAccess(userName, projectName)
  if (definition.live.access === 'owner' && viewer.id !== owner.id) notFound()

  const projectDir = getProjectDir(owner, project.id)
  const manifest = await detectViews(projectDir)
  if (manifest.type === 'invalid') return <ErrorBox>{manifest.error}</ErrorBox>
  const view = manifest.type === 'declared' ? manifest.views.find(v => v.id === kind) : undefined
  // The declaration is what enables a view on a project, registry entry or not.
  if (!view) notFound()
  if ('error' in view) return <ErrorBox>{view.error}</ErrorBox>

  const { live } = definition
  // May throw to the error boundary, e.g. if the project directory is not accessible.
  const backends = await getShardCoordinator().ensureView(viewer, owner, project, live.backends)
  const data = Object.fromEntries(
    await Promise.all(
      Object.entries(live.projectData?.(view.config) ?? {}).map(
        async ([prop, relDir]) => [prop, await grantViewData(projectDir, relDir)] as const,
      ),
    ),
  )

  return <live.Client config={view.config} projectDir={bwrapProjectDir(project.name)} backends={backends} data={data} />
}
