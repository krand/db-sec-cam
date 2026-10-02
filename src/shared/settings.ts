export type Resolution = '720p' | '1080p'

export interface RecorderSettings {
  clipDurationSeconds: number
  resolution: Resolution
  frameRate: 15 | 24 | 30
  bitrateMbps: number
  keepDisplayAwake: boolean
  outputDirectory: string
}

export interface SavedClip {
  name: string
  path: string
  sizeBytes: number
  durationSeconds: number
  createdAt: string
}

export const DEFAULT_SETTINGS: Omit<RecorderSettings, 'outputDirectory'> = {
  clipDurationSeconds: 10,
  resolution: '720p',
  frameRate: 30,
  bitrateMbps: 2.5,
  keepDisplayAwake: false,
}

export function estimateClipSizeBytes(settings: Pick<RecorderSettings, 'clipDurationSeconds' | 'bitrateMbps'>) {
  return settings.clipDurationSeconds * settings.bitrateMbps * 1_000_000 / 8
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
}
