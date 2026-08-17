import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { DEFAULT_COPILOT_INTEGRATION_ID } from "~/services/copilot/copilot-contract"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  copilotIntegrationId: string
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
  copilotIntegrationId: DEFAULT_COPILOT_INTEGRATION_ID,
  sessionId: randomUUID(),
  manualApprove: false,
  showToken: false,
  debug: false,
  verbose: false,
  isMultiToken: false,
}
