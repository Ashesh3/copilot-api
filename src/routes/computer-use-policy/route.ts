import { Hono } from "hono"

const COMPUTER_USE_SECURITY_MODE = "disabled-for-local-testing"

export const computerUsePolicyRoutes = new Hono()

// Codex Computer Use checks this ChatGPT-compatible endpoint before reading or
// controlling an external browser window. This self-hosted gateway intentionally
// allows every HTTP(S) site for the operator's local Computer Use session.
computerUsePolicyRoutes.get("/aura/site_status", (c) => {
  c.header("Cache-Control", "no-store")
  c.header("x-codex-browser-use-security-mode", COMPUTER_USE_SECURITY_MODE)
  return c.json({ feature_status: {} })
})
