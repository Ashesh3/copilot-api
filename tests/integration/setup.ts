// tests/integration/setup.ts
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { server } from "~/server"
import { getModels } from "~/services/copilot/get-models"
import { getCopilotToken } from "~/services/github/get-copilot-token"

export const TEST_TIMEOUT = 60_000

let initialized = false

export async function initializeTestState(): Promise<void> {
  if (initialized) return

  // Read stored GitHub token
  const githubToken = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
  if (!githubToken.trim()) {
    throw new Error(
      "No GitHub token found. Run 'copilot-api auth' first to authenticate.",
    )
  }
  state.githubToken = githubToken.trim()

  // Get Copilot token
  const { token } = await getCopilotToken()
  state.copilotToken = token

  // Fetch and cache models
  const models = await getModels()
  state.models = models

  initialized = true // eslint-disable-line require-atomic-updates
}

export async function request(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(path, "http://localhost")
  return server.request(url.pathname + url.search, init)
}

export async function postJSON(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

export async function collectSSEEvents(
  response: Response,
): Promise<Array<{ event?: string; data: string }>> {
  const text = await response.text()
  const events: Array<{ event?: string; data: string }> = []

  let currentEvent: string | undefined
  let currentData: Array<string> = []

  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice(6))
    } else if (line === "" && currentData.length > 0) {
      events.push({
        event: currentEvent,
        data: currentData.join("\n"),
      })
      currentEvent = undefined
      currentData = []
    }
  }

  // Handle trailing event without final newline
  if (currentData.length > 0) {
    events.push({
      event: currentEvent,
      data: currentData.join("\n"),
    })
  }

  return events
}
