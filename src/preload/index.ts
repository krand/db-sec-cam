import { contextBridge, ipcRenderer } from 'electron'
import type { RecorderSettings, SavedClip } from '../shared/settings'

const cameraRecorder = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<RecorderSettings>,
  saveSettings: (settings: RecorderSettings) => ipcRenderer.invoke('settings:save', settings) as Promise<RecorderSettings>,
  chooseFolder: (currentPath: string) => ipcRenderer.invoke('folder:choose', currentPath) as Promise<string | null>,
  saveSegment: (fileName: string, data: ArrayBuffer) => ipcRenderer.invoke('recording:save-segment', { fileName, data }) as Promise<SavedClip>,
  startPowerBlocker: (keepDisplayAwake: boolean) => ipcRenderer.invoke('power:start', keepDisplayAwake) as Promise<boolean>,
  stopPowerBlocker: () => ipcRenderer.invoke('power:stop') as Promise<void>,
  requestCameraPermission: () => ipcRenderer.invoke('camera:request-permission') as Promise<boolean>,
  showFolder: (fullPath: string) => ipcRenderer.invoke('folder:show', fullPath) as Promise<void>,
}

contextBridge.exposeInMainWorld('cameraRecorder', cameraRecorder)

export type CameraRecorderApi = typeof cameraRecorder
