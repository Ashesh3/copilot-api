export type Environment = {
  id: string
  machineName: string
  directory: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  metadata: Record<string, unknown>
  createdAt: number
  workQueue: Array<WorkItem>
}

export type WorkItem = {
  id: string
  type: "work"
  environment_id: string
  state: "pending" | "acknowledged" | "stopped"
  data: {
    type: "session" | "healthcheck"
    id: string
  }
  secret: string
  created_at: string
}
