export type RequestJsonResult<T> = { ok: true; value: T } | { ok: false }

export async function readRequestJson<T>(
  read: () => Promise<T>,
): Promise<RequestJsonResult<T>> {
  try {
    return { ok: true, value: await read() }
  } catch {
    return { ok: false }
  }
}
