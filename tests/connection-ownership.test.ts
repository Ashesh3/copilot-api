import { expect, test } from "bun:test"

import {
  normalizeConnectionOwnershipRejection,
  readConnectionOwnershipRejection,
} from "~/services/copilot/connection-ownership"

const OWNERSHIP = {
  error: { message: "Input item does not belong to this connection" },
}

test.each([401, 403])(
  "presents a %d Responses ownership rejection as a request error",
  async (status) => {
    const original = Response.json(OWNERSHIP, {
      status,
      headers: { "x-request-id": "ownership-request" },
    })

    const normalized = await normalizeConnectionOwnershipRejection(
      "/responses",
      original,
    )

    expect(normalized.status).toBe(400)
    expect(normalized.headers.get("x-request-id")).toBe("ownership-request")
    expect(await normalized.json()).toEqual(OWNERSHIP)
    expect(original.bodyUsed).toBe(true)
  },
)

test.each([
  ["/responses", new Response("Unauthorized", { status: 401 })],
  [
    "/responses",
    Response.json(
      { error: { message: "Bad credentials", type: "authentication_error" } },
      { status: 401 },
    ),
  ],
  ["/chat/completions", Response.json(OWNERSHIP, { status: 401 })],
  ["/responses", Response.json(OWNERSHIP, { status: 400 })],
])("leaves %s %p unchanged", async (path, response) => {
  expect(await normalizeConnectionOwnershipRejection(path, response)).toBe(
    response,
  )
})

test("never reads a server error as an ownership rejection", () => {
  expect(
    readConnectionOwnershipRejection({
      error: {
        code: "internal_error",
        message: "Input item ID does not belong to this connection",
      },
    }),
  ).toBeUndefined()
  expect(
    readConnectionOwnershipRejection({
      error: { code: "input_item_connection_mismatch", message: "Rejected" },
    }),
  ).toBe("rejected")
})
