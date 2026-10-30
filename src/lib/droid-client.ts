/** Factory's Droid sends this user agent on requests to BYOK custom models. */
const DROID_USER_AGENT = /^factory-cli\//iu

/** Whether a request comes from Factory's Droid. */
export function isDroidRequest(headers: Headers): boolean {
  return DROID_USER_AGENT.test(headers.get("user-agent")?.trim() ?? "")
}
