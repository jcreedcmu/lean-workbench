import { zProjectName, zUserName } from '@leanprover/workbench-shared'
import { notFound, redirect } from 'next/navigation'
import z from 'zod'

import { viewPath } from '@/lib/server/views'

const zParams = z.object({
  userName: zUserName,
  projectName: zProjectName,
  kind: z.string(),
})

type Params = z.infer<typeof zParams>

/** Redirects `/:userName/:projectName/:kind` to `view/:kind`, where views now live.
 * Kept so that links minted before views had their own path segment still resolve. */
export default async function LegacyViewRedirect({ params: params_ }: { params: Promise<Params> }) {
  const parsed = zParams.safeParse(await params_)
  if (!parsed.success) notFound()
  const { userName, projectName, kind } = parsed.data
  redirect(viewPath(userName, projectName, kind))
}
