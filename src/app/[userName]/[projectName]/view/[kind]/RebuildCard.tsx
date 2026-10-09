'use client'

import { useRouter } from 'next/navigation'

import TrackedCommandForm from '@/app/components/TrackedCommandForm'

import { rebuildView } from './actions'

/** Rebuilds what a live view reads out of the project tree.
 *
 * A live view shows the last build rather than the current source,
 * which is why rebuilding is part of the view's own interface. */
export function RebuildCard({
  userName,
  projectName,
  kind,
  trackingKey,
}: {
  userName: string
  projectName: string
  kind: string
  trackingKey: string
}) {
  const router = useRouter()
  return (
    <TrackedCommandForm
      streamCommandKey={trackingKey}
      scope='user'
      title='Rebuild'
      trackedCommandAction={rebuildView}
      successAction={() => router.refresh()}
    >
      <input type='hidden' name='userName' value={userName} />
      <input type='hidden' name='projectName' value={projectName} />
      <input type='hidden' name='kind' value={kind} />
      <p>
        The project is built in a sandbox, and what it generates replaces what this view is currently reading. Building
        a Lean project can take a while.
      </p>
    </TrackedCommandForm>
  )
}
