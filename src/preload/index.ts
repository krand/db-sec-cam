import { contextBridge, ipcRenderer } from 'electron'
import type { RecorderSettings, SavedSegmentResult, StorageStatus } from '../shared/settings'

const cameraRecorder = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<RecorderSettings>,
  saveSettings: (settings: RecorderSettings) => ipcRenderer.invoke('settings:save', settings) as Promise<RecorderSettings>,
  getStorageStatus: () => ipcRenderer.invoke('storage:status') as Promise<StorageStatus>,
  enforceStorageLimit: () => ipcRenderer.invoke('storage:enforce') as Promise<StorageStatus>,
  saveTelegramToken: (token: string) => ipcRenderer.invoke('telegram:save-token', token) as Promise<{ username: string }>,
  beginTelegramConnect: () => ipcRenderer.invoke('telegram:begin-connect') as Promise<{ username: string }>,
  completeTelegramConnect: () => ipcRenderer.invoke('telegram:complete-connect') as Promise<{ connected: true; chatId: string } | { connected: false }>,
  testTelegram: () => ipcRenderer.invoke('telegram:test') as Promise<boolean>,
  sendMotionAlert: (imageData?: ArrayBuffer) => ipcRenderer.invoke('telegram:send-motion-alert', imageData) as Promise<boolean>,
  disconnectTelegram: () => ipcRenderer.invoke('telegram:disconnect') as Promise<boolean>,
  chooseFolder: (currentPath: string) => ipcRenderer.invoke('folder:choose', currentPath) as Promise<string | null>,
  saveSegment: (fileName: string, data: ArrayBuffer) => ipcRenderer.invoke('recording:save-segment', { fileName, data }) as Promise<SavedSegmentResult>,
  startPowerBlocker: (keepDisplayAwake: boolean) => ipcRenderer.invoke('power:acquire', 'recording', keepDisplayAwake) as Promise<boolean>,
  stopPowerBlocker: () => ipcRenderer.invoke('power:release', 'recording') as Promise<void>,
  startMotionPowerBlocker: (keepDisplayAwake: boolean) => ipcRenderer.invoke('power:acquire', 'motion', keepDisplayAwake) as Promise<boolean>,
  stopMotionPowerBlocker: () => ipcRenderer.invoke('power:release', 'motion') as Promise<void>,
  requestCameraPermission: () => ipcRenderer.invoke('camera:request-permission') as Promise<boolean>,
  showFolder: (fullPath: string) => ipcRenderer.invoke('folder:show', fullPath) as Promise<void>,
}

contextBridge.exposeInMainWorld('cameraRecorder', cameraRecorder)

export type CameraRecorderApi = typeof cameraRecorder
