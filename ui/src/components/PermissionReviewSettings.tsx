import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useRef, useState } from "react"

import type { PermissionReviewSettingsData } from "../lib/types"

import { ApiError, post } from "../lib/api"
import { useToast } from "../lib/toast"

export function PermissionReviewSettings({
  settings,
  onSaved,
}: {
  settings: PermissionReviewSettingsData
  onSaved: () => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<PermissionReviewSettingsData>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const savingRef = useRef(false)
  const value = draft ?? settings

  async function save() {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(undefined)
    try {
      const saved = await post<PermissionReviewSettingsData>(
        "/dashboard/api/settings/permission-review",
        {
          model: value.permissionReviewModel.trim() || null,
          allowAll: value.permissionReviewAllowAll,
        },
      )
      setDraft(saved)
      toast.success("Permission review settings updated")
      onSaved()
    } catch (caught) {
      setError(
        caught instanceof ApiError ?
          caught.message
        : "Could not save permission review settings. Try again.",
      )
    } finally {
      // eslint-disable-next-line require-atomic-updates -- The ref prevents overlapping saves, so only this request releases it.
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Card className="settings-card">
      <VStack gap={3}>
        <Heading level={3}>Permission review</Heading>
        <Text type="supporting" color="secondary">
          Choose the model that reviews permission requests from Codex and
          Claude.
        </Text>
        <TextInput
          label="Reviewer model"
          description="Enter any model ID. Leave blank to use gpt-6-luna."
          value={value.permissionReviewModel}
          onChange={(model) =>
            setDraft({ ...value, permissionReviewModel: model })
          }
          onEnter={() => void save()}
          isDisabled={saving}
          width="100%"
        />
        <CheckboxInput
          label="Danger: allow all permission requests"
          description="Skips model review and automatically approves recognized permission requests, including sensitive or destructive actions."
          value={value.permissionReviewAllowAll}
          onChange={(allowAll) =>
            setDraft({ ...value, permissionReviewAllowAll: allowAll })
          }
          isDisabled={saving}
          width="100%"
        />
        {value.permissionReviewAllowAll ?
          <Banner
            status="warning"
            title="All permission requests will be approved"
            description="The reviewer model is bypassed while this setting is enabled."
          />
        : null}
        {error ?
          <Banner
            status="error"
            title="Settings not saved"
            description={error}
          />
        : null}
        <HStack gap={2} wrap="wrap">
          <Button
            label="Save permission review"
            variant="secondary"
            isLoading={saving}
            isDisabled={saving}
            onClick={() => void save()}
          />
        </HStack>
      </VStack>
    </Card>
  )
}
