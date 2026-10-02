export type Resolution = '720p' | '1080p'

export interface RecorderSettings {
  clipDurationSeconds: number
  resolution: Resolution
  frameRate: 15 | 24 | 30
  bitrateMbps: number
  keepDisplayAwake: boolean
  storageLimitEnabled: boolean
  storageLimitGB: number
  motionAlertsEnabled: boolean
  motionCheckIntervalSeconds: number
  motionSensitivityPercent: number
  motionAlertCooldownSeconds: number
  telegramBotUsername: string
  telegramChatId: string
  outputDirectory: string
}

export interface SavedClip {
  name: string
  path: string
  sizeBytes: number
  durationSeconds: number
  createdAt: string
}

export interface StorageStatus {
  totalBytes: number
  clipCount: number
  limitBytes: number | null
  removedFiles: string[]
}

export interface SavedSegmentResult extends SavedClip {
  retained: boolean
  storage: StorageStatus
}

export const DEFAULT_SETTINGS: Omit<RecorderSettings, 'outputDirectory'> = {
  clipDurationSeconds: 10,
  resolution: '720p',
  frameRate: 30,
  bitrateMbps: 2.5,
  keepDisplayAwake: false,
  storageLimitEnabled: false,
  storageLimitGB: 2,
  motionAlertsEnabled: false,
  motionCheckIntervalSeconds: 3,
  motionSensitivityPercent: 4,
  motionAlertCooldownSeconds: 60,
  telegramBotUsername: '',
  telegramChatId: '',
}

export function estimateClipSizeBytes(settings: Pick<RecorderSettings, 'clipDurationSeconds' | 'bitrateMbps'>) {
  return settings.clipDurationSeconds * settings.bitrateMbps * 1_000_000 / 8
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
}

export function formatGigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(bytes < 10_000_000_000 ? 2 : 1)} GB`
}
