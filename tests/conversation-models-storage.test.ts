/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited. */
import { afterEach, expect, test } from "bun:test"

import type { ConversationModelBinding } from "~/lib/storage/conversation-models-repository"

import { createConversationModelsRepository } from "~/lib/storage/conversation-models-repository"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { getStoreRevision } from "~/lib/storage/operations"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"

const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.close()))
})

const conversationKey = "a".repeat(64)
const binding: ConversationModelBinding = {
  configRevision: 0,
  redirectRevision: 0,
  signature: "b".repeat(64),
}

async function fixture() {
  const value = await createSchemaFixture()
  fixtures.push(value)
  await migrateStorage(value.storage)
  return {
    ...value,
    repository: createConversationModelsRepository(value.storage),
  }
}

function accepted(
  requestSequence: number,
  targetModel = "model-b",
  hashes = ["c"],
) {
  return {
    conversationKey,
    binding,
    sourceModel: "model-a",
    targetModel,
    identitySignature: "f".repeat(64),
    route: [{ source: "model-a", target: targetModel, resolved: targetModel }],
    foreignThinking: {
      complete: true,
      fingerprints: new Set(hashes.map((hash) => hash.repeat(64))),
    },
    requestSequence,
  }
}

test("remembered destinations and foreign fingerprints survive SQLite reopen", async () => {
  const value = await fixture()
  const first = await value.repository.begin(conversationKey, binding)
  expect(first.routes.size).toBe(0)
  await value.repository.remember(accepted(first.requestSequence))
  await value.storage.close()
  const reopened = new LocalSqliteStorage(value.path)
  try {
    const next = await createConversationModelsRepository(reopened).begin(
      conversationKey,
      binding,
    )
    expect(next.requestSequence).toBeGreaterThan(first.requestSequence)
    expect(next.routes.get("model-a")).toMatchObject({
      sourceModel: "model-a",
      targetModel: "model-b",
      foreignThinking: {
        complete: true,
        fingerprints: new Set(["c".repeat(64)]),
      },
    })
    expect(await getStoreRevision(reopened)).toBe(0)
  } finally {
    await reopened.close()
  }
})

test("independent adapters allocate unique tickets and reject older destination rollback", async () => {
  const value = await fixture()
  const peer = new LocalSqliteStorage(value.path)
  try {
    const repository = createConversationModelsRepository(peer)
    const older = await value.repository.begin(conversationKey, binding)
    const newer = await repository.begin(conversationKey, binding)
    expect(newer.requestSequence).toBeGreaterThan(older.requestSequence)
    await repository.remember(accepted(newer.requestSequence, "model-c", ["d"]))
    await value.repository.remember(accepted(older.requestSequence))
    const next = await value.repository.begin(conversationKey, binding)
    expect(next.routes.get("model-a")?.targetModel).toBe("model-c")
    expect(next.routes.get("model-a")?.foreignThinking.fingerprints).toEqual(
      new Set(["d".repeat(64)]),
    )
  } finally {
    await peer.close()
  }
})

test("concurrent same-target writers retain both sets of foreign fingerprints", async () => {
  const value = await fixture()
  const peer = new LocalSqliteStorage(value.path)
  try {
    const repository = createConversationModelsRepository(peer)
    const [left, right] = await Promise.all([
      value.repository.begin(conversationKey, binding),
      repository.begin(conversationKey, binding),
    ])
    expect(left.requestSequence).not.toBe(right.requestSequence)
    await Promise.all([
      value.repository.remember(
        accepted(left.requestSequence, "model-b", ["c"]),
      ),
      repository.remember(accepted(right.requestSequence, "model-b", ["d"])),
    ])
    const next = await repository.begin(conversationKey, binding)
    expect(next.routes.get("model-a")?.foreignThinking.fingerprints).toEqual(
      new Set(["c".repeat(64), "d".repeat(64)]),
    )
  } finally {
    await peer.close()
  }
})

test.each(["model_fallbacks", "model_redirects"])(
  "peer changes to %s reject stale writers while current requests recover route candidates",
  async (namespace) => {
    const value = await fixture()
    const pending = await value.repository.begin(conversationKey, binding)
    await value.repository.remember(accepted(pending.requestSequence))
    const peer = new LocalSqliteStorage(value.path)
    try {
      await peer.atomicBatch([
        {
          sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES(?, '{}', 1)",
          args: [namespace],
        },
      ])
      await value.repository.remember(
        accepted(pending.requestSequence, "model-c"),
      )
      expect(
        (await value.repository.begin(conversationKey, binding)).routes.size,
      ).toBe(0)
      const nextBinding = {
        ...binding,
        configRevision: namespace === "model_fallbacks" ? 1 : 0,
        redirectRevision: namespace === "model_redirects" ? 1 : 0,
      }
      const next = await value.repository.begin(conversationKey, nextBinding)
      expect(next.routes.get("model-a")?.targetModel).toBe("model-b")
      await value.repository.remember({
        ...accepted(next.requestSequence, "model-d"),
        binding: nextBinding,
      })
      expect(
        (await value.repository.begin(conversationKey, nextBinding)).routes.get(
          "model-a",
        )?.targetModel,
      ).toBe("model-d")
    } finally {
      await peer.close()
    }
  },
)

