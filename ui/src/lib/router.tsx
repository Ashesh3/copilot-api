import { useEffect, useState } from "react"

export interface HashRoute {
  section: string
  param?: string
}

const DEFAULT_SECTION = "overview"

function parseHash(hash: string): HashRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  if (!raw) return { section: DEFAULT_SECTION }

  const separatorIndex = raw.indexOf(":")
  if (separatorIndex === -1) return { section: raw }

  const section = raw.slice(0, separatorIndex)
  const param = raw.slice(separatorIndex + 1)
  return { section: section || DEFAULT_SECTION, param: param || undefined }
}

export function navigate(section: string, param?: string): void {
  globalThis.location.hash = param ? `${section}:${param}` : section
}

export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<HashRoute>(() =>
    parseHash(globalThis.location.hash),
  )

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(globalThis.location.hash))
    globalThis.addEventListener("hashchange", onHashChange)
    return () => globalThis.removeEventListener("hashchange", onHashChange)
  }, [])

  return route
}
