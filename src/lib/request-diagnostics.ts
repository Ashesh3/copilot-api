const GOOGLE_MODEL_ROUTE_REFERENCE =
  /(\/(?:v1beta\/models|v1\/models|models)\/)([^/?#\s"'<>]+)\/?(?=$|[?#\s"'<>])/gi
const GOOGLE_MODEL_ACTION_PATH =
  /^\/(?:v1beta\/models|v1\/models|models)\/[^/?#]+\/?(?:[?#].*)?$/i
const SUPPORTED_GOOGLE_MODEL_ACTION_PATH =
  /^\/(?:v1beta\/models|v1\/models|models)\/[^/?#]+:(?:generateContent|streamGenerateContent)$/

/**
 * Replace the private Google model/action segment with the registered route
 * template while retaining safe surrounding diagnostics such as method and
 * query parameters.
 */
export function sanitizeRequestDiagnosticReference(
  method: string,
  value: string,
): string {
  if (method.toUpperCase() !== "POST") return value
  return value.replaceAll(
    GOOGLE_MODEL_ROUTE_REFERENCE,
    (match, prefix: string, segment: string) =>
      isGoogleModelActionRequest(method, `${prefix}${segment}`) ?
        `${prefix}:modelAction`
      : match,
  )
}

export function isGoogleModelActionPath(value: string): boolean {
  return GOOGLE_MODEL_ACTION_PATH.test(value)
}

export function isGoogleModelActionRequest(
  method: string,
  path: string,
): boolean {
  if (method.toUpperCase() !== "POST" || !isGoogleModelActionPath(path)) {
    return false
  }
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/$/, "")
  const segment = pathname.slice(pathname.lastIndexOf("/") + 1)
  return segment.includes(":") || !["intent", "session"].includes(segment)
}

/**
 * Unknown actions and paths that cannot reach the mounted Google handler must
 * be classified before debug logging considers cloning or reading the body.
 */
export function shouldOmitRequestBodyFromDiagnostics(path: string): boolean {
  if (!isGoogleModelActionPath(path)) return false
  return !SUPPORTED_GOOGLE_MODEL_ACTION_PATH.test(path)
}
