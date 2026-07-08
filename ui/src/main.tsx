import "@astryxdesign/core/reset.css"
import "@astryxdesign/core/astryx.css"
import "@astryxdesign/theme-neutral/theme.css"

import "./global.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { ThemeModeProvider } from "./lib/theme-mode"

const container = document.querySelector("#root")
if (!container) {
  throw new Error("Root element #root not found")
}

createRoot(container).render(
  <StrictMode>
    <ThemeModeProvider>
      <App />
    </ThemeModeProvider>
  </StrictMode>,
)
