import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useRef, useState } from "react"

import type {
  ModelFallbackConfig,
  ModelFallbackRule,
  ModelFallbackSettings,
  ModelRedirect,
} from "../lib/types"

import { ConfirmButton, EmptyState } from "../components/common"
import { FallbackChains } from "../components/FallbackChains"
import { ModelRoutingWarning } from "../components/ModelRoutingWarning"
import { Page } from "../components/Page"
import { ResponsivePair } from "../components/ResponsivePair"
import { FallbackIcon, PlusIcon, Trash2Icon } from "../icons"
import { api, ApiError, get } from "../lib/api"
import {
  applyFallbackDraft,
  findImpactedStarts,
  traceFallbackPath,
} from "../lib/fallback-graph"
import { shouldApplyFallbackSnapshot } from "../lib/fallback-settings-snapshot"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

interface RuleForm {
  id: string | null
  sourceModel: string
  targetModel: string
  enabled: boolean
}

interface FallbackPageData extends ModelFallbackSettings {
  redirects: Array<ModelRedirect>
  redirectsUnavailable: boolean
}

const EMPTY_RULE: RuleForm = {
  id: null,
  sourceModel: "",
  targetModel: "",
  enabled: true,
}

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

function formForRule(rule: ModelFallbackRule): RuleForm {
  return {
    id: rule.id,
    sourceModel: rule.sourceModel,
    targetModel: rule.targetModel,
    enabled: rule.enabled,
  }
}

function draftRule(form: RuleForm): ModelFallbackRule {
  return {
    id: form.id ?? "fallback-draft",
    sourceModel: form.sourceModel.trim(),
    targetModel: form.targetModel.trim(),
    enabled: form.enabled,
  }
}

function requestStatusMessage(
  enabled: boolean,
  safe: boolean,
): string | undefined {
  if (!safe)
    return "Routing safety is paused by a loop and uses only its original starting model until the conflicting rules are corrected."
  if (!enabled)
    return "Automatic fallback is off; only the starting model is attempted."
  return undefined
}

