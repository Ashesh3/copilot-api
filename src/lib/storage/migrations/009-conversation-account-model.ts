import { accountDistributionTables } from "~/lib/storage/migrations/007-account-distribution"

const modelColumn =
  "model_id TEXT CHECK (model_id IS NULL OR (typeof(model_id) = 'text' AND length(model_id) > 0))"

export const conversationAccountModelTables = {
  capi_conversation_accounts: `${accountDistributionTables.capi_conversation_accounts},\n    ${modelColumn}`,
} as const

/** Existing owners have no model provenance until an inference is admitted. */
export const conversationAccountModelMigration = {
  version: 9,
  name: "conversation-account-model",
  statements: [
    `ALTER TABLE capi_conversation_accounts ADD COLUMN ${modelColumn}`,
  ],
} as const
