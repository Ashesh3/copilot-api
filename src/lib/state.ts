import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  sessionId: string
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean
  debug: boolean
  verbose: boolean
  apiKeyAuth?: string

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  accountType: "individual",
  sessionId: randomUUID(),
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  debug: false,
  verbose: false,
}
