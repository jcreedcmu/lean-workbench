import { zProjectName, zUserName } from '@leanprover/workbench-shared'
import { getProjectDir } from '@leanprover/workbench-shared/node'
import { type Route } from 'next'
import { notFound, redirect } from 'next/navigation'
import { connection } from 'next/server'
import z from 'zod'

import ErrorBox from '@/app/components/ErrorBox'
import { getConfig, isPublishingEnabled } from '@/lib/server/config'
import { publicationUrl } from '@/lib/server/publish'
import { requireProjectAccess } from '@/lib/server/util'
import { detectViews, VIEWS } from '@/lib/server/views'

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

  const manifest = await detectViews(getProjectDir(owner, project.id))
  if (manifest.type === 'invalid') return <ErrorBox>{manifest.error}</ErrorBox>
  const view = manifest.type === 'declared' ? manifest.views.find(v => v.id === kind) : undefined
  // The declaration is what enables a view on a project, registry entry or not.
  if (!view) notFound()
  if ('error' in view) return <ErrorBox>{view.error}</ErrorBox>

  // No view declares `live` yet, so nothing reaches this.
  notFound()
}
