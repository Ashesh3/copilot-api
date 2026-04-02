export type SessionState = "idle" | "running" | "requires_action"

export type CodeSession = {
  id: string
  title: string
  state: SessionState
  tags: Array<string>
  workerEpoch: number
  workerStatus: SessionState
  workerRegistered: boolean
  externalMetadata: Record<string, unknown> | null
  requiresActionDetails: RequiresActionDetails | null
  createdAt: number
  lastHeartbeat: number
  archived: boolean
}

export type RequiresActionDetails = {
  tool_name?: string
  action_description?: string
  request_id?: string
}

export type ClientEvent = {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
  is_compaction?: boolean
  agent_id?: string
}

export type InternalEvent = {
  event_id: string
  event_type: string
  payload: Record<string, unknown>
  event_metadata?: Record<string, unknown> | null
  is_compaction: boolean
  created_at: string
  agent_id?: string
}
