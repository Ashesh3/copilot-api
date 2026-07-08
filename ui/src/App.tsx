import { AuthGate } from "./AuthGate"
import { useHashRoute } from "./lib/router"
import { ToastProvider } from "./lib/toast"
import { SCREENS } from "./screens/registry"
import { Shell } from "./Shell"

function ActiveScreen() {
  const { section } = useHashRoute()
  const entry = SCREENS[section] ?? SCREENS.overview
  const ScreenComponent = entry.component
  return <ScreenComponent />
}

export function App() {
  return (
    <AuthGate>
      <ToastProvider>
        <Shell>
          <ActiveScreen />
        </Shell>
      </ToastProvider>
    </AuthGate>
  )
}
