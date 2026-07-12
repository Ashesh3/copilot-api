export function resolveApiKeyAuth(
  cliValue: string | undefined,
  environmentValue: string | undefined,
): string | undefined {
  if (cliValue === undefined) return undefined
  if (cliValue !== "" && cliValue !== "true") return cliValue
  if (environmentValue) return environmentValue

  throw new Error(
    "--api-key-auth requires a value or COPILOT_API_KEY_AUTH environment variable",
  )
}
