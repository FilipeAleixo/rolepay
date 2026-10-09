/**
 * Where the speech in a voice-over starts and ends, so the silence a recording picks up at either
 * end (a voice memo starts before the first word and stops a moment after the last) is left out.
 * The file is decoded in the browser with Web Audio, where the studio and the renderer run
 * `calculateMetadata`. When it cannot be decoded, the answer is null and the whole file plays.
 *
 * Only the two ends are trimmed: pauses between sentences stay as they were recorded. A short
 * click (the tap that stops a recording) is not taken for speech, and anything quieter than the
 * floor never is.
 */
export type SpeechSpan = {
  /** Seconds into the file where the kept part starts and ends. */
  from: number
  to: number
}

const WINDOW = 0.02 // seconds of audio per loudness reading
const RUN = 5 // readings looked at together (100 ms)
const VOICED = 3 // of which at least this many must be loud to count as speech
const FLOOR = 0.003 // about -50 dBFS: room noise, never speech
const RELATIVE = 0.06 // about 24 dB under the loudest reading
const BEFORE = 0.15 // seconds kept before the first word, for soft onsets
const AFTER = 0.35 // seconds kept after the last word, for its decay

export async function speechSpan(url: string): Promise<SpeechSpan | null> {
  try {
    const data = await (await fetch(url)).arrayBuffer()
    const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(data)
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
    return findSpeech(channels, audio.sampleRate)
  } catch {
    return null
  }
}

/** The kept span of decoded audio, or null when nothing in it reads as speech. */
export function findSpeech(channels: readonly Float32Array[], sampleRate: number): SpeechSpan | null {
  const size = Math.max(1, Math.round(WINDOW * sampleRate))
  const samples = channels[0]?.length ?? 0
  const count = Math.floor(samples / size)
  if (count < RUN || channels.length === 0) return null

  const level = new Float32Array(count)
  let peak = 0
  for (let w = 0; w < count; w++) {
    let sum = 0
    for (const channel of channels) {
      for (let i = w * size; i < (w + 1) * size; i++) {
        const s = channel[i] ?? 0
        sum += s * s
      }
    }
    level[w] = Math.sqrt(sum / (size * channels.length))
    peak = Math.max(peak, level[w] ?? 0)
  }
  const threshold = Math.max(FLOOR, peak * RELATIVE)
  const loud = (w: number) => (level[w] ?? 0) > threshold
  const voiced = (start: number) => {
    let n = 0
    for (let w = start; w < start + RUN; w++) if (loud(w)) n++
    return n >= VOICED
  }

  let first = -1
  for (let w = 0; w + RUN <= count && first < 0; w++) {
    if (voiced(w)) for (let i = w; i < w + RUN && first < 0; i++) if (loud(i)) first = i
  }
  if (first < 0) return null
  let last = -1
  for (let w = count - RUN; w >= 0 && last < 0; w--) {
    if (voiced(w)) for (let i = w + RUN - 1; i >= w && last < 0; i--) if (loud(i)) last = i
  }

  const duration = samples / sampleRate
  return { from: Math.max(0, first * WINDOW - BEFORE), to: Math.min(duration, (last + 1) * WINDOW + AFTER) }
}
