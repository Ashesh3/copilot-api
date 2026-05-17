import consola from "consola"
import { Hono } from "hono"

import {
  createCustomProviderEmbeddings,
  resolveCustomProviderModel,
} from "~/lib/custom-providers"
import { forwardError } from "~/lib/error"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    const customReference = resolveCustomProviderModel({
      model: payload.model,
      kind: "embedding",
      copilotModelIds: new Set(
        state.models?.data.map((model) => model.id) ?? [],
      ),
    })

    if (customReference) {
      consola.debug(
        `Routing custom embedding model ${payload.model} to ${customReference.provider.id}/${customReference.upstreamModel}`,
      )
      setRequestContext(c, {
        requestedModel: payload.model,
        provider: customReference.provider.name,
        model: customReference.upstreamModel,
      })
      const response = await createCustomProviderEmbeddings(
        customReference,
        payload,
        { signal: c.req.raw.signal },
      )
      return c.json({ ...response, model: payload.model })
    }

    setRequestContext(c, {
      requestedModel: payload.model,
      provider: "Embeddings",
      model: payload.model,
    })

    const response = await createEmbeddings(payload, {
      signal: c.req.raw.signal,
    })

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
