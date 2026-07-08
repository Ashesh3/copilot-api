const STORAGE_KEY = "dashboard_api_key"

export function getApiKey(): string | null {
  return (
    sessionStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(STORAGE_KEY)
  )
}

export function setApiKey(key: string): void {
  sessionStorage.setItem(STORAGE_KEY, key)
  localStorage.setItem(STORAGE_KEY, key)
}

export function clearApiKey(): void {
  sessionStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(STORAGE_KEY)
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function extractErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const data: unknown = await response.clone().json()
    if (data && typeof data === "object" && "error" in data) {
      const error = (data as { error: unknown }).error
      if (typeof error === "string") return error
      if (error && typeof error === "object" && "message" in error) {
        const message = (error as { message: unknown }).message
        if (typeof message === "string") return message
      }
    }
  } catch {
    // fall through to text/fallback below
  }
  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch {
    // ignore
  }
  return fallback
}

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = getApiKey()
  const headers: Record<string, string> = {}
  if (apiKey) headers["x-api-key"] = apiKey
  if (body !== undefined) headers["content-type"] = "application/json"

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!response.ok) {
    const message = await extractErrorMessage(
      response,
      `Request failed with status ${response.status}`,
    )
    throw new ApiError(response.status, message)
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return undefined as T
  }

  return (await response.json()) as T
}

export function get<T>(path: string): Promise<T> {
  return api<T>("GET", path)
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("POST", path, body)
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("PATCH", path, body)
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("PUT", path, body)
}

export function del<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("DELETE", path, body)
}

export async function authProbe(): Promise<unknown> {
  return get("/dashboard/api/overview")
}
