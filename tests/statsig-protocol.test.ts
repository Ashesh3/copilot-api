import { describe, expect, test } from "bun:test"
import { gzipSync } from "fflate"

import {
  applyStatsigOverrides,
  createFullStatsigInitializeRequest,
  decodeStatsigInitializeBody,
  StatsigProtocolError,
} from "~/routes/statsig-overrides/protocol"

function encodeInitializeBody(
  payload: unknown,
  options: { encoded?: boolean; gzipped?: boolean } = {},
): Uint8Array {
  let bodyText = JSON.stringify(payload)

  if (options.encoded) {
    bodyText = Buffer.from(bodyText, "utf8")
      .toString("base64")
      .split("")
      .reverse()
      .join("")
  }

  const bodyBytes = Buffer.from(bodyText, "utf8")
  return options.gzipped ? gzipSync(bodyBytes) : bodyBytes
}

function expectProtocolError(
  action: () => unknown,
  expectedMessage: string,
): void {
  try {
    action()
    expect.unreachable("Expected StatsigProtocolError")
  } catch (error) {
    expect(error).toBeInstanceOf(StatsigProtocolError)
    expect((error as Error).message).toBe(expectedMessage)
  }
}

function createInitializeResponseFixture() {
  return {
    has_updates: true as const,
    response_format: "init-v1",
    feature_gates: {
      existing_gate: {
        name: "existing_gate",
        value: false,
        rule_id: "upstream-gate-rule",
        exposures: [{ gate: "gate-exposure" }],
        version: 7,
        id_type: "userID",
      },
      untouched_gate: {
        name: "untouched_gate",
        value: true,
        rule_id: "untouched-gate-rule",
        exposures: [{ gate: "untouched-gate-exposure" }],
        version: 2,
      },
    },
    dynamic_configs: {
      existing_config: {
        name: "existing_config",
        value: {
          rollout: 10,
          nested: { enabled: false },
        },
        rule_id: "upstream-config-rule",
        exposures: [{ gate: "config-exposure" }],
        version: 9,
        id_type: "stableID",
      },
      untouched_config: {
        name: "untouched_config",
        value: { cohort: "control" },
        rule_id: "untouched-config-rule",
        exposures: [{ gate: "untouched-config-exposure" }],
        version: 3,
      },
    },
    user: { userID: "user-123" },
  }
}

function createOverridesFixture() {
  return {
    featureGates: {
      existing_gate: true,
      missing_gate: false,
    },
    dynamicConfigs: {
      existing_config: {
        rollout: 100,
        nested: { enabled: true },
      },
      missing_config: {
        cohort: "beta",
        nested: { enabled: true },
      },
    },
  }
}

