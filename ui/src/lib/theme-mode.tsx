import type { ReactNode } from "react"

import { Theme } from "@astryxdesign/core/theme"
import { neutralTheme } from "@astryxdesign/theme-neutral/built"
import { createContext, use, useMemo, useState } from "react"

export type ThemeMode = "dark" | "light"

const STORAGE_KEY = "dashboard_theme_mode"

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "light" || stored === "dark") return stored
  } catch {
    // localStorage may be unavailable; fall through to default
  }
  return "dark"
}

interface ThemeModeContextValue {
  mode: ThemeMode
  toggle: () => void
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null)

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode)

  const value = useMemo<ThemeModeContextValue>(
    () => ({
      mode,
      toggle: () =>
        setMode((current) => {
          const next = current === "dark" ? "light" : "dark"
          try {
            localStorage.setItem(STORAGE_KEY, next)
          } catch {
            // ignore persistence failures
          }
          return next
        }),
    }),
    [mode],
  )

  return (
    <ThemeModeContext value={value}>
      <Theme theme={neutralTheme} mode={mode}>
        {children}
      </Theme>
    </ThemeModeContext>
  )
}

export function useThemeMode(): ThemeModeContextValue {
  const value = use(ThemeModeContext)
  if (!value) {
    throw new Error("useThemeMode must be used within ThemeModeProvider")
  }
  return value
}
