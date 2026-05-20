import { type LiveEvent } from './api'
import { STATIC_EVENTS } from './staticEvents'

export interface UseEventsState {
  events: LiveEvent[]
  loading: boolean
  error: string | null
}

export function useEvents(): UseEventsState {
  return { events: STATIC_EVENTS, loading: false, error: null }
}
