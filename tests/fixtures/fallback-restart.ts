import { HTTPError } from "../../src/lib/error"
import {
  applyModelFallbackToPayload,
  recordModelFallbackResponse,
  runWithModelFallback,
} from "../../src/lib/model-fallback"
import { setModelFallbackConfig } from "../../src/lib/model-fallback-config"
import { state } from "../../src/lib/state"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
} from "../../src/lib/storage/runtime"
import { fallbackModels } from "../helpers/fallback-models"

const [databasePath, phase] = process.argv.slice(2)
if (!databasePath || !phase)
  throw new Error("Missing restart fixture arguments")
await initializeStorageRuntime({
  config: { kind: "sqlite", path: databasePath },
})
const originalState = { models: state.models, isMultiToken: state.isMultiToken }
try {
  state.isMultiToken = false
  state.models = fallbackModels(["source", "target"])
  if (phase === "seed") {
    await setModelFallbackConfig({
      enabled: true,
      rules: [{ id: "restart", sourceModel: "source", targetModel: "target" }],
    })
  }
  const sent: Array<{ model: string; input: Array<Record<string, unknown>> }> =
    []
  const history = () => ({
    model: "source",
    input: [
      { type: "reasoning", encrypted_content: "old-source-signature" },
      ...(phase === "read" ?
        [{ type: "reasoning", encrypted_content: "new-target-signature" }]
      : []),
      { role: "user", content: "Continue" },
    ],
  })
  await runWithModelFallback(
    {
      conversationKey: "durable-thread",
      headers: new Headers({ authorization: "Bearer fixture-credential" }),
      payload: history(),
    },
    async () => {
      const payload = applyModelFallbackToPayload(history())
      sent.push(payload)
      const response = new Response(null, {
        status: payload.model === "source" ? 422 : 200,
      })
      await recordModelFallbackResponse(response)
      if (!response.ok)
        throw new HTTPError("Fixture upstream rejection", response)
    },
  )
  process.stdout.write(JSON.stringify(sent))
} finally {
  Object.assign(state, originalState)
  await closeStorageRuntime()
}
