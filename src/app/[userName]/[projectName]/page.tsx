import { zProjectName, zUserName } from '@leanprover/workbench-shared'
import { getProjectDir } from '@leanprover/workbench-shared/node'
import { type Route } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import z from 'zod'

import { SetNavbarExtra } from '@/app/NavbarExtra'
import { getShardCoordinator } from '@/lib/server/shardConnection'
import { requireProjectAccess } from '@/lib/server/util'
import { type DeclaredView, detectViews } from '@/lib/server/views'

const zParams = z.object({
  userName: zUserName,
  projectName: zProjectName,
})

type Params = z.infer<typeof zParams>

export default async function EditorSession({ params: params_ }: { params: Promise<Params> }) {
  // Suspend during pre-rendering and on <Link> prefetches
  // instead of running this (expensive) handler.
  await connection()

  const parsed = zParams.safeParse(await params_)
  // 400 would be better, but RSCs can't return a Response and there is no 400 helper in Next.js.
  if (!parsed.success) notFound()
  const { userName, projectName } = parsed.data

  const { viewer, owner, project } = await requireProjectAccess(userName, projectName)

  const manifest = await detectViews(getProjectDir(owner, project.id))
  const views: DeclaredView[] = manifest.type === 'declared' ? manifest.views : []

  const coordinator = getShardCoordinator()
  // may throw to error boundary (e.g. if the project folder isn't accessible)
  const iframeUrl = await coordinator.ensureSession(viewer, owner, project)

  // TODO: VSC should be sandboxed but can't be opaque-origin: need a subdomain.
  return (
    <>
      <SetNavbarExtra>
        {views.map(view => (
          <Link className='view-link' key={view.id} href={`/${userName}/${projectName}/view/${view.id}` as Route}>
            {view.displayName}
          </Link>
        ))}
      </SetNavbarExtra>
      <iframe id='editor-frame' src={iframeUrl} className='editor-session-iframe' />
    </>
  )
}