describe("decodeStatsigInitializeBody", () => {
  test("decodes a plain JSON initialization body", () => {
    const payload = {
      user: { userID: "user-123" },
      statsigMetadata: { stableID: "stable-123" },
      sinceTime: 123,
    }

    expect(
      decodeStatsigInitializeBody(encodeInitializeBody(payload), {
        encoded: false,
        gzipped: false,
      }),
    ).toEqual(payload)
  })

  test("decodes reversed-base64 initialization bodies", () => {
    const payload = {
      user: { userID: "user-123" },
      deltasResponseRequested: true,
    }

    expect(
      decodeStatsigInitializeBody(
        encodeInitializeBody(payload, { encoded: true }),
        {
          encoded: true,
          gzipped: false,
        },
      ),
    ).toEqual(payload)
  })

  test("decodes gzipped reversed-base64 initialization bodies", () => {
    const payload = {
      statsigMetadata: { stableID: "stable-123" },
      full_checksum: "checksum",
    }

    expect(
      decodeStatsigInitializeBody(
        encodeInitializeBody(payload, { encoded: true, gzipped: true }),
        {
          encoded: true,
          gzipped: true,
        },
      ),
    ).toEqual(payload)
  })

  test("decodes gzipped initialization bodies without reversed-base64", () => {
    const payload = {
      previousDerivedFields: { feature_gates: { gate: true } },
      partialUserMatchSinceTime: 456,
    }

    expect(
      decodeStatsigInitializeBody(
        encodeInitializeBody(payload, { gzipped: true }),
        {
          encoded: false,
          gzipped: true,
        },
      ),
    ).toEqual(payload)
  })

  test("rejects reversed-base64 aliases with non-canonical padding bits", () => {
    expectProtocolError(
      () =>
        decodeStatsigInitializeBody(Buffer.from("=13e", "utf8"), {
          encoded: true,
          gzipped: false,
        }),
      "Invalid Statsig initialization body",
    )
  })

  test("rejects malformed bodies and non-object JSON payloads", () => {
    expectProtocolError(
      () =>
        decodeStatsigInitializeBody(Buffer.from("{", "utf8"), {
          encoded: false,
          gzipped: false,
        }),
      "Invalid Statsig initialization body",
    )

    for (const encodedBody of ["", "====", "=03e!", "A=AA"]) {
      expectProtocolError(
        () =>
          decodeStatsigInitializeBody(Buffer.from(encodedBody, "utf8"), {
            encoded: true,
            gzipped: false,
          }),
        "Invalid Statsig initialization body",
      )
    }

    for (const payload of [null, [], true, "text"]) {
      expectProtocolError(
        () =>
          decodeStatsigInitializeBody(encodeInitializeBody(payload), {
            encoded: false,
            gzipped: false,
          }),
        "Statsig initialization body must be a JSON object",
      )
    }
  })
})

describe("createFullStatsigInitializeRequest", () => {
  test("forces a full request while preserving user and client metadata", () => {
    const input = {
      user: {
        userID: "user-123",
        email: "user@example.com",
      },
      statsigMetadata: { stableID: "stable-123", sdkType: "js-client" },
      sinceTime: 987,
      partialUserMatchSinceTime: 654,
      deltasResponseRequested: true,
      full_checksum: "checksum",
      previousDerivedFields: { feature_gates: { gate: true } },
      hash_used: "djb2",
    }

    const output = createFullStatsigInitializeRequest(input)

    expect(output).toEqual({
      user: { userID: "user-123", email: "user@example.com" },
      statsigMetadata: { stableID: "stable-123", sdkType: "js-client" },
      sinceTime: 0,
      partialUserMatchSinceTime: 0,
      deltasResponseRequested: false,
      full_checksum: null,
      previousDerivedFields: {},
      hash_used: "djb2",
    })
    expect(output).not.toBe(input)
    expect(output.user).not.toBe(input.user)
    expect(output.statsigMetadata).not.toBe(input.statsigMetadata)
    expect(input).toEqual({
      user: { userID: "user-123", email: "user@example.com" },
      statsigMetadata: { stableID: "stable-123", sdkType: "js-client" },
      sinceTime: 987,
      partialUserMatchSinceTime: 654,
      deltasResponseRequested: true,
      full_checksum: "checksum",
      previousDerivedFields: { feature_gates: { gate: true } },
      hash_used: "djb2",
    })
  })
})

