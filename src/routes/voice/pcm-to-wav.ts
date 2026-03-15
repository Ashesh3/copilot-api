/**
 * Wraps raw PCM audio data (linear16, mono) in a WAV container.
 */
export function pcmToWav(pcmData: Uint8Array): Uint8Array {
  const sampleRate = 16000
  const channels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const dataSize = pcmData.length
  const headerSize = 44
  const fileSize = headerSize + dataSize

  const buffer = new ArrayBuffer(fileSize)
  const view = new DataView(buffer)
  const output = new Uint8Array(buffer)

  // RIFF header
  writeString(view, 0, "RIFF")
  view.setUint32(4, fileSize - 8, true)
  writeString(view, 8, "WAVE")

  // fmt sub-chunk
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  // data sub-chunk
  writeString(view, 36, "data")
  view.setUint32(40, dataSize, true)

  output.set(pcmData, headerSize)

  return output
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.codePointAt(i) ?? 0)
  }
}