test("conversation identity isolates route candidates without expiring them on signature changes", async () => {
  const { repository } = await fixture()
  const first = await repository.begin(conversationKey, binding)
  await repository.remember(accepted(first.requestSequence))
  expect((await repository.begin("d".repeat(64), binding)).routes.size).toBe(0)
  expect(
    (
      await repository.begin(conversationKey, {
        ...binding,
        signature: "e".repeat(64),
      })
    ).routes.get("model-a")?.targetModel,
  ).toBe("model-b")
})

test("the same route merges fingerprints across configuration signatures", async () => {
  const { repository } = await fixture()
  const first = await repository.begin(conversationKey, binding)
  await repository.remember(accepted(first.requestSequence))
  const nextBinding = { ...binding, signature: "e".repeat(64) }
  const next = await repository.begin(conversationKey, nextBinding)
  await repository.remember({
    ...accepted(next.requestSequence, "model-b", ["d"]),
    binding: nextBinding,
  })
  expect(
    (await repository.begin(conversationKey, nextBinding)).routes.get("model-a")
      ?.foreignThinking.fingerprints,
  ).toEqual(new Set(["c".repeat(64), "d".repeat(64)]))
})

test("a changed route to the same target does not inherit old route fingerprints", async () => {
  const { repository } = await fixture()
  const first = await repository.begin(conversationKey, binding)
  await repository.remember(accepted(first.requestSequence))
  const next = await repository.begin(conversationKey, binding)
  await repository.remember({
    ...accepted(next.requestSequence, "model-b", ["d"]),
    route: [
      { source: "model-a", target: "model-c", resolved: "model-c" },
      { source: "model-c", target: "model-b", resolved: "model-b" },
    ],
  })
  await repository.remember(accepted(first.requestSequence, "model-b", ["e"]))
  const latest = (await repository.begin(conversationKey, binding)).routes.get(
    "model-a",
  )
  expect(latest?.foreignThinking.fingerprints).toEqual(
    new Set(["d".repeat(64)]),
  )
  expect(latest?.route).toHaveLength(2)
})

test("remapped provider identities never merge old signatures despite unchanged model names", async () => {
  const { repository } = await fixture()
  const older = await repository.begin(conversationKey, binding)
  await repository.remember(accepted(older.requestSequence))
  const newer = await repository.begin(conversationKey, binding)
  await repository.remember({
    ...accepted(newer.requestSequence, "model-b", ["d"]),
    identitySignature: "e".repeat(64),
  })
  await repository.remember(accepted(older.requestSequence, "model-b", ["a"]))
  const stored = (await repository.begin(conversationKey, binding)).routes.get(
    "model-a",
  )
  expect(stored?.identitySignature).toBe("e".repeat(64))
  expect(stored?.foreignThinking.fingerprints).toEqual(
    new Set(["d".repeat(64)]),
  )
})

test("an incomplete newer fingerprint state cannot be resurrected by an older request", async () => {
  const { repository } = await fixture()
  const older = await repository.begin(conversationKey, binding)
  const newer = await repository.begin(conversationKey, binding)
  const incomplete = accepted(newer.requestSequence, "model-c")
  incomplete.foreignThinking.complete = false
  await repository.remember(incomplete)
  await repository.remember(accepted(older.requestSequence))
  expect((await repository.begin(conversationKey, binding)).routes.size).toBe(0)
})

test("a failed publication transaction preserves the previous accepted destination", async () => {
  const { repository, storage } = await fixture()
  const first = await repository.begin(conversationKey, binding)
  await repository.remember(accepted(first.requestSequence))
  const next = await repository.begin(conversationKey, binding)
  const failing = createConversationModelsRepository(
    faultStorage(storage, {
      beforeCommit() {
        throw new Error("injected commit failure")
      },
    }),
  )
  await expect(
    failing.remember(accepted(next.requestSequence, "model-c")),
  ).rejects.toThrow("injected commit failure")
  expect(
    (await repository.begin(conversationKey, binding)).routes.get("model-a")
      ?.targetModel,
  ).toBe("model-b")
})

test("long routes retain every configured hop without a small hop limit", async () => {
  const { repository } = await fixture()
  const first = await repository.begin(conversationKey, binding)
  const route = [
    "model-a",
    "model-b",
    "model-c",
    "model-d",
    "model-e",
    "model-f",
  ]
  await repository.remember({
    ...accepted(first.requestSequence, "model-f"),
    route: route.slice(1).map((target, index) => ({
      source: route[index],
      target,
      resolved: target,
    })),
  })
  expect(
    (await repository.begin(conversationKey, binding)).routes.get("model-a")
      ?.route,
  ).toHaveLength(5)
})
