import { Tooltip } from "@astryxdesign/core/Tooltip"
import { Fragment, useMemo } from "react"

import type { FallbackPath } from "../lib/fallback-graph"
import type { ModelFallbackRule, ModelRedirect } from "../lib/types"

import { AlertTriangleIcon, PencilIcon, PlusIcon } from "../icons"
import { buildFallbackGraph } from "../lib/fallback-graph"
import { findFallbackRedirectSources } from "../lib/fallback-redirects"
import { IconAction } from "./common"

interface FallbackChainsProps {
  rules: Array<ModelFallbackRule>
  redirects: Array<ModelRedirect>
  selectedStart: string
  isSaving: boolean
  onSelect: (model: string) => void
  onEdit: (rule: ModelFallbackRule) => void
  onAdd: (sourceModel: string) => void
}

function Connector({ disabled = false }: { disabled?: boolean }) {
  return (
    <svg
      className="fallback-connector"
      data-disabled={disabled || undefined}
      width="12"
      height="24"
      viewBox="0 0 12 24"
      aria-hidden="true"
    >
      <path
        d="M6 0v23m-3-3 3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RedirectContext({
  models,
  redirects,
}: {
  models: Array<string>
  redirects: Array<ModelRedirect>
}) {
  const sources = useMemo(
    () => findFallbackRedirectSources(models, redirects),
    [models, redirects],
  )
  if (sources.length === 0) return null
  return (
    <p className="fallback-redirect-context">
      Also redirects here:{" "}
      {sources.map((source, index) => (
        <Fragment key={source.sourceModel}>
          {index > 0 && (index === sources.length - 1 ? " and " : ", ")}
          <Tooltip
            content={
              <span className="fallback-redirect-tooltip">
                Configured redirects can enter at{" "}
                {source.targetModels.join(", ")}. Matching depends on rule order
                and request effort
                {source.efforts.length > 0 ?
                  ` (${source.efforts.join(", ")})`
                : ""}
                {source.modelOnly ? "; model-only requests can also match" : ""}
                . Open Model Redirects to review.
              </span>
            }
          >
            <a className="fallback-context-link" href="#model-redirects">
              {source.sourceModel}
            </a>
          </Tooltip>
        </Fragment>
      ))}
    </p>
  )
}

export function FallbackChains({
  rules,
  redirects,
  selectedStart,
  isSaving,
  onSelect,
  onEdit,
  onAdd,
}: FallbackChainsProps) {
  const graph = useMemo(() => buildFallbackGraph(rules), [rules])
  const displayedRuleIds = new Set(
    graph.flatMap((group) => group.routes.flatMap((route) => route.ruleIds)),
  )
  const extraRules = rules.filter((rule) => !displayedRuleIds.has(rule.id))

  function modelButton(model: string) {
    return (
      <button
        type="button"
        className="fallback-model-button"
        aria-label={`Preview path from ${model}`}
        aria-pressed={selectedStart === model}
        onClick={() => onSelect(model)}
      >
        <code>{model}</code>
        {selectedStart === model ?
          <small>Preview start</small>
        : null}
      </button>
    )
  }

  function routeStop(route: FallbackPath) {
    if (route.stop === "shared")
      return (
        <div className="fallback-junction">
          <span>Joins the shared continuation at</span>
          <button
            type="button"
            className="fallback-inline-model"
            onClick={() => onSelect(route.joinsAt ?? "")}
          >
            <code>{route.joinsAt}</code>
          </button>
          <span>
            Shown in the chain starting at <code>{route.sharedWith}</code>.
          </span>
        </div>
      )
    if (route.stop === "loop")
      return (
        <p className="fallback-route-stop fallback-route-loop">
          <AlertTriangleIcon width={16} height={16} aria-hidden="true" />
          <span>
            Loop at <code>{route.loopAt}</code>. All redirects and fallbacks
            pause until corrected.
          </span>
        </p>
      )
    return <p className="fallback-route-stop">End of chain</p>
  }

  return (
    <>
      <div className="fallback-groups">
        {graph.flatMap((group) =>
          group.routes
            .filter(
              (route) => route.models.length > 0 && route.ruleIds.length > 0,
            )
            .map((route) => (
              <section
                className="fallback-chain"
                data-start-model={route.start}
                aria-label={`Configured chain starting at ${route.start}`}
                key={`${group.id}-${route.start}`}
              >
                <div className="fallback-chain-label">
                  <span>Starting model</span>
                  <span>
                    {route.ruleIds.length} fallback
                    {route.ruleIds.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ol
                  className="fallback-chain-list"
                  aria-label={`Configured path from ${route.start}`}
                >
                  {route.models.map((model, index) => {
                    const rule = group.rules.find(
                      (candidate) => candidate.id === route.ruleIds[index],
                    )
                    const terminal =
                      index === route.models.length - 1 && route.stop === "end"
                    return (
                      <li key={model}>
                        <div
                          className="fallback-chain-node"
                          data-selected={selectedStart === model}
                        >
                          {modelButton(model)}
                          <span className="fallback-node-action">
                            {rule ?
                              <IconAction
                                label={`Edit fallback for ${model}`}
                                icon={<PencilIcon />}
                                isDisabled={isSaving}
                                onClick={() => onEdit(rule)}
                              />
                            : null}
                            {!rule && terminal ?
                              <IconAction
                                label={`Add fallback for ${model}`}
                                icon={<PlusIcon />}
                                isDisabled={isSaving}
                                onClick={() => onAdd(model)}
                              />
                            : null}
                          </span>
                        </div>
                        {!terminal ?
                          <Connector />
                        : null}
                      </li>
                    )
                  })}
                </ol>
                {routeStop(route)}
                <RedirectContext models={route.models} redirects={redirects} />
              </section>
            )),
        )}
      </div>
      {extraRules.length > 0 ?
        <section
          className="fallback-additional"
          aria-label="Additional configured rules"
        >
          <p className="fallback-additional-label">
            Additional configured rules
          </p>
          <p className="fallback-secondary">
            Disabled or duplicate links remain editable without joining the
            active chains.
          </p>
          <ul className="fallback-extra-rules">
            {extraRules.map((rule) => (
              <li key={rule.id}>
                <div className="fallback-extra-heading">
                  <span>{rule.enabled ? "Additional link" : "Disabled"}</span>
                  <IconAction
                    label={`Edit ${rule.enabled ? "additional" : "disabled"} fallback from ${rule.sourceModel} to ${rule.targetModel}`}
                    icon={<PencilIcon />}
                    isDisabled={isSaving}
                    onClick={() => onEdit(rule)}
                  />
                </div>
                <div
                  className="fallback-extra-path"
                  data-disabled={!rule.enabled}
                >
                  {modelButton(rule.sourceModel)}
                  <Connector disabled={!rule.enabled} />
                  {modelButton(rule.targetModel)}
                </div>
              </li>
            ))}
          </ul>
        </section>
      : null}
    </>
  )
}
