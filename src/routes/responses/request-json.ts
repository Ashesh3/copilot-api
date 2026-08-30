import {
  createInvalidJsonBodyError,
  isAbortError,
  LocalHTTPError,
} from "~/lib/error"
import { CAPI_RESPONSES_MAX_REQUEST_BYTES } from "~/services/copilot/responses-payload-recovery"

export const RESPONSES_REQUEST_MAX_DECOMPRESSED_BYTES =
  CAPI_RESPONSES_MAX_REQUEST_BYTES * 2

export async function readResponsesRequestJson<T>(
  request: Request,
): Promise<T> {
  const contentEncoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase()

  if (!contentEncoding || contentEncoding === "identity") {
    return (await request.json()) as T
  }

  if (contentEncoding !== "zstd") {
    throw createUnsupportedRequestContentEncodingError()
  }
  if (!request.body) {
    throw createInvalidJsonBodyError()
  }

  try {
    const decompressed = request.body.pipeThrough(
      new DecompressionStream("zstd"),
    )
    const bytes = await readStreamWithLimit(
      decompressed,
      RESPONSES_REQUEST_MAX_DECOMPRESSED_BYTES,
    )
    const text = new TextDecoder(undefined, { fatal: true }).decode(bytes)
    return JSON.parse(text) as T
  } catch (error) {
    if (error instanceof LocalHTTPError || isAbortError(error)) throw error
    throw createInvalidJsonBodyError()
  }
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Array<Buffer> = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) throw createRequestBodyTooLargeError()
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, totalBytes)
}

function createUnsupportedRequestContentEncodingError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "unsupported_value",
      message: "The request content encoding must be identity or zstd.",
      param: "content_encoding",
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 415 }),
    clientBody,
  )
}

function createRequestBodyTooLargeError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "request_too_large",
      message:
        "The decompressed request body exceeds the supported size limit.",
      param: "body",
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 413 }),
    clientBody,
  )
}
