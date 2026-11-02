import type { TranscriptionResult } from "~/routes/voice/groq-stt"

export const DICTATION_PCM_BYTES_PER_SECOND = 32_000
export const DICTATION_BATCH_BYTES = 30 * DICTATION_PCM_BYTES_PER_SECOND

interface TranscriptPartition {
  stableText: string
  interimText: string
  retainFrom: number
}

function withoutWhitespace(text: string): string {
  return text.replaceAll(/\s/gu, "")
}

function textOffset(text: string, characters: number): number {
  let offset = 0
  let count = 0
  while (offset < text.length && count < characters) {
    if (!/\s/u.test(text[offset])) count += 1
    offset += 1
  }
  return offset
}

function validatedSegments(result: TranscriptionResult, audioBytes: number) {
  const segments = result.segments
  if (!segments) return
  const duration = audioBytes / DICTATION_PCM_BYTES_PER_SECOND
  let previousEnd = 0
  for (const segment of segments) {
    if (
      !Number.isFinite(segment.start)
      || !Number.isFinite(segment.end)
      || segment.start < previousEnd
      || segment.end < segment.start
      || segment.end > duration
    )
      return
    previousEnd = segment.end
  }
  const combined = segments.map((segment) => segment.text).join("")
  if (withoutWhitespace(combined) !== withoutWhitespace(result.text)) return
  return segments
}

export function hasFreshSpeech(
  result: TranscriptionResult,
  retainedBytes: number,
  audioBytes: number,
): boolean {
  const retainedSeconds = retainedBytes / DICTATION_PCM_BYTES_PER_SECOND
  return (
    validatedSegments(result, audioBytes)?.some(
      (segment) =>
        segment.text.trim().length > 0 && segment.end > retainedSeconds,
    ) ?? false
  )
}

function safeTextSeam(text: string, offset: number): boolean {
  if (offset >= text.length || /\s/u.test(text[offset])) return true
  // Desktop joins these scripts/punctuation without inserting a space. For
  // other no-space boundaries, retaining audio is safer than splitting a word.
  const unspaced =
    /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u
  return unspaced.test(text[offset - 1]) || unspaced.test(text[offset])
}

/** Keep the last phrase mutable instead of guessing at repeated-word overlap. */
export function partitionTranscript(
  result: TranscriptionResult,
  audioBytes: number,
): TranscriptPartition {
  const unchanged = {
    stableText: "",
    interimText: result.text,
    retainFrom: 0,
  }
  const segments = validatedSegments(result, audioBytes)
  if (!segments || segments.length < 2) return unchanged
  const duration = audioBytes / DICTATION_PCM_BYTES_PER_SECOND
  let boundary = -1
  let characters = 0
  let offset = 0
  for (let index = 0; index < segments.length - 1; index += 1) {
    characters += withoutWhitespace(segments[index].text).length
    const candidate = textOffset(result.text, characters)
    if (
      segments[index].end <= duration - 1
      && safeTextSeam(result.text, candidate)
    ) {
      boundary = index
      offset = candidate
    }
  }
  if (boundary < 0) return unchanged
  const end = segments[boundary].end
  const nextStart = segments[boundary + 1].start
  // Cut on a sample boundary, preferably inside the gap between phrases.
  const retainFrom = Math.floor(((end + nextStart) / 2) * 16_000) * 2
  const stableText = result.text.slice(0, offset).trim()
  if (!stableText || retainFrom <= 0) return unchanged
  return {
    stableText,
    interimText: result.text.slice(offset).trim(),
    retainFrom,
  }
}
