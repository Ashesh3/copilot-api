import { HTTPError } from "~/lib/error"
import { copilotFetch, copilotHeaders } from "~/services/copilot/copilot-client"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  const response = await copilotFetch("/embeddings", {
    method: "POST",
    headers: copilotHeaders(),
    body: JSON.stringify(payload),
  })

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
