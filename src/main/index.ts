import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, session, shell, systemPreferences } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS, type RecorderSettings } from '../shared/settings'

const here = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let powerBlockerId: number | null = null

function defaultSettings(): RecorderSettings {
  return { ...DEFAULT_SETTINGS, outputDirectory: path.join(app.getPath('videos'), 'Camera Recorder') }
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')

async function readSettings(): Promise<RecorderSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<RecorderSettings>
    const defaults = defaultSettings()
    return {
      clipDurationSeconds: boundedNumber(parsed.clipDurationSeconds, defaults.clipDurationSeconds, 5, 600),
      resolution: parsed.resolution === '1080p' ? '1080p' : '720p',
      frameRate: parsed.frameRate === 15 || parsed.frameRate === 24 ? parsed.frameRate : 30,
      bitrateMbps: boundedNumber(parsed.bitrateMbps, defaults.bitrateMbps, 0.5, 20),
      keepDisplayAwake: parsed.keepDisplayAwake === true,
      outputDirectory: typeof parsed.outputDirectory === 'string' && parsed.outputDirectory.length > 0
        ? parsed.outputDirectory
        : defaults.outputDirectory,
    }
  } catch {
    return defaultSettings()
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback
}

async function persistSettings(settings: RecorderSettings): Promise<RecorderSettings> {
  const safe: RecorderSettings = {
    clipDurationSeconds: Math.round(boundedNumber(settings.clipDurationSeconds, 10, 5, 600)),
    resolution: settings.resolution === '1080p' ? '1080p' : '720p',
    frameRate: settings.frameRate === 15 || settings.frameRate === 24 ? settings.frameRate : 30,
    bitrateMbps: boundedNumber(settings.bitrateMbps, 2.5, 0.5, 20),
    keepDisplayAwake: settings.keepDisplayAwake === true,
    outputDirectory: typeof settings.outputDirectory === 'string' && settings.outputDirectory.trim()
      ? path.resolve(settings.outputDirectory)
      : defaultSettings().outputDirectory,
  }
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(safe, null, 2), 'utf8')
  return safe
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    title: 'Camera Recorder',
    backgroundColor: '#f4f6f9',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(here, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => { mainWindow = null })
}

function registerIpc() {
  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:save', (_event, settings: RecorderSettings) => persistSettings(settings))
  ipcMain.handle('folder:choose', async (_event, currentPath: string) => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where video clips are saved',
      defaultPath: currentPath || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('recording:save-segment', async (_event, payload: { fileName: string; data: ArrayBuffer }) => {
    const current = await readSettings()
    const name = path.basename(payload.fileName)
    if (!/^[a-zA-Z0-9_.-]+\.webm$/.test(name)) throw new Error('Invalid clip file name')
    await mkdir(current.outputDirectory, { recursive: true })
    const fullPath = path.join(current.outputDirectory, name)
    const content = Buffer.from(payload.data)
    await writeFile(fullPath, content, { flag: 'wx' })
    return { name, path: fullPath, sizeBytes: content.byteLength }
  })
  ipcMain.handle('power:start', (_event, keepDisplayAwake: boolean) => {
    if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = powerSaveBlocker.start(keepDisplayAwake ? 'prevent-display-sleep' : 'prevent-app-suspension')
    return powerSaveBlocker.isStarted(powerBlockerId)
  })
  ipcMain.handle('power:stop', () => {
    if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = null
  })
  ipcMain.handle('camera:request-permission', async () => {
    if (process.platform !== 'darwin') return true
    const status = systemPreferences.getMediaAccessStatus('camera')
    if (status === 'granted') return true
    if (status === 'denied' || status === 'restricted') return false
    return systemPreferences.askForMediaAccess('camera')
  })
  ipcMain.handle('folder:show', async (_event, fullPath: string) => {
    shell.showItemInFolder(fullPath)
  })
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const ownPage = webContents.getURL().startsWith('file://') || webContents.getURL().startsWith('http://localhost:')
    const mediaTypes = ('mediaTypes' in details ? details.mediaTypes : undefined) ?? []
    callback(ownPage && permission === 'media' && mediaTypes.includes('video'))
  })
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => {
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
