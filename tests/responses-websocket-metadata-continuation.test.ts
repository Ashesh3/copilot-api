import { expect, test } from "bun:test"

import { resolveResponsesContinuation } from "~/routes/responses/websocket-protocol"

test.each([
  {
    name: "object snapshot and object current",
    snapshotMetadata: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      snapshot_only: true,
    },
    currentMetadata: {
      session_id: "replacement-session",
      thread_id: "replacement-thread",
      turn: "current",
    },
    expected: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      turn: "current",
    },
  },
  {
    name: "string snapshot and object current",
    snapshotMetadata: JSON.stringify({
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
    }),
    currentMetadata: {
      session_id: "replacement-session",
      turn: "current",
    },
    expected: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      turn: "current",
    },
  },
  {
    name: "object snapshot and string current",
    snapshotMetadata: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
    },
    currentMetadata: JSON.stringify({
      session_id: "replacement-session",
      thread_id: "replacement-thread",
      turn: "current",
    }),
    expected: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      turn: "current",
    },
  },
  {
    name: "string snapshot and string current",
    snapshotMetadata: JSON.stringify({
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
    }),
    currentMetadata: JSON.stringify({
      session_id: "replacement-session",
      thread_id: "replacement-thread",
      turn: "current",
    }),
    expected: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      turn: "current",
    },
  },
  {
    name: "valid string snapshot and malformed current",
    snapshotMetadata: JSON.stringify({
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      snapshot_only: true,
    }),
    currentMetadata: "{malformed-current",
    expected: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      snapshot_only: true,
    },
  },
  {
    name: "object snapshot and malformed current",
    snapshotMetadata: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      snapshot_only: true,
    },
    currentMetadata: "{malformed-current",
    expected: {
      session_id: "snapshot-session",
      thread_id: "snapshot-thread",
      snapshot_only: true,
    },
  },
  {
    name: "malformed snapshot and object current",
    snapshotMetadata: "{malformed-snapshot",
    currentMetadata: {
      session_id: "replacement-session",
      thread_id: "replacement-thread",
      turn: "current",
    },
    expected: { turn: "current" },
  },
  {
    name: "absent snapshot and string current",
    snapshotMetadata: undefined,
    currentMetadata: JSON.stringify({
      session_id: "replacement-session",
      thread_id: "replacement-thread",
      turn: "current",
    }),
    expected: { turn: "current" },
  },
  {
    name: "malformed snapshot and string current",
    snapshotMetadata: "{malformed-snapshot",
    currentMetadata: JSON.stringify({
      session_id: "replacement-session",
      thread_id: "replacement-thread",
      turn: "current",
    }),
    expected: { turn: "current" },
  },
  {
    name: "malformed snapshot and malformed current",
    snapshotMetadata: "{malformed-snapshot",
    currentMetadata: "{malformed-current",
    expected: undefined,
  },
])(
  "preserves continuation affinity across $name metadata",
  ({ currentMetadata, expected, snapshotMetadata }) => {
    const result = resolveResponsesContinuation(
      new Map([
        [
          "resp_metadata_matrix",
          {
            model: "model-a",
            client_metadata: snapshotMetadata,
            input: "prior history",
          },
        ],
      ]),
      {
        model: "model-a",
        client_metadata: currentMetadata,
        previous_response_id: "resp_metadata_matrix",
        input: "delta",
      },
    )

    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.payload.client_metadata).toEqual(expected)
  },
)
