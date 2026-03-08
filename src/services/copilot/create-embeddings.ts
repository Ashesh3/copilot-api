import { getHeadersForModel, routedFetch } from "~/lib/account-router"
import { HTTPError } from "~/lib/error"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  const { headers } = getHeadersForModel(payload.model)
  const { response } = await routedFetch(
    "/embeddings",
    { method: "POST", headers, body: JSON.stringify(payload) },
    { modelId: payload.model },
  )

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
