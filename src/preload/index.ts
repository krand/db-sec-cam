import { contextBridge, ipcRenderer } from 'electron'
import type { RecorderSettings, SavedSegmentResult, StorageStatus } from '../shared/settings'

const cameraRecorder = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<RecorderSettings>,
  saveSettings: (settings: RecorderSettings) => ipcRenderer.invoke('settings:save', settings) as Promise<RecorderSettings>,
  getStorageStatus: () => ipcRenderer.invoke('storage:status') as Promise<StorageStatus>,
  enforceStorageLimit: () => ipcRenderer.invoke('storage:enforce') as Promise<StorageStatus>,
  saveTelegramToken: (token: string) => ipcRenderer.invoke('telegram:save-token', token) as Promise<{ username: string }>,
  beginTelegramConnect: () => ipcRenderer.invoke('telegram:begin-connect') as Promise<{ username: string; url: string }>,
  openTelegramPairingLink: (url: string) => ipcRenderer.invoke('telegram:open-pairing-link', url) as Promise<boolean>,
  completeTelegramConnect: () => ipcRenderer.invoke('telegram:complete-connect') as Promise<{ connected: true; chatId: string; welcomeSent: boolean } | { connected: false }>,
  testTelegram: () => ipcRenderer.invoke('telegram:test') as Promise<boolean>,
  sendMotionAlert: (imageData?: ArrayBuffer) => ipcRenderer.invoke('telegram:send-motion-alert', imageData) as Promise<boolean>,
  onTelegramPhotoRequest: (callback: (requestId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string) => callback(requestId)
    ipcRenderer.on('telegram:photo-request', listener)
    return () => ipcRenderer.removeListener('telegram:photo-request', listener)
  },
  submitTelegramPhoto: (requestId: string, imageData?: ArrayBuffer) => ipcRenderer.send('telegram:photo-result', requestId, imageData),
  disconnectTelegram: () => ipcRenderer.invoke('telegram:disconnect') as Promise<boolean>,
  copyText: (value: string) => ipcRenderer.invoke('clipboard:write', value) as Promise<boolean>,
  chooseFolder: (currentPath: string) => ipcRenderer.invoke('folder:choose', currentPath) as Promise<string | null>,
  saveSegment: (fileName: string, data: ArrayBuffer) => ipcRenderer.invoke('recording:save-segment', { fileName, data }) as Promise<SavedSegmentResult>,
  startPowerBlocker: (keepDisplayAwake: boolean) => ipcRenderer.invoke('power:acquire', 'recording', keepDisplayAwake) as Promise<boolean>,
  stopPowerBlocker: () => ipcRenderer.invoke('power:release', 'recording') as Promise<void>,
  startMotionPowerBlocker: (keepDisplayAwake: boolean) => ipcRenderer.invoke('power:acquire', 'motion', keepDisplayAwake) as Promise<boolean>,
  stopMotionPowerBlocker: () => ipcRenderer.invoke('power:release', 'motion') as Promise<void>,
  turnOffDisplay: () => ipcRenderer.invoke('display:turn-off') as Promise<boolean>,
  requestCameraPermission: () => ipcRenderer.invoke('camera:request-permission') as Promise<boolean>,
  showFolder: (fullPath: string) => ipcRenderer.invoke('folder:show', fullPath) as Promise<void>,
}

contextBridge.exposeInMainWorld('cameraRecorder', cameraRecorder)

export type CameraRecorderApi = typeof cameraRecorder
