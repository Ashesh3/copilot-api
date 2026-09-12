import { z } from "zod"

// Combined boundary consumed by Desktop's principal parser and account-info
// decoder, extracted from MSIX 26.908.4834.0 on 2026-09-12. The principal parser
// requires positive integer exp and nonempty identity strings; account-info
// additionally requires the chatgpt_* names and a plan. MSIX 26.903.9818.0
// decoded account-info directly, without the principal prerequisite.
// UUIDs, audience arrays, and user_id are not required by this boundary.
export const codexDesktopAccountInput = z.object({
  exp: z.number().int().positive(),
  "https://api.openai.com/auth": z.object({
    chatgpt_account_id: z.string().min(1),
    chatgpt_user_id: z.string().min(1),
    chatgpt_plan_type: z.string(),
    user_id: z.string().min(1).optional(),
  }),
})
