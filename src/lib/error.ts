import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response
  requestPayload?: unknown

  constructor(message: string, response: Response, requestPayload?: unknown) {
    super(message)
    this.response = response
    this.requestPayload = requestPayload
  }
}

interface ContentFilterError {
  error: {
    code: string
    innererror?: {
      code: string
      content_filter_result?: unknown
    }
  }
}

function isContentFilterError(obj: unknown): obj is ContentFilterError {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "error" in obj &&
    typeof (obj as ContentFilterError).error === "object" &&
    (obj as ContentFilterError).error?.code === "content_filter"
  )
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)

    // Check for content filter error and log full details
    if (isContentFilterError(errorJson)) {
      consola.box("CONTENT FILTER TRIGGERED")
      consola.error("Full error response:")
      console.log(JSON.stringify(errorJson, null, 2))

      if (error.requestPayload) {
        consola.error("Request payload that triggered the filter:")
        console.log(JSON.stringify(error.requestPayload, null, 2))
      }
    }

    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
