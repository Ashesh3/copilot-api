import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { DEFAULT_COPILOT_INTEGRATION_ID } from "~/services/copilot/copilot-contract"

import { DEFAULT_GITHUB_DOMAIN } from "./github-instance"

export interface State {
  githubToken?: string
  githubInstanceDomain: string
  copilotToken?: string
  copilotApiBaseUrl?: string

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
  githubInstanceDomain: DEFAULT_GITHUB_DOMAIN,
  accountType: "individual",
  copilotIntegrationId: DEFAULT_COPILOT_INTEGRATION_ID,
  sessionId: randomUUID(),
  manualApprove: false,
  showToken: false,
  debug: false,
  verbose: false,
  isMultiToken: false,
}
