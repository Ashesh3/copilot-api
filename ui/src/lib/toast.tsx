import type { ReactNode } from "react"

import { LayerProvider } from "@astryxdesign/core/Layer"
import { useToast as useAstryxToast } from "@astryxdesign/core/Toast"

// Wraps Astryx's LayerProvider so the toast viewport is mounted once, in a
// known place, instead of useToast falling back to a self-mounted viewport
// (which also logs a console warning).
export function ToastProvider({ children }: { children: ReactNode }) {
  return <LayerProvider>{children}</LayerProvider>
}

export interface ToastApi {
  success: (message: string) => void
  error: (message: string) => void
}

export function useToast(): ToastApi {
  const toast = useAstryxToast()

  return {
    success: (message: string) => {
      toast({ body: message, type: "info" })
    },
    error: (message: string) => {
      toast({ body: message, type: "error" })
    },
  }
}
