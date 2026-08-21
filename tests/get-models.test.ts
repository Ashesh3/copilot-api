import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getModels } from "~/services/copilot/get-models"

const originalFetch = globalThis.fetch
let queuedResponse: Response

const fetchMock = mock(() => queuedResponse)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  queuedResponse = Response.json({ object: "list", data: [] })
})

test("getModels preserves the original failure response without logging its body", async () => {
  const bodyMarker = "models-private-body"
  const statusMarker = "models-private-status"
  const upstream = new Response(bodyMarker, {
    status: 409,
    statusText: statusMarker,
    headers: { "content-type": "text/plain" },
  })
  queuedResponse = upstream
  const errorSpy = spyOn(consola, "error")

  try {
    const error = await getModels().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).message).toBe("Failed to get Copilot models")
    expect((error as HTTPError).response).toBe(upstream)
    expect(upstream.bodyUsed).toBe(false)
    const output = JSON.stringify(errorSpy.mock.calls)
    expect(output).not.toContain(bodyMarker)
    expect(output).not.toContain(statusMarker)
  } finally {
    errorSpy.mockRestore()
  }
})
