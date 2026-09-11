import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { RE2JS } from "re2js"

import {
  applyReplacements,
  applyReplacementsToPayload,
  getAllReplacements,
  loadReplacements,
  setReplacementsForTest,
} from "~/lib/auto-replace"
import { writeSetting } from "~/lib/storage/domain-settings"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import {
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"

import { createRuntimeStorage } from "./helpers/runtime-storage"

let fixture: Awaited<ReturnType<typeof createRuntimeStorage>>

beforeEach(async () => {
  fixture = await createRuntimeStorage()
  await initializeStorageRuntime(fixture)
  await loadReplacements()
})

afterEach(async () => {
  await fixture.close()
})

function rule(replacement: string) {
  return {
    id: "word",
    name: "Word",
    pattern: String.raw`word-(\d+)`,
    replacement,
    enabled: true,
    isRegex: true,
  }
}

test("repeated text parts reuse compiled patterns while each matcher replaces its own text", async () => {
  await writeSetting("replacements", [rule("item-$1")])
  expect((await applyReplacements("word-7")).text).toBe("item-7")
  const compile = spyOn(RE2JS, "compile")
  try {
    const payload = {
      model: "fixture-model",
      messages: Array.from({ length: 100 }, (_, index) => ({
        role: "user" as const,
        content: `word-${index}`,
      })),
    }
    const result = await applyReplacementsToPayload(payload)
    expect(result.payload.messages[0].content).toBe("item-0")
    expect(result.payload.messages[99].content).toBe("item-99")
    expect(result.appliedRules).toEqual(["Word"])
    expect(payload.messages[0].content).toBe("word-0")
    expect(compile).not.toHaveBeenCalled()
  } finally {
    compile.mockRestore()
  }
})

test("committed rule changes affect new requests without changing an admitted snapshot", async () => {
  const runtime = getStorageRuntime()
  await writeSetting("replacements", [rule("before-$1")])
  const old = runtime.snapshot.get()
  expect(
    (await withRequestSnapshot(old, () => applyReplacements("word-1"))).text,
  ).toBe("before-1")
  await writeSetting("replacements", [rule("after-$1")])
  expect((await applyReplacements("word-1")).text).toBe("after-1")
  expect(
    (await withRequestSnapshot(old, () => applyReplacements("word-2"))).text,
  ).toBe("before-2")
})

test("compiled rules do not cross storage instances with the same revision", async () => {
  await writeSetting("replacements", [rule("first-$1")])
  const revision = getStorageRuntime().snapshot.get().revision
  expect((await applyReplacements("word-1")).text).toBe("first-1")
  await fixture.close()
  // eslint-disable-next-line require-atomic-updates -- This sequential test owns the fixture until its afterEach cleanup.
  fixture = await createRuntimeStorage()
  await initializeStorageRuntime(fixture)
  await writeSetting("replacements", [rule("second-$1")])
  expect(getStorageRuntime().snapshot.get().revision).toBe(revision)
  expect((await applyReplacements("word-1")).text).toBe("second-1")
})

test("public rule copies cannot mutate cached patterns and fixture replacement invalidates its cache", async () => {
  await writeSetting("replacements", [rule("stored-$1")])
  expect((await applyReplacements("word-3")).text).toBe("stored-3")
  const rules = await getAllReplacements()
  const selected = rules.find((entry) => entry.id === "word")
  if (!selected) throw new Error("Missing rule")
  selected.pattern = "word"
  selected.replacement = "tampered"
  expect((await applyReplacements("word-3")).text).toBe("stored-3")
  setReplacementsForTest([rule("fixture-one-$1")])
  expect((await applyReplacements("word-3")).text).toBe("fixture-one-3")
  setReplacementsForTest([rule("fixture-two-$1")])
  expect((await applyReplacements("word-3")).text).toBe("fixture-two-3")
})

test("a present null replacement document remains invalid after caching another snapshot", async () => {
  expect((await applyReplacements("word-1")).text).toBe("word-1")
  const snapshot = getStorageRuntime().snapshot.get()
  const invalid = {
    ...snapshot,
    documents: new Map(snapshot.documents).set("replacements", {
      namespace: "replacements" as const,
      value: null,
      revision: snapshot.revision,
    }),
  }
  const failure: unknown = await withRequestSnapshot(invalid, () =>
    applyReplacements("word-1"),
  ).catch((error: unknown) => error)
  expect(failure).toMatchObject({ code: "storage_schema" })
})

test("cached rules preserve ordering, disabled entries, system rule and regex replacement expansions", async () => {
  await writeSetting("replacements", [
    { ...rule("$<number>:$1:$$:$&"), pattern: String.raw`word-(?<number>\d+)` },
    {
      id: "disabled",
      pattern: "7",
      replacement: "bad",
      enabled: false,
      isRegex: true,
    },
    {
      id: "literal",
      pattern: "done",
      replacement: "complete",
      enabled: true,
      isRegex: false,
    },
  ])
  const result = await applyReplacements(
    "x-anthropic-billing-header: discard\nword-7 done",
  )
  expect(result.text).toBe("7:7:$:word-7 complete")
  expect(result.appliedRules).toEqual([
    "Remove Anthropic billing header",
    "Word",
    "literal",
  ])
  expect((await applyReplacements("word-9 done")).text).toBe(
    "9:9:$:word-9 complete",
  )
})
