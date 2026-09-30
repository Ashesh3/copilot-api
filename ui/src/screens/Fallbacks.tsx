import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useMemo, useRef, useState } from "react"

import type {
  ModelFallbackConfig,
  ModelFallbackRule,
  ModelFallbackSettings,
  ModelRedirect,
} from "../lib/types"

import { ConfirmButton, EmptyState, IconAction } from "../components/common"
import { ModelRoutingWarning } from "../components/ModelRoutingWarning"
import { Page } from "../components/Page"
import { ResponsivePair } from "../components/ResponsivePair"
import {
  AlertTriangleIcon,
  FallbackIcon,
  PencilIcon,
  Trash2Icon,
} from "../icons"
import { api, ApiError, get } from "../lib/api"
import {
  applyFallbackDraft,
  buildFallbackGraph,
  findImpactedStarts,
  traceFallbackPath,
} from "../lib/fallback-graph"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

interface RuleForm {
  id: string | null
  sourceModel: string
  targetModel: string
}

interface FallbackPageData extends ModelFallbackSettings {
  redirects: Array<ModelRedirect>
  redirectsUnavailable: boolean
}

const EMPTY_RULE: RuleForm = { id: null, sourceModel: "", targetModel: "" }

async function loadFallbacks(): Promise<FallbackPageData> {
  const settings = await get<ModelFallbackSettings>("/dashboard/api/fallbacks")
  try {
    const redirects = await get<Array<ModelRedirect>>(
      "/dashboard/api/model-redirects",
    )
    return { ...settings, redirects, redirectsUnavailable: false }
  } catch {
    return { ...settings, redirects: [], redirectsUnavailable: true }
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function fieldError(message: string | undefined) {
  return message ? { type: "error" as const, message } : undefined
}

function createDraftRule(
  form: RuleForm,
  current: ModelFallbackRule | undefined,
): ModelFallbackRule {
  return {
    id: form.id ?? "fallback-draft",
    sourceModel: form.sourceModel.trim(),
    targetModel: form.targetModel.trim(),
    enabled: current?.enabled ?? true,
  }
}

function FallbackControls({
  initial,
  onBusyChange,
}: {
  initial: FallbackPageData
  onBusyChange: (busy: boolean) => void
}) {
  const toast = useToast()
  const [settings, setSettings] = useState(initial)
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE)
  const [selectedStart, setSelectedStart] = useState(
    initial.config.rules[0]?.sourceModel ?? "",
  )
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [refreshConflict, setRefreshConflict] = useState<string>()
  const [ruleErrors, setRuleErrors] = useState<{
    sourceModel?: string
    targetModel?: string
  }>({})
  const sourceRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const config = settings.config
  const graph = useMemo(() => buildFallbackGraph(config.rules), [config.rules])
  const requestPath =
    selectedStart ? traceFallbackPath(selectedStart, config.rules) : undefined
  const currentRule = config.rules.find((rule) => rule.id === form.id)
  const draftRule = createDraftRule(form, currentRule)
  const draftRules =
    form.id ?
      applyFallbackDraft(config.rules, draftRule)
    : [...config.rules, draftRule]
  const impactedStarts =
    form.sourceModel.trim() && form.targetModel.trim() ?
      findImpactedStarts(config.rules, draftRules)
    : []
  const enabledRedirects = settings.redirects.filter(
    (redirect) => redirect.enabled,
  )

  useEffect(() => {
    if (form.id) sourceRef.current?.focus()
  }, [form.id])

  useEffect(() => {
    if (form.id) {
      const before = settings.config.rules.find((rule) => rule.id === form.id)
      const after = initial.config.rules.find((rule) => rule.id === form.id)
      if (!after || JSON.stringify(before) !== JSON.stringify(after))
        // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- Preserve the draft while marking the refreshed backing rule stale.
        setRefreshConflict(
          "This rule changed or was removed while you were editing. Your draft is preserved; cancel and reopen the latest rule before saving.",
        )
    }
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- Explicit refresh replaces only the backing server snapshot.
    setSettings(initial)
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- Preserve the selected start unless the initial load had no selection.
    setSelectedStart(
      (current) => current || initial.config.rules[0]?.sourceModel || "",
    )
    // Only a refreshed settings payload should update the backing snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  function startMutation() {
    if (busyRef.current) return false
    busyRef.current = true
    setIsSaving(true)
    onBusyChange(true)
    setSaveError(undefined)
    return true
  }

  function finishMutation() {
    busyRef.current = false
    setIsSaving(false)
    onBusyChange(false)
  }

  async function save(next: ModelFallbackConfig, message: string) {
    if (!startMutation()) return false
    try {
      const result = await api<ModelFallbackSettings>(
        "PUT",
        "/dashboard/api/fallbacks",
        next,
        { expectedRevision: settings.revision },
      )
      setSettings((current) => ({ ...current, ...result }))
      toast.success(message)
      return true
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 409 ?
          "Fallback settings changed on the server. Refresh, review the latest paths, and apply your edit again."
        : errorMessage(error, "Failed to save fallback settings")
      setSaveError(message)
      toast.error(message)
      return false
    } finally {
      finishMutation()
    }
  }

  function editRule(rule: ModelFallbackRule) {
    setForm({
      id: rule.id,
      sourceModel: rule.sourceModel,
      targetModel: rule.targetModel,
    })
    setRuleErrors({})
    setRefreshConflict(undefined)
  }

  function cancelEdit() {
    setForm(EMPTY_RULE)
    setRuleErrors({})
    setRefreshConflict(undefined)
  }

  async function saveRule() {
    const sourceModel = form.sourceModel.trim()
    const targetModel = form.targetModel.trim()
    const duplicate = config.rules.some(
      (rule) =>
        rule.id !== form.id && rule.enabled && rule.sourceModel === sourceModel,
    )
    let sourceError: string | undefined
    let targetError: string | undefined
    if (!sourceModel) sourceError = "Enter the model that may return HTTP 422."
    else if (sourceModel.length > 256)
      sourceError = "Use a model ID with at most 256 characters."
    else if (duplicate && (currentRule?.enabled ?? true))
      sourceError = "This source model already has an enabled fallback."
    if (!targetModel) targetError = "Enter the alternate model."
    else if (targetModel.length > 256)
      targetError = "Use a model ID with at most 256 characters."
    else if (sourceModel === targetModel)
      targetError = "Choose a different model for the fallback."
    setRuleErrors({ sourceModel: sourceError, targetModel: targetError })
    if (sourceError || targetError) {
      if (sourceError) sourceRef.current?.focus()
      else targetRef.current?.focus()
      return
    }
    if (refreshConflict) return

    const rule: ModelFallbackRule = {
      ...draftRule,
      id: form.id ?? `fallback-${crypto.randomUUID()}`,
    }
    const rules =
      form.id ?
        config.rules.map((existing) =>
          existing.id === form.id ? rule : existing,
        )
      : [...config.rules, rule]
    if (
      await save(
        { ...config, rules },
        form.id ? "Fallback updated" : "Fallback added",
      )
    ) {
      if (!form.id) setSelectedStart(sourceModel)
      cancelEdit()
    }
  }

  async function deleteRule(id: string) {
    const success = await save(
      { ...config, rules: config.rules.filter((rule) => rule.id !== id) },
      "Fallback deleted",
    )
    if (!success) throw new Error("Failed to delete fallback")
    if (form.id === id) cancelEdit()
  }

  async function toggleRule(rule: ModelFallbackRule, enabled: boolean) {
    await save(
      {
        ...config,
        rules: config.rules.map((current) =>
          current.id === rule.id ? { ...current, enabled } : current,
        ),
      },
      enabled ? "Fallback rule enabled" : "Fallback rule disabled",
    )
  }

  function routeStop(route: (typeof graph)[number]["routes"][number]) {
    if (route.stop === "shared")
      return (
        <p className="fallback-route-stop">
          Joins the shared continuation at{" "}
          <button
            type="button"
            className="fallback-inline-model"
            onClick={() => setSelectedStart(route.joinsAt ?? "")}
          >
            {route.joinsAt}
          </button>
          , shown from {route.sharedWith}.
        </p>
      )
    if (route.stop === "loop")
      return (
        <p className="fallback-route-stop fallback-route-loop">
          <AlertTriangleIcon width={16} height={16} aria-hidden="true" />
          Loop detected at {route.loopAt}. Routing safety pauses all redirects
          and fallbacks until it is corrected.
        </p>
      )
    return <p className="fallback-route-stop">End of configured path.</p>
  }

  function requestPathDescription(): string {
    if (!config.enabled)
      return "Automatic fallback is off, so only the starting model is attempted."
    if (requestPath?.stop === "loop")
      return "Stops at the repeated model because a loop was detected."
    return "This shows configured fallback links only. Runtime provider aliases, effort routing, success, and non-422 responses can stop or alter the effective route."
  }

  function inlineRuleEditor(rule: ModelFallbackRule) {
    if (form.id !== rule.id) return null
    return (
      <div className="fallback-inline-editor" aria-label="Edit fallback rule">
        <ResponsivePair minWidth={220}>
          <TextInput
            ref={sourceRef}
            label="Source model"
            description="Exact model ID after applicable redirects."
            value={form.sourceModel}
            onChange={(sourceModel) =>
              setForm((current) => ({ ...current, sourceModel }))
            }
            isRequired
            isDisabled={isSaving}
            status={fieldError(ruleErrors.sourceModel)}
          />
          <TextInput
            ref={targetRef}
            label="Alternate model"
            description="The model to try after HTTP 422."
            value={form.targetModel}
            onChange={(targetModel) =>
              setForm((current) => ({ ...current, targetModel }))
            }
            isRequired
            isDisabled={isSaving}
            status={fieldError(ruleErrors.targetModel)}
          />
        </ResponsivePair>
        {impactedStarts.length > 0 ?
          <details className="fallback-impact" open>
            <summary>
              {impactedStarts.length} request start
              {impactedStarts.length === 1 ? "" : "s"} would change
            </summary>
            <ul>
              {impactedStarts.map((start) => (
                <li key={start}>
                  <code>{start}</code>:{" "}
                  {traceFallbackPath(start, draftRules).models.join(" → ")}
                </li>
              ))}
            </ul>
          </details>
        : null}
        <HStack hAlign="between" gap={2} wrap="wrap">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Switch
              label={`Enable fallback for ${rule.sourceModel}`}
              value={rule.enabled}
              isDisabled={isSaving}
              changeAction={async (enabled) => toggleRule(rule, enabled)}
            />
            <ConfirmButton
              label="Delete rule"
              confirmTitle="Delete fallback rule?"
              confirmDescription={`Remove the fallback from ${rule.sourceModel} to ${rule.targetModel}.`}
              confirmActionLabel="Delete"
              variant="destructive"
              size="sm"
              icon={<Trash2Icon />}
              isDisabled={isSaving}
              onConfirm={() => deleteRule(rule.id)}
            />
          </HStack>
          <HStack gap={2}>
            <Button
              label="Cancel"
              variant="ghost"
              isDisabled={isSaving}
              onClick={cancelEdit}
            />
            <Button
              label="Save fallback"
              variant="primary"
              isDisabled={isSaving || Boolean(refreshConflict)}
              clickAction={saveRule}
            />
          </HStack>
        </HStack>
      </div>
    )
  }

  function detachedDraftEditor() {
    if (!form.id || currentRule) return null
    return (
      <Card>
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>Unsaved edit for removed rule</Heading>
            <Text type="supporting" color="secondary">
              The server no longer contains this rule. Your draft remains below
              for review. Cancel it, then add or reopen a rule from the
              refreshed settings.
            </Text>
          </VStack>
          <ResponsivePair minWidth={220}>
            <TextInput
              ref={sourceRef}
              label="Draft source model"
              value={form.sourceModel}
              onChange={(sourceModel) =>
                setForm((current) => ({ ...current, sourceModel }))
              }
              isDisabled={isSaving}
            />
            <TextInput
              ref={targetRef}
              label="Draft alternate model"
              value={form.targetModel}
              onChange={(targetModel) =>
                setForm((current) => ({ ...current, targetModel }))
              }
              isDisabled={isSaving}
            />
          </ResponsivePair>
          {impactedStarts.length > 0 ?
            <details className="fallback-impact" open>
              <summary>
                Draft path review · {impactedStarts.length} affected start
                {impactedStarts.length === 1 ? "" : "s"}
              </summary>
              <ul>
                {impactedStarts.map((start) => (
                  <li key={start}>
                    <code>{start}</code>:{" "}
                    {traceFallbackPath(start, draftRules).models.join(" → ")}
                  </li>
                ))}
              </ul>
            </details>
          : null}
          <HStack hAlign="end">
            <Button
              label="Cancel removed-rule draft"
              variant="secondary"
              isDisabled={isSaving}
              onClick={cancelEdit}
            />
          </HStack>
        </VStack>
      </Card>
    )
  }

  return (
    <>
      <ModelRoutingWarning safety={settings.safety} />
      {saveError ?
        <Banner
          status="error"
          title="Changes were not saved"
          description={saveError}
        />
      : null}
      {refreshConflict ?
        <Banner
          status="warning"
          title="Rule changed while editing"
          description={refreshConflict}
        />
      : null}

      <Card>
        <VStack gap={4}>
          <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
            <VStack gap={1}>
              <Heading level={2}>Automatic fallback</Heading>
              <Text color="secondary">
                Follow the complete configured path while each model returns
                HTTP 422.
              </Text>
            </VStack>
            <Badge label="HTTP 422 only" variant="neutral" />
          </HStack>
          <Switch
            label="Enable fallbacks"
            value={config.enabled}
            isDisabled={isSaving}
            changeAction={async (enabled) => {
              await save(
                { ...config, enabled },
                enabled ? "Fallbacks enabled" : "Fallbacks disabled",
              )
            }}
          />
          <Text type="supporting" color="secondary">
            Each hop requires HTTP 422. A request stops on success, any non-422
            response, a model without an enabled rule, or a detected loop.
          </Text>
        </VStack>
      </Card>

      <section
        className="fallback-overview"
        aria-labelledby="fallback-overview-heading"
      >
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={0.5}>
            <Heading level={2} id="fallback-overview-heading">
              Chain overview
            </Heading>
            <Text type="supporting" color="secondary">
              Grouped by connected models. Select any model as the request
              start.
            </Text>
          </VStack>
          <Badge variant="neutral" label={`${config.rules.length} rules`} />
        </HStack>

        {!config.enabled && config.rules.length > 0 ?
          <Banner
            status="info"
            title="Fallbacks are disabled"
            description="Configured paths remain visible and editable, but requests will stop at their starting model."
          />
        : null}

        {graph.length === 0 ?
          <EmptyState
            title="No fallback rules"
            description="Add a source model and the alternate to try when it returns HTTP 422."
            icon={<FallbackIcon width={28} height={28} />}
          />
        : <div className="fallback-groups">
            {graph.flatMap((group) => {
              const routedRuleIds = new Set(
                group.routes.flatMap((route) => route.ruleIds),
              )
              const extraRules = group.rules.filter(
                (rule) => !routedRuleIds.has(rule.id),
              )
              const routeCards = group.routes.map((route) => (
                <Card key={`${group.id}-${route.start}`}>
                  <VStack gap={3}>
                    <HStack
                      hAlign="between"
                      vAlign="center"
                      wrap="wrap"
                      gap={2}
                    >
                      <Heading level={3}>
                        From <code>{route.start}</code>
                      </Heading>
                      <Text type="supporting" color="secondary">
                        {route.ruleIds.length} link
                        {route.ruleIds.length === 1 ? "" : "s"}
                      </Text>
                    </HStack>
                    <ol
                      className="fallback-chain-list"
                      aria-label={`Configured path from ${route.start}`}
                    >
                      {route.models.map((model, index) => {
                        const ruleId = route.ruleIds[index]
                        const rule = group.rules.find(
                          (candidate) => candidate.id === ruleId,
                        )
                        return (
                          <li key={`${route.start}-${model}`}>
                            <div className="fallback-chain-node">
                              <button
                                type="button"
                                className="fallback-model-button"
                                aria-pressed={selectedStart === model}
                                onClick={() => setSelectedStart(model)}
                              >
                                <span>{model}</span>
                                {selectedStart === model ?
                                  <small>Start</small>
                                : null}
                              </button>
                              {rule ?
                                <IconAction
                                  label={`Edit fallback for ${rule.sourceModel}`}
                                  icon={<PencilIcon />}
                                  isDisabled={isSaving}
                                  onClick={() => editRule(rule)}
                                />
                              : null}
                            </div>
                            {rule ? inlineRuleEditor(rule) : null}
                          </li>
                        )
                      })}
                    </ol>
                    {routeStop(route)}
                  </VStack>
                </Card>
              ))
              const extraCard =
                extraRules.length > 0 ?
                  <Card key={`${group.id}-extra-rules`}>
                    <VStack gap={3}>
                      <Heading level={3}>Additional configured rules</Heading>
                      <Text type="supporting" color="secondary">
                        Disabled, duplicate, or malformed links remain visible.
                      </Text>
                      <ul className="fallback-extra-rules">
                        {extraRules.map((rule) => (
                          <li key={rule.id}>
                            <div
                              className="fallback-rule-chip"
                              data-enabled={rule.enabled}
                            >
                              <span>
                                <code>{rule.sourceModel}</code> →{" "}
                                <code>{rule.targetModel}</code>
                                {rule.enabled ? "" : " · Disabled"}
                              </span>
                              <IconAction
                                label={`Edit fallback for ${rule.sourceModel}`}
                                icon={<PencilIcon />}
                                isDisabled={isSaving}
                                onClick={() => editRule(rule)}
                              />
                              {inlineRuleEditor(rule)}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </VStack>
                  </Card>
                : null
              return extraCard ? [...routeCards, extraCard] : routeCards
            })}
          </div>
        }
      </section>

      {requestPath ?
        <Card>
          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
              <Heading level={2}>Request path from {requestPath.start}</Heading>
              <Badge
                variant="neutral"
                label={`${config.enabled && settings.safety.safe ? requestPath.models.length : 1} possible attempt${config.enabled && settings.safety.safe && requestPath.models.length !== 1 ? "s" : ""}`}
              />
            </HStack>
            <ol className="fallback-attempts">
              {(config.enabled && settings.safety.safe ?
                requestPath.models
              : [requestPath.start]
              ).map((model, index) => (
                <li key={model}>
                  <small>{index + 1}</small>
                  <button
                    type="button"
                    className="fallback-model-button"
                    aria-pressed={selectedStart === model}
                    onClick={() => setSelectedStart(model)}
                  >
                    <span>{model}</span>
                  </button>
                </li>
              ))}
            </ol>
            <Text type="supporting" color="secondary">
              {settings.safety.safe ?
                requestPathDescription()
              : "Routing safety is paused by a loop, so this request uses only its original starting model until the conflicting rules are corrected."
              }
            </Text>
          </VStack>
        </Card>
      : null}

      {enabledRedirects.length > 0 ?
        <details className="fallback-redirect-disclosure">
          <summary>Model Redirects that may feed these paths</summary>
          <Text type="supporting" color="secondary">
            Enabled redirect sources are shown for context. Redirect matching
            can also depend on effort and preserves the Model Redirects rule
            order.
          </Text>
          <ul>
            {enabledRedirects.map((redirect) => (
              <li key={redirect.id}>
                <code>{redirect.sourceModel}</code> →{" "}
                <code>{redirect.targetModel}</code> ({redirect.sourceEffort})
              </li>
            ))}
          </ul>
        </details>
      : null}

      {settings.redirectsUnavailable ?
        <Banner
          status="warning"
          title="Model Redirects are unavailable"
          description="The fallback-only preview remains editable, but it cannot show which redirected requests may enter these paths. Refresh to retry both settings."
        />
      : null}

      {detachedDraftEditor()}

      {!form.id ?
        <Card>
          <VStack gap={4}>
            <Heading level={2}>Add fallback</Heading>
            <FormLayout>
              <ResponsivePair minWidth={260}>
                <TextInput
                  ref={sourceRef}
                  label="Source model"
                  description="Exact model ID after applicable redirects."
                  value={form.sourceModel}
                  onChange={(sourceModel) =>
                    setForm((current) => ({ ...current, sourceModel }))
                  }
                  isRequired
                  isDisabled={isSaving}
                  status={fieldError(ruleErrors.sourceModel)}
                />
                <TextInput
                  ref={targetRef}
                  label="Alternate model"
                  description="The model to try after HTTP 422."
                  value={form.targetModel}
                  onChange={(targetModel) =>
                    setForm((current) => ({ ...current, targetModel }))
                  }
                  isRequired
                  isDisabled={isSaving}
                  status={fieldError(ruleErrors.targetModel)}
                />
              </ResponsivePair>
            </FormLayout>
            <HStack hAlign="end" gap={2}>
              <Button
                label="Add fallback"
                variant="primary"
                isDisabled={isSaving}
                clickAction={saveRule}
              />
            </HStack>
          </VStack>
        </Card>
      : null}

      <details className="fallback-notices">
        <summary>Client notices</summary>
        <VStack gap={4}>
          <Switch
            label="Include diagnostic response headers"
            value={config.notifyClient}
            isDisabled={isSaving}
            changeAction={async (notifyClient) => {
              await save(
                { ...config, notifyClient },
                notifyClient ?
                  "Diagnostic headers enabled"
                : "Diagnostic headers disabled",
              )
            }}
          />
          <Text type="supporting" color="secondary">
            Adds fallback source, target, and trigger headers for compatible
            clients and debugging.
          </Text>
          <Switch
            label="Show native client fallback notice"
            value={config.nativeClientNotice}
            isDisabled={isSaving}
            changeAction={async (nativeClientNotice) => {
              await save(
                { ...config, nativeClientNotice },
                nativeClientNotice ?
                  "Native client notice enabled"
                : "Native client notice disabled",
              )
            }}
          />
          <Text type="supporting" color="secondary">
            Availability and wording depend on client support.
          </Text>
        </VStack>
      </details>
    </>
  )
}

export default function FallbacksScreen() {
  const { data, error, loading, reload } = useAsyncData(loadFallbacks, [])
  const [saving, setSaving] = useState(false)
  return (
    <Page
      kicker="Control"
      title="Fallbacks"
      onRefresh={reload}
      isRefreshing={loading || saving}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load fallbacks"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}
      {!data && loading ?
        <Skeleton height={220} />
      : null}
      {data ?
        <FallbackControls initial={data} onBusyChange={setSaving} />
      : null}
    </Page>
  )
}