function FallbackWorkspace({
  initial,
  refreshError,
  loading,
  reload,
}: {
  initial: FallbackPageData
  refreshError?: Error
  loading: boolean
  reload: () => void
}) {
  const toast = useToast()
  const [settings, setSettings] = useState(initial)
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [dialogError, setDialogError] = useState<string>()
  const [refreshConflict, setRefreshConflict] = useState<string>()
  const [ruleErrors, setRuleErrors] = useState<{
    sourceModel?: string
    targetModel?: string
  }>({})
  const [selectedStart, setSelectedStart] = useState(
    initial.config.rules[0]?.sourceModel ?? "",
  )
  const [isPathOpen, setIsPathOpen] = useState(false)
  const [isDiscardOpen, setIsDiscardOpen] = useState(false)
  const originalRuleRef = useRef<ModelFallbackRule | null>(null)
  const originalFormRef = useRef<RuleForm>(EMPTY_RULE)
  const sourceRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const latestRevisionRef = useRef(initial.revision)
  const config = settings.config
  const currentRule =
    form.id ? config.rules.find((rule) => rule.id === form.id) : undefined
  const ruleDraft = draftRule(form)
  const draftRules =
    isDialogOpen ? applyFallbackDraft(config.rules, ruleDraft) : config.rules
  const impactedStarts =
    isDialogOpen && form.sourceModel.trim() && form.targetModel.trim() ?
      findImpactedStarts(config.rules, draftRules)
    : []
  const requestPath =
    selectedStart ? traceFallbackPath(selectedStart, config.rules) : undefined
  let visiblePath: Array<string> = []
  if (requestPath)
    visiblePath =
      config.enabled && settings.safety.safe ?
        requestPath.models
      : [requestPath.start]
  const statusMessage = requestStatusMessage(
    config.enabled,
    settings.safety.safe,
  )
  const isDirty =
    isDialogOpen
    && JSON.stringify(form) !== JSON.stringify(originalFormRef.current)

  useEffect(() => {
    if (
      !shouldApplyFallbackSnapshot(latestRevisionRef.current, initial.revision)
    )
      return
    latestRevisionRef.current = initial.revision
    if (isDialogOpen && form.id) {
      const original = originalRuleRef.current
      const refreshed = initial.config.rules.find((rule) => rule.id === form.id)
      if (
        !refreshed
        || !original
        || JSON.stringify(refreshed) !== JSON.stringify(original)
      )
        // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- Refresh preserves the draft and marks its captured backing rule stale.
        setRefreshConflict(
          "This rule changed or was removed while you were editing. Your draft is preserved; review the latest settings before saving.",
        )
    }
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- Explicit refresh replaces only the backing server snapshot.
    setSettings(initial)
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- Preserve the operator's selected preview start.
    setSelectedStart(
      (current) => current || initial.config.rules[0]?.sourceModel || "",
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only a new server payload should reconcile backing state.
  }, [initial])

  function startMutation(): boolean {
    if (busyRef.current) return false
    busyRef.current = true
    setIsSaving(true)
    setSaveError(undefined)
    return true
  }

  function finishMutation() {
    busyRef.current = false
    setIsSaving(false)
  }

  async function saveConfig(
    next: ModelFallbackConfig,
    message: string,
    errorTarget: "page" | "dialog" = "page",
  ): Promise<boolean> {
    if (!startMutation()) return false
    if (errorTarget === "dialog") setDialogError(undefined)
    try {
      const result = await api<ModelFallbackSettings>(
        "PUT",
        "/dashboard/api/fallbacks",
        next,
        { expectedRevision: settings.revision },
      )
      if (
        shouldApplyFallbackSnapshot(latestRevisionRef.current, result.revision)
      ) {
        latestRevisionRef.current = result.revision
        setSettings((current) => ({ ...current, ...result }))
      }
      toast.success(message)
      return true
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 409 ?
          "Fallback settings changed on the server. Refresh and review the latest paths before saving this draft."
        : errorMessage(error, "Failed to save fallback settings")
      if (errorTarget === "dialog") setDialogError(message)
      else setSaveError(message)
      toast.error(message)
      return false
    } finally {
      finishMutation()
    }
  }

  function openAdd(sourceModel = "") {
    const next = { ...EMPTY_RULE, sourceModel }
    originalRuleRef.current = null
    originalFormRef.current = next
    setForm(next)
    setRuleErrors({})
    setDialogError(undefined)
    setRefreshConflict(undefined)
    setIsDialogOpen(true)
  }

  function openEdit(rule: ModelFallbackRule) {
    const next = formForRule(rule)
    originalRuleRef.current = structuredClone(rule)
    originalFormRef.current = next
    setForm(next)
    setRuleErrors({})
    setDialogError(undefined)
    setRefreshConflict(undefined)
    setIsDialogOpen(true)
  }

  function closeDialog() {
    setIsDialogOpen(false)
    setForm(EMPTY_RULE)
    setRuleErrors({})
    setDialogError(undefined)
    setRefreshConflict(undefined)
    originalRuleRef.current = null
    originalFormRef.current = EMPTY_RULE
  }

  function requestDialogClose(open: boolean) {
    if (open || isSaving) return
    if (isDirty) setIsDiscardOpen(true)
    else closeDialog()
  }

  async function saveRule() {
    if (busyRef.current || isSaving || refreshConflict) return
    if (form.id && !currentRule) {
      setRefreshConflict(
        "This rule was removed while you were editing. Refresh and reopen the latest settings before saving.",
      )
      return
    }
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
    else if (duplicate && form.enabled)
      sourceError = "This source model already has an enabled fallback."
    if (!targetModel) targetError = "Enter the fallback model."
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

    const rule: ModelFallbackRule = {
      ...ruleDraft,
      id: form.id ?? `fallback-${crypto.randomUUID()}`,
    }
    const rules =
      form.id ?
        config.rules.map((existing) =>
          existing.id === form.id ? rule : existing,
        )
      : [...config.rules, rule]
    const saved = await saveConfig(
      { ...config, rules },
      form.id ? "Fallback updated" : "Fallback added",
      "dialog",
    )
    if (!saved) return
    if (!form.id) setSelectedStart(sourceModel)
    closeDialog()
  }

  async function deleteRule(id: string) {
    const saved = await saveConfig(
      { ...config, rules: config.rules.filter((rule) => rule.id !== id) },
      "Fallback deleted",
      "dialog",
    )
    if (!saved) throw new Error("Failed to delete fallback")
    closeDialog()
  }

  return (
    <Page
      kicker="Control"
      title="Fallbacks"
      onRefresh={reload}
      isRefreshing={loading || isSaving}
      actions={
        <Button
          aria-label="Add fallback"
          label="Add fallback"
          variant="primary"
          icon={<PlusIcon />}
          isDisabled={isSaving}
          onClick={() => openAdd()}
        />
      }
    >
      <ModelRoutingWarning safety={settings.safety} />
      {saveError ?
        <Banner
          status="error"
          title="Changes were not saved"
          description={saveError}
        />
      : null}
      {refreshError && !isDialogOpen ?
        <Banner
          status="error"
          title="Refresh failed"
          description={refreshError.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
        <Switch
          label="Enable fallbacks"
          value={config.enabled}
          isDisabled={isSaving}
          changeAction={async (enabled) => {
            await saveConfig(
              { ...config, enabled },
              enabled ? "Fallbacks enabled" : "Fallbacks disabled",
            )
          }}
        />
        <Text type="supporting" color="secondary">
          Each connection requires HTTP 422; success, another error, an
          unconfigured model, or a loop ends the path.
        </Text>
      </HStack>

      <section
        className="fallback-overview"
        aria-labelledby="fallback-chains-heading"
      >
        <VStack gap={0.5}>
          <HStack vAlign="center" wrap="wrap" gap={2}>
            <Heading level={2} id="fallback-chains-heading">
              Configured chains
            </Heading>
            <Text type="supporting" color="secondary">
              {config.rules.length} configured rule
              {config.rules.length === 1 ? "" : "s"}
            </Text>
          </HStack>
          <Text type="supporting" color="secondary">
            Select any model to inspect its configured request path.
          </Text>
        </VStack>
        {!config.enabled && config.rules.length > 0 ?
          <Banner
            status="info"
            title="Fallbacks are disabled"
            description="Configured chains remain editable, but requests currently stop at their starting model."
          />
        : null}
        {config.rules.length === 0 ?
          <EmptyState
            title="No fallback rules"
            description="Add a source model and the fallback to try after HTTP 422."
            icon={<FallbackIcon width={28} height={28} />}
            actions={
              <Button
                label="Add fallback"
                variant="primary"
                icon={<PlusIcon />}
                onClick={() => openAdd()}
              />
            }
          />
        : <FallbackChains
            rules={config.rules}
            redirects={settings.redirects}
            selectedStart={selectedStart}
            isSaving={isSaving}
            onSelect={setSelectedStart}
            onEdit={openEdit}
            onAdd={openAdd}
          />
        }
      </section>

      {settings.redirectsUnavailable ?
        <Banner
          status="warning"
          title="Model Redirects are unavailable"
          description="Fallback chains remain editable, but the page cannot show which redirected requests may enter them. Refresh to retry."
        />
      : null}

      {requestPath ?
        <section
          className="fallback-preview"
          aria-label="Configured path preview"
        >
          <VStack gap={3}>
            <div className="fallback-preview-heading">
              <div className="fallback-preview-summary" aria-live="polite">
                <span className="fallback-secondary">Preview start</span>
                <code>{requestPath.start}</code>
                <span className="fallback-secondary">
                  {visiblePath.length} possible attempt
                  {visiblePath.length === 1 ? "" : "s"}
                </span>
              </div>
              <Button
                aria-controls="fallback-path-details"
                aria-expanded={isPathOpen}
                label={isPathOpen ? "Hide path" : "Inspect path"}
                variant="secondary"
                onClick={() => setIsPathOpen((open) => !open)}
              />
            </div>
            {statusMessage ?
              <Text type="supporting" color="secondary">
                {statusMessage}
              </Text>
            : null}
            <div id="fallback-path-details" hidden={!isPathOpen}>
              <VStack gap={2}>
                <ol className="fallback-attempts">
                  {visiblePath.map((model) => (
                    <li key={model}>
                      <Text type="code">{model}</Text>
                    </li>
                  ))}
                </ol>
                <Text type="supporting" color="secondary">
                  This shows configured fallback links only. Runtime provider
                  aliases, effort routing, success, and non-422 responses can
                  alter or stop the effective path.
                </Text>
              </VStack>
            </div>
          </VStack>
        </section>
      : null}

      <section
        className="fallback-notices"
        aria-labelledby="fallback-notices-heading"
      >
        <VStack gap={4}>
          <VStack gap={0.5}>
            <Heading level={2} id="fallback-notices-heading">
              Client notices
            </Heading>
            <Text type="supporting" color="secondary">
              Control the fallback details exposed to compatible clients.
            </Text>
          </VStack>
          <div className="fallback-notice-controls">
            <VStack gap={1}>
              <Switch
                label="Include diagnostic response headers"
                value={config.notifyClient}
                isDisabled={isSaving}
                changeAction={async (notifyClient) => {
                  await saveConfig(
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
            </VStack>
            <VStack gap={1}>
              <Switch
                label="Show native client fallback notice"
                value={config.nativeClientNotice}
                isDisabled={isSaving}
                changeAction={async (nativeClientNotice) => {
                  await saveConfig(
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
          </div>
        </VStack>
      </section>

      <Dialog
        className="fallback-editor-dialog"
        isOpen={isDialogOpen}
        onOpenChange={requestDialogClose}
        purpose="form"
        width={640}
        maxHeight="min(85vh, 760px)"
      >
        <Layout
          header={
            <DialogHeader
              title={form.id ? "Edit fallback" : "Add fallback"}
              onOpenChange={requestDialogClose}
            />
          }
          content={
            <LayoutContent>
              <VStack className="fallback-editor-form" gap={4}>
                {dialogError ?
                  <Banner
                    status="error"
                    title="Fallback was not saved"
                    description={dialogError}
                    endContent={
                      <Button
                        label="Refresh settings"
                        variant="secondary"
                        isDisabled={isSaving}
                        onClick={reload}
                      />
                    }
                  />
                : null}
                {refreshError ?
                  <Banner
                    status="error"
                    title="Refresh failed"
                    description={refreshError.message}
                    endContent={
                      <Button
                        label="Retry refresh"
                        variant="secondary"
                        isDisabled={isSaving}
                        onClick={reload}
                      />
                    }
                  />
                : null}
                {refreshConflict ?
                  <Banner
                    status="warning"
                    title={
                      currentRule ?
                        "Rule changed while editing"
                      : "Rule was removed while editing"
                    }
                    description={refreshConflict}
                  />
                : null}
                <form
                  id="fallback-editor-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void saveRule()
                  }}
                >
                  <ResponsivePair minWidth={250}>
                    <TextInput
                      ref={sourceRef}
                      hasAutoFocus
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
                      label="Fallback model"
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
                </form>
                <Switch
                  label="Enable this fallback"
                  value={form.enabled}
                  isDisabled={isSaving}
                  changeAction={(enabled) =>
                    setForm((current) => ({ ...current, enabled }))
                  }
                />
                {impactedStarts.length > 0 ?
                  <div className="fallback-impact">
                    <Text type="label">
                      {impactedStarts.length} request start
                      {impactedStarts.length === 1 ? "" : "s"} affected
                    </Text>
                    <ul>
                      {impactedStarts.map((start) => (
                        <li key={start}>
                          <Text type="code">{start}</Text>
                          <Text type="supporting" color="secondary">
                            {traceFallbackPath(start, draftRules).models.join(
                              " → ",
                            )}
                          </Text>
                        </li>
                      ))}
                    </ul>
                  </div>
                : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack hAlign="between" gap={2} wrap="wrap">
                {form.id && currentRule ?
                  <ConfirmButton
                    label="Delete fallback"
                    confirmTitle="Delete fallback rule?"
                    confirmDescription={`Remove the fallback from ${currentRule.sourceModel} to ${currentRule.targetModel}.`}
                    confirmActionLabel="Delete fallback"
                    variant="destructive"
                    icon={<Trash2Icon />}
                    isDisabled={isSaving}
                    onConfirm={() => deleteRule(currentRule.id)}
                  />
                : <span />}
                <HStack gap={2}>
                  <Button
                    label="Cancel"
                    variant="secondary"
                    isDisabled={isSaving}
                    onClick={closeDialog}
                  />
                  <Button
                    label={form.id ? "Save fallback" : "Add fallback"}
                    form="fallback-editor-form"
                    type="submit"
                    variant="primary"
                    isLoading={isSaving}
                    isDisabled={Boolean(refreshConflict)}
                  />
                </HStack>
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>

      <AlertDialog
        isOpen={isDiscardOpen}
        onOpenChange={setIsDiscardOpen}
        title="Discard fallback changes?"
        description="Your unsaved fallback changes will be lost."
        actionLabel="Discard changes"
        actionVariant="destructive"
        onAction={() => {
          setIsDiscardOpen(false)
          closeDialog()
        }}
        width="min(400px, calc(100vw - 32px))"
      />
    </Page>
  )
}

export default function FallbacksScreen() {
  const { data, error, loading, reload } = useAsyncData(loadFallbacks, [])
  if (data)
    return (
      <FallbackWorkspace
        initial={data}
        refreshError={error}
        loading={loading}
        reload={reload}
      />
    )
  return (
    <Page
      kicker="Control"
      title="Fallbacks"
      onRefresh={reload}
      isRefreshing={loading}
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
      : <Skeleton height={220} />}
    </Page>
  )
}
