import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Tooltip } from "@astryxdesign/core/Tooltip"

import type { LlmFallbackContext } from "../lib/llm-fallback"

import { InfoIcon } from "../icons"
import { fallbackIndicators } from "../lib/llm-fallback"

export { fallbackDescription } from "../lib/llm-fallback"

export function LlmFallbackBadge(context: LlmFallbackContext) {
  return (
    <>
      {fallbackIndicators(context).map((indicator) => (
        <Tooltip
          key={indicator.key}
          focusTrigger="always"
          content={
            <span className="llm-fallback-tooltip">
              {indicator.description}
            </span>
          }
        >
          <span
            tabIndex={0}
            title={indicator.label}
            style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%" }}
          >
            <Badge
              variant={indicator.tone}
              style={{
                boxSizing: "border-box",
                height: "auto",
                minHeight: "var(--spacing-5)",
                minWidth: 0,
                maxWidth: "100%",
                whiteSpace: "normal",
                overflowWrap: "anywhere",
              }}
              label={
                <span
                  style={{
                    minWidth: 0,
                    whiteSpace: "normal",
                    overflowWrap: "anywhere",
                    lineHeight: "var(--text-supporting-leading)",
                  }}
                >
                  {indicator.label}
                </span>
              }
              icon={
                <InfoIcon
                  width={14}
                  height={14}
                  style={{ flexShrink: 0 }}
                  aria-hidden="true"
                />
              }
            />
          </span>
        </Tooltip>
      ))}
    </>
  )
}

export function LlmFallbackBanner(context: LlmFallbackContext) {
  return (
    <>
      {fallbackIndicators(context).map((indicator) => (
        <Banner
          key={indicator.key}
          status={indicator.tone === "neutral" ? "info" : indicator.tone}
          title={indicator.label}
          description={indicator.description}
          endContent={
            indicator.previousLogId ?
              <Button
                label="Open previous capture"
                variant="secondary"
                size="sm"
                href={`#llm-debug:${encodeURIComponent(indicator.previousLogId)}`}
              />
            : undefined
          }
        />
      ))}
    </>
  )
}
