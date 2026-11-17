import { useSyncExternalStore } from 'react'
import type { Resource, ResourceState } from './appStore.ts'
import type { LiveStatus, LiveSync } from './liveSync.ts'

const EMPTY: ResourceState<never> = { data: null, dataKey: null, error: null, errorKey: null, loading: false, version: 0, fetchedAt: null }
const noopSubscribe = () => () => {}

export function useResource<Q, R>(res: Resource<Q, R> | null): ResourceState<R> {
  const r = res
  return useSyncExternalStore(
    r ? (l) => r.subscribe(l) : noopSubscribe,
    () => (r ? r.state : (EMPTY as ResourceState<R>)),
  )
}

export function useLiveStatus(sync: LiveSync | null): LiveStatus {
  return useSyncExternalStore(
    sync ? (l) => sync.onStatus(l) : noopSubscribe,
    () => sync?.status ?? 'connecting',
  )
}
