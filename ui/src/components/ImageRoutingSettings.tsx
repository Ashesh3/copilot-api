import type { SelectorOptionType } from "@astryxdesign/core/Selector"

import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { useRef, useState } from "react"

import type { ImageRoutingSettingsData } from "../lib/types"

import { ApiError, post } from "../lib/api"
import { useToast } from "../lib/toast"

/** The selector value for automatic routing. */
const AUTOMATIC = ""

function isLive(settings: ImageRoutingSettingsData, model: string): boolean {
  return settings.imageModels.some((option) => option.id === model)
}

export function imageRoutingOptions(
  settings: ImageRoutingSettingsData,
): Array<SelectorOptionType> {
  const automatic = settings.imageRoutingAutomaticModel
  const saved = settings.imageRoutingModel
  return [
    {
      value: AUTOMATIC,
      label: automatic ? `Automatic (currently ${automatic})` : "Automatic",
    },
    ...settings.imageModels.map((model) => ({
      value: model.id,
      label: model.id,
    })),
    ...(saved && !isLive(settings, saved) ?
      [{ value: saved, label: `${saved} (unavailable)` }]
    : []),
  ]
}

export function ImageRoutingSettings({
  settings,
  onSaved,
}: {
  settings: ImageRoutingSettingsData
  onSaved: () => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const savingRef = useRef(false)
  const value = draft ?? settings.imageRoutingModel ?? AUTOMATIC
  const unavailable =
    settings.imageRoutingModel !== null
    && !isLive(settings, settings.imageRoutingModel)

  async function save() {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(undefined)
    try {
      await post<ImageRoutingSettingsData>(
        "/dashboard/api/settings/image-routing",
        { model: value === AUTOMATIC ? null : value },
      )
      toast.success("Image model updated")
      onSaved()
    } catch (caught) {
      setError(
        caught instanceof ApiError ?
          caught.message
        : "Could not save the image model. Try again.",
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
        <Heading level={3}>Image generation</Heading>
        <Text type="supporting" color="secondary">
          Choose the model that serves image generation and edit requests.
        </Text>
        <Selector
          label="Image model"
          description={
            value === AUTOMATIC ?
              "Requests keep the model they name. Codex's gpt-image-2 uses the first live image model."
            : "Every image request uses this model, whatever model it names."
          }
          options={imageRoutingOptions(settings)}
          value={value}
          onChange={setDraft}
          isDisabled={saving}
          width="100%"
        />
        {unavailable ?
          <Banner
            status="warning"
            title="Saved image model is unavailable"
            description={`${settings.imageRoutingModel} is not in the live catalog, so image requests use automatic routing until it returns.`}
          />
        : null}
        {error ?
          <Banner
            status="error"
            title="Image model not saved"
            description={error}
          />
        : null}
        <HStack gap={2} wrap="wrap">
          <Button
            label="Save image model"
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
