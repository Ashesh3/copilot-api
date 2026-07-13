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
  showToken: boolean
  debug: boolean
  verbose: boolean
  apiKeyAuth?: string

  // Multi-token mode
  isMultiToken: boolean
}

export const state: State = {
  accountType: "individual",
  sessionId: randomUUID(),
  manualApprove: false,
  showToken: false,
  debug: false,
  verbose: false,
  isMultiToken: false,
}
