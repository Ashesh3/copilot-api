import type { ReactNode } from "react"

import { AppShell } from "@astryxdesign/core/AppShell"
import { IconButton } from "@astryxdesign/core/IconButton"
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav"

import {
  ArrowRightLeftIcon,
  BugIcon,
  ChartBarIcon,
  CopilotIcon,
  FlagIcon,
  GaugeIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  Repeat2Icon,
  RouteIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SunIcon,
} from "./icons"
import { useHashRoute } from "./lib/router"
import { useThemeMode } from "./lib/theme-mode"

interface NavEntry {
  section: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

const MONITOR_ITEMS: Array<NavEntry> = [
  { section: "overview", label: "Overview", icon: GaugeIcon },
  { section: "sessions", label: "Sessions", icon: MessageSquareIcon },
  { section: "environments", label: "Environments", icon: MonitorIcon },
  { section: "llm-debug", label: "LLM Debug", icon: BugIcon },
  { section: "usage", label: "Usage", icon: ChartBarIcon },
]

const CONTROL_ITEMS: Array<NavEntry> = [
  { section: "flags", label: "Feature Flags", icon: FlagIcon },
  { section: "replacements", label: "Replacements", icon: Repeat2Icon },
  {
    section: "model-redirects",
    label: "Model Redirects",
    icon: ArrowRightLeftIcon,
  },
  {
    section: "model-settings",
    label: "Model Settings",
    icon: SlidersHorizontalIcon,
  },
  { section: "custom-providers", label: "Custom Providers", icon: PlugIcon },
  { section: "model-routing", label: "Model Routing", icon: RouteIcon },
]

const SYSTEM_ITEMS: Array<NavEntry> = [
  { section: "settings", label: "Settings", icon: SettingsIcon },
]

function NavItems({
  items,
  currentSection,
}: {
  items: Array<NavEntry>
  currentSection: string
}) {
  return (
    <>
      {items.map((item) => (
        <SideNavItem
          key={item.section}
          label={item.label}
          icon={item.icon}
          href={`#${item.section}`}
          isSelected={currentSection === item.section}
        />
      ))}
    </>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { section } = useHashRoute()
  const { mode, toggle } = useThemeMode()

  return (
    <AppShell
      height="fill"
      contentPadding={0}
      variant="elevated"
      sideNav={
        <SideNav
          collapsible
          header={
            <SideNavHeading
              heading="Copilot API"
              subheading="Admin Dashboard"
              icon={<CopilotIcon />}
              headingHref="#overview"
            />
          }
          footerIcons={
            <IconButton
              label={
                mode === "dark" ? "Switch to light mode" : "Switch to dark mode"
              }
              tooltip={mode === "dark" ? "Light mode" : "Dark mode"}
              variant="ghost"
              icon={mode === "dark" ? <SunIcon /> : <MoonIcon />}
              onClick={toggle}
            />
          }
        >
          <SideNavSection title="Monitor">
            <NavItems items={MONITOR_ITEMS} currentSection={section} />
          </SideNavSection>
          <SideNavSection title="Control">
            <NavItems items={CONTROL_ITEMS} currentSection={section} />
          </SideNavSection>
          <SideNavSection title="System">
            <NavItems items={SYSTEM_ITEMS} currentSection={section} />
          </SideNavSection>
        </SideNav>
      }
    >
      {children}
    </AppShell>
  )
}
