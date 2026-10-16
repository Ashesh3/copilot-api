import { expect, test } from "bun:test"

import { isGithubOrigin } from "./helpers/github-origin"

test.each([
  "https://githubcopilot.com/responses",
  "https://api.githubcopilot.com/responses",
  "https://api.enterprise.githubcopilot.com/responses",
  "https://API.GITHUBCOPILOT.COM/responses",
])("GitHub egress guard permits %s", (url) => {
  expect(isGithubOrigin(new URL(url))).toBe(true)
})

test.each([
  "https://evilgithubcopilot.com/responses",
  "https://api.evilgithubcopilot.com/responses",
  "https://githubcopilot.com.evil.test/responses",
  "https://githubcopilot.com@evil.test/responses",
  "https://pages.test/guide",
  "http://api.githubcopilot.com/responses",
  "ftp://api.githubcopilot.com/responses",
])("GitHub egress guard blocks %s", (url) => {
  expect(isGithubOrigin(new URL(url))).toBe(false)
  expect(isGithubOrigin(new URL(url), { allowGithubApi: true })).toBe(false)
})

test("GitHub API access requires an explicit exception", () => {
  const url = new URL("https://api.github.com/user")
  expect(isGithubOrigin(url)).toBe(false)
  expect(isGithubOrigin(url, { allowGithubApi: true })).toBe(true)
})

test.each([
  "http://api.github.com/user",
  "https://evilapi.github.com/user",
  "https://api.github.com.evil.test/user",
  "https://api.github.com@evil.test/user",
])("GitHub API exception still blocks %s", (url) => {
  expect(isGithubOrigin(new URL(url), { allowGithubApi: true })).toBe(false)
})