describe("applyStatsigOverrides", () => {
  test("overlays existing gate and config values while preserving metadata", () => {
    const input = createInitializeResponseFixture()
    const overrides = createOverridesFixture()
    const output = applyStatsigOverrides(input, overrides)

    expect(output).not.toBe(input)
    expect(output.feature_gates.existing_gate).toEqual({
      name: "existing_gate",
      value: true,
      rule_id: "upstream-gate-rule",
      exposures: [{ gate: "gate-exposure" }],
      version: 7,
      id_type: "userID",
    })
    expect(output.dynamic_configs.existing_config).toEqual({
      name: "existing_config",
      value: {
        rollout: 100,
        nested: { enabled: true },
      },
      rule_id: "upstream-config-rule",
      exposures: [{ gate: "config-exposure" }],
      version: 9,
      id_type: "stableID",
    })
    expect(output.feature_gates.untouched_gate).toEqual(
      input.feature_gates.untouched_gate,
    )
    expect(output.dynamic_configs.untouched_config).toEqual(
      input.dynamic_configs.untouched_config,
    )
  })

  test("creates missing entries and does not mutate input or override objects", () => {
    const input = createInitializeResponseFixture()
    const overrides = createOverridesFixture()
    const originalInput = structuredClone(input)
    const originalOverrides = structuredClone(overrides)

    const output = applyStatsigOverrides(input, overrides)

    expect(output.feature_gates.missing_gate).toEqual({
      name: "missing_gate",
      value: false,
      rule_id: "copilot-api-override",
      exposures: [],
    })
    expect(output.dynamic_configs.missing_config).toEqual({
      name: "missing_config",
      value: {
        cohort: "beta",
        nested: { enabled: true },
      },
      rule_id: "copilot-api-override",
      exposures: [],
    })
    expect(output.feature_gates.untouched_gate).toEqual(
      originalInput.feature_gates.untouched_gate,
    )
    expect(output.dynamic_configs.untouched_config).toEqual(
      originalInput.dynamic_configs.untouched_config,
    )
    ;(
      output.dynamic_configs.existing_config.value as {
        nested: { enabled: unknown }
      }
    ).nested.enabled = "changed"
    ;(
      output.dynamic_configs.missing_config.value as {
        nested: { enabled: unknown }
      }
    ).nested.enabled = "mutated"

    expect(input).toEqual(originalInput)
    expect(overrides).toEqual(originalOverrides)
    expect(overrides.dynamicConfigs.existing_config.nested.enabled).toBe(true)
    expect(overrides.dynamicConfigs.missing_config.nested.enabled).toBe(true)
  })

  test("rejects malformed responses and unsupported response formats", () => {
    const overrides = {
      featureGates: {},
      dynamicConfigs: {},
    }

    const cases = [
      {
        input: null,
        message: "Statsig initialization response must be an object",
      },
      {
        input: {
          has_updates: false,
          feature_gates: {},
          dynamic_configs: {},
        },
        message:
          "Statsig initialization response must be a full init-v1 response",
      },
      {
        input: {
          has_updates: true,
          is_delta: true,
          feature_gates: {},
          dynamic_configs: {},
        },
        message: "Statsig delta responses cannot be overridden",
      },
      {
        input: {
          has_updates: true,
          response_format: "init-v2",
          feature_gates: {},
          dynamic_configs: {},
        },
        message: "Unsupported Statsig response format: init-v2",
      },
      {
        input: {
          has_updates: true,
          response_format: "custom-format",
          feature_gates: {},
          dynamic_configs: {},
        },
        message: "Unsupported Statsig response format: custom-format",
      },
      {
        input: {
          has_updates: true,
          response_format: { type: "init-v1" },
          feature_gates: {},
          dynamic_configs: {},
        },
        message: 'Unsupported Statsig response format: {"type":"init-v1"}',
      },
      {
        input: {
          has_updates: true,
          dynamic_configs: {},
        },
        message:
          "Statsig initialization response must include feature_gates and dynamic_configs maps",
      },
      {
        input: {
          has_updates: true,
          feature_gates: [],
          dynamic_configs: {},
        },
        message:
          "Statsig initialization response must include feature_gates and dynamic_configs maps",
      },
      {
        input: {
          has_updates: true,
          feature_gates: {},
          dynamic_configs: null,
        },
        message:
          "Statsig initialization response must include feature_gates and dynamic_configs maps",
      },
      {
        input: {
          has_updates: true,
          feature_gates: { gate: false },
          dynamic_configs: {},
        },
        message: "Statsig feature_gates.gate must be an object",
      },
      {
        input: {
          has_updates: true,
          feature_gates: {},
          dynamic_configs: { config: null },
        },
        message: "Statsig dynamic_configs.config must be an object",
      },
    ]

    for (const testCase of cases) {
      expectProtocolError(
        () => applyStatsigOverrides(testCase.input, overrides),
        testCase.message,
      )
    }
  })
})
