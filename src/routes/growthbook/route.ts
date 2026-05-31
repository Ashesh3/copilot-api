import { Hono } from "hono"

import { requireIpAllowlist } from "~/lib/ip-allowlist-guard"
import { getFeatureFlags } from "~/routes/feature-flags/store"

export const growthbookRoutes = new Hono()

// Feature-flag eval reveals every configured tengu_* override. Gate it on
// the IP allowlist so an unauthenticated drive-by can't fingerprint the
// admin's Claude-Code config.
growthbookRoutes.use("*", requireIpAllowlist)

// GrowthBook remote eval endpoint
// Claude Code's GrowthBook SDK sends POST /api/eval/{clientKey}
growthbookRoutes.post("/:clientKey", (c) => {
  const flags = getFeatureFlags()

  // Transform { name: value } into GrowthBook features format
  // { name: { defaultValue: value } }
  const features: Record<string, { defaultValue: unknown }> = {}
  for (const [key, value] of Object.entries(flags)) {
    features[key] = { defaultValue: value }
  }

  return c.json({ features })
})
