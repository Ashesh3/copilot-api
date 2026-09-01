import { expect, test } from "bun:test"

import {
  defaultCopilotApiBaseUrl,
  formatGitHubCredential,
  githubApiBaseUrl,
  isGitHubEnterpriseCloud,
  normalizeGitHubDomain,
  parseGitHubCredential,
  parseGitHubCredentials,
  resolveCopilotApiBaseUrl,
} from "../src/lib/github-instance"

test("parses mixed public and enterprise token entries", () => {
  expect(
    parseGitHubCredentials(
      "msft.ghe.com:enterprise-one,token-one,github.ghe.com:enterprise-two,token-two",
    ),
  ).toEqual([
    { instanceDomain: "msft.ghe.com", token: "enterprise-one" },
    { instanceDomain: "github.com", token: "token-one" },
    { instanceDomain: "github.ghe.com", token: "enterprise-two" },
    { instanceDomain: "github.com", token: "token-two" },
  ])
})

test("normalizes enterprise URLs and formats environment entries", () => {
  expect(normalizeGitHubDomain("HTTPS://MSFT.GHE.COM/")).toBe("msft.ghe.com")
  const credential = parseGitHubCredential("MSFT.GHE.COM:github_pat_example")
  expect(credential).toEqual({
    instanceDomain: "msft.ghe.com",
    token: "github_pat_example",
  })
  expect(formatGitHubCredential(credential)).toBe(
    "msft.ghe.com:github_pat_example",
  )
  expect(
    formatGitHubCredential({
      instanceDomain: "github.com",
      token: "gho_public",
    }),
  ).toBe("gho_public")
})

test("rejects unsupported or path-bearing GitHub hosts", () => {
  expect(() => normalizeGitHubDomain("github.example.com")).toThrow(
    "github.com or a GitHub Enterprise Cloud",
  )
  expect(() => normalizeGitHubDomain("https://msft.ghe.com/path")).toThrow(
    "without a path",
  )
  expect(() => parseGitHubCredential("msft.ghe.com:")).toThrow(
    "token is required",
  )
})

test("derives GitHub and Copilot endpoints for GHE Cloud", () => {
  expect(isGitHubEnterpriseCloud("github.com")).toBe(false)
  expect(isGitHubEnterpriseCloud("msft.ghe.com")).toBe(true)
  expect(githubApiBaseUrl("github.com")).toBe("https://api.github.com")
  expect(githubApiBaseUrl("msft.ghe.com")).toBe("https://api.msft.ghe.com")
  expect(defaultCopilotApiBaseUrl("msft.ghe.com")).toBe(
    "https://copilot-api.msft.ghe.com",
  )
})

test("prefers the discovered Copilot endpoint and keeps public SKU fallback", () => {
  expect(
    resolveCopilotApiBaseUrl(
      "msft.ghe.com",
      "https://copilot-api.msft.ghe.com/",
      "enterprise",
    ),
  ).toBe("https://copilot-api.msft.ghe.com")
  expect(resolveCopilotApiBaseUrl("github.com", undefined, "business")).toBe(
    "https://api.business.githubcopilot.com",
  )
  expect(
    resolveCopilotApiBaseUrl(
      "msft.ghe.com",
      "https://credential-stealer.example",
      "enterprise",
    ),
  ).toBe("https://copilot-api.msft.ghe.com")
})
