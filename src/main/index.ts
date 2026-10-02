import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, safeStorage, session, shell, systemPreferences } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS, type RecorderSettings, type StorageStatus } from '../shared/settings'

const here = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let powerBlockerId: number | null = null
let powerBlockerKeepsDisplayAwake = false
const powerRequests = new Map<string, boolean>()
let storageQueue: Promise<void> = Promise.resolve()
let activeTelegramChallenge: { value: string; expiresAt: number } | null = null

interface TelegramUpdate {
  update_id: number
  message?: { text?: string; chat?: { id: number; type: string } }
}

const pendingTelegramPhotos = new Map<string, (imageData?: ArrayBuffer) => void>()
let telegramPolling = false
let telegramPollGeneration = 0
let telegramUpdateOffset = 0

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
      storageLimitEnabled: parsed.storageLimitEnabled === true,
      storageLimitGB: boundedNumber(parsed.storageLimitGB, defaults.storageLimitGB, 0.1, 10_000),
      motionAlertsEnabled: parsed.motionAlertsEnabled === true,
      motionCheckIntervalSeconds: boundedNumber(parsed.motionCheckIntervalSeconds, defaults.motionCheckIntervalSeconds, 1, 60),
      motionSensitivityPercent: boundedNumber(parsed.motionSensitivityPercent, defaults.motionSensitivityPercent, 0.5, 50),
      motionAlertCooldownSeconds: boundedNumber(parsed.motionAlertCooldownSeconds, defaults.motionAlertCooldownSeconds, 10, 3600),
      telegramBotUsername: typeof parsed.telegramBotUsername === 'string' ? parsed.telegramBotUsername.slice(0, 64) : '',
      telegramChatId: typeof parsed.telegramChatId === 'string' ? parsed.telegramChatId.slice(0, 64) : '',
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
    storageLimitEnabled: settings.storageLimitEnabled === true,
    storageLimitGB: boundedNumber(settings.storageLimitGB, 2, 0.1, 10_000),
    motionAlertsEnabled: settings.motionAlertsEnabled === true,
    motionCheckIntervalSeconds: Math.round(boundedNumber(settings.motionCheckIntervalSeconds, 3, 1, 60)),
    motionSensitivityPercent: boundedNumber(settings.motionSensitivityPercent, 4, 0.5, 50),
    motionAlertCooldownSeconds: Math.round(boundedNumber(settings.motionAlertCooldownSeconds, 60, 10, 3600)),
    telegramBotUsername: typeof settings.telegramBotUsername === 'string' ? settings.telegramBotUsername.slice(0, 64) : '',
    telegramChatId: typeof settings.telegramChatId === 'string' ? settings.telegramChatId.slice(0, 64) : '',
    outputDirectory: typeof settings.outputDirectory === 'string' && settings.outputDirectory.trim()
      ? path.resolve(settings.outputDirectory)
      : defaultSettings().outputDirectory,
  }
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(safe, null, 2), 'utf8')
  return safe
}

function telegramTokenPath() {
  return path.join(app.getPath('userData'), 'telegram-token.bin')
}

async function storeTelegramToken(token: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this computer.')
  const encrypted = safeStorage.encryptString(token)
  await mkdir(path.dirname(telegramTokenPath()), { recursive: true })
  await writeFile(telegramTokenPath(), encrypted, { mode: 0o600 })
}

async function loadTelegramToken(): Promise<string> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this computer.')
  const encrypted = await readFile(telegramTokenPath())
  return safeStorage.decryptString(encrypted)
}

async function telegramRequest<T>(token: string, method: string, payload?: Record<string, unknown>, timeoutMs = 12_000): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const result = await response.json() as { ok?: boolean; result?: T; description?: string }
  if (!response.ok || result.ok !== true) throw new Error(result.description || `Telegram request failed (${response.status}).`)
  return result.result as T
}

async function sendTelegramText(chatId: string, text: string) {
  const token = await loadTelegramToken()
  await telegramRequest(token, 'sendMessage', { chat_id: chatId, text })
}

async function sendTelegramPhoto(chatId: string, text: string, imageData: ArrayBuffer) {
  if (imageData.byteLength === 0 || imageData.byteLength > 10 * 1024 * 1024) {
    throw new Error('The photo must be smaller than 10 MB.')
  }
  const bytes = new Uint8Array(imageData)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('The snapshot is not a JPEG image.')
  const token = await loadTelegramToken()
  const form = new FormData()
  form.set('chat_id', chatId)
  form.set('caption', text)
  form.set('photo', new Blob([bytes], { type: 'image/jpeg' }), 'motion.jpg')
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json() as { ok?: boolean; description?: string }
  if (!response.ok || result.ok !== true) throw new Error(result.description || `Telegram photo upload failed (${response.status}).`)
}

function requestCameraSnapshot(): Promise<ArrayBuffer | null> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return Promise.resolve(null)
  const requestId = randomBytes(12).toString('hex')
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingTelegramPhotos.delete(requestId)
      resolve(null)
    }, 8_000)
    pendingTelegramPhotos.set(requestId, (imageData) => {
      clearTimeout(timeout)
      pendingTelegramPhotos.delete(requestId)
      resolve(imageData ?? null)
    })
    mainWindow!.webContents.send('telegram:photo-request', requestId)
  })
}

async function handleTelegramCommand(update: TelegramUpdate) {
  const message = update.message
  const settings = await readSettings()
  if (!message?.chat || message.chat.type !== 'private' || String(message.chat.id) !== settings.telegramChatId) return
  const command = message.text?.trim() ?? ''
  if (/^\/(photo|snapshot)(?:@[a-z0-9_]+)?(?:\s|$)/i.test(command)) {
    const imageData = await requestCameraSnapshot()
    if (!imageData) {
      await sendTelegramText(settings.telegramChatId, 'Camera is not running or the snapshot is unavailable. Start the camera in Camera Recorder and try again.')
      return
    }
    await sendTelegramPhoto(settings.telegramChatId, `Current camera picture · ${new Date().toLocaleString()}`, imageData)
    return
  }
  if (/^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i.test(command)) {
    await sendTelegramText(settings.telegramChatId, 'Send /photo to receive a current picture from Camera Recorder. The app and camera must be running.')
  }
}

function startTelegramPolling() {
  if (telegramPolling) return
  telegramPolling = true
  const generation = ++telegramPollGeneration
  void (async () => {
    while (telegramPolling && generation === telegramPollGeneration) {
      try {
        const settings = await readSettings()
        if (!settings.telegramChatId) break
        const token = await loadTelegramToken()
        const updates = await telegramRequest<TelegramUpdate[]>(token, 'getUpdates', {
          offset: telegramUpdateOffset,
          timeout: 20,
          allowed_updates: ['message'],
        }, 25_000)
        for (const update of updates) {
          telegramUpdateOffset = Math.max(telegramUpdateOffset, update.update_id + 1)
          try {
            await handleTelegramCommand(update)
          } catch (error) {
            const latest = await readSettings()
            if (latest.telegramChatId && update.message?.chat?.type === 'private'
              && String(update.message.chat.id) === latest.telegramChatId) {
              const detail = error instanceof Error ? error.message : 'Telegram request failed.'
              await sendTelegramText(latest.telegramChatId, `Could not send the camera picture: ${detail}`).catch(() => undefined)
            }
          }
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
    }
    if (generation === telegramPollGeneration) telegramPolling = false
  })()
}

function stopTelegramPolling() {
  telegramPolling = false
  telegramPollGeneration += 1
}

function updatePowerBlocker(): boolean {
  if (powerRequests.size === 0) {
    if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = null
    return true
  }
  const keepDisplayAwake = [...powerRequests.values()].some(Boolean)
  if (powerBlockerId !== null && powerBlockerKeepsDisplayAwake === keepDisplayAwake && powerSaveBlocker.isStarted(powerBlockerId)) return true
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
  powerBlockerKeepsDisplayAwake = keepDisplayAwake
  powerBlockerId = powerSaveBlocker.start(keepDisplayAwake ? 'prevent-display-sleep' : 'prevent-app-suspension')
  return powerSaveBlocker.isStarted(powerBlockerId)
}

function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation, operation)
  storageQueue = result.then(() => undefined, () => undefined)
  return result
}

async function enforceStorageLimit(settings: RecorderSettings): Promise<StorageStatus> {
  let files: { name: string; path: string; sizeBytes: number; modifiedAt: number }[] = []
  try {
    const entries = await readdir(settings.outputDirectory, { withFileTypes: true })
    files = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^clip_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{3})?_\d+\.webm$/.test(entry.name))
      .map(async (entry) => {
        const fullPath = path.join(settings.outputDirectory, entry.name)
        const metadata = await stat(fullPath)
        return { name: entry.name, path: fullPath, sizeBytes: metadata.size, modifiedAt: metadata.mtimeMs }
      }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  files.sort((left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name))
  const limitBytes = settings.storageLimitEnabled ? Math.floor(settings.storageLimitGB * 1_000_000_000) : null
  let totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const removedFiles: string[] = []

  if (limitBytes !== null) {
    while (totalBytes > limitBytes && files.length > 0) {
      const oldest = files.shift()!
      await unlink(oldest.path)
      totalBytes -= oldest.sizeBytes
      removedFiles.push(oldest.name)
    }
  }

  return { totalBytes, clipCount: files.length, limitBytes, removedFiles }
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
  ipcMain.on('telegram:photo-result', (event, requestId: unknown, imageData?: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof requestId !== 'string') return
    pendingTelegramPhotos.get(requestId)?.(imageData instanceof ArrayBuffer ? imageData : undefined)
  })
  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:save', (_event, settings: RecorderSettings) => withStorageLock(() => persistSettings(settings)))
  ipcMain.handle('storage:status', () => withStorageLock(async () => enforceStorageLimit(await readSettings())))
  ipcMain.handle('storage:enforce', () => withStorageLock(async () => enforceStorageLimit(await readSettings())))
  ipcMain.handle('telegram:save-token', async (_event, value: string) => {
    const token = typeof value === 'string' ? value.trim() : ''
    if (token.length < 20 || token.length > 512) throw new Error('Enter a valid bot token from @BotFather.')
    const bot = await telegramRequest<{ username: string }>(token, 'getMe')
    if (!bot.username) throw new Error('Telegram did not return a bot username.')
    stopTelegramPolling()
    await storeTelegramToken(token)
    await withStorageLock(async () => {
      const current = await readSettings()
      await persistSettings({ ...current, telegramBotUsername: bot.username, telegramChatId: '' })
    })
    return { username: bot.username }
  })
  ipcMain.handle('telegram:begin-connect', async () => {
    const token = await loadTelegramToken()
    const settings = await readSettings()
    const bot = await telegramRequest<{ username: string }>(token, 'getMe')
    const nonce = randomBytes(12).toString('hex')
    const payload = `cam_${nonce}`
    activeTelegramChallenge = { value: payload, expiresAt: Date.now() + 5 * 60_000 }
    const url = `https://t.me/${bot.username}?start=${payload}`
    await shell.openExternal(url)
    if (settings.telegramBotUsername !== bot.username) {
      await withStorageLock(async () => persistSettings({ ...await readSettings(), telegramBotUsername: bot.username }))
    }
    return { username: bot.username }
  })
  ipcMain.handle('telegram:complete-connect', async () => {
    const challenge = activeTelegramChallenge
    if (!challenge || challenge.expiresAt < Date.now()) {
      activeTelegramChallenge = null
      throw new Error('The connection link expired. Open Telegram to connect again.')
    }
    const token = await loadTelegramToken()
    const updates = await telegramRequest<TelegramUpdate[]>(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] })
    for (const update of updates) telegramUpdateOffset = Math.max(telegramUpdateOffset, update.update_id + 1)
    const match = [...updates].reverse().find((update) => update.message?.chat?.type === 'private' && update.message.text?.trim() === `/start ${challenge.value}`)
    const chatId = match?.message?.chat?.id
    if (chatId === undefined) return { connected: false as const }
    const id = String(chatId)
    activeTelegramChallenge = null
    await withStorageLock(async () => persistSettings({ ...await readSettings(), telegramChatId: id }))
    startTelegramPolling()
    return { connected: true as const, chatId: id }
  })
  ipcMain.handle('telegram:test', async () => {
    const settings = await readSettings()
    if (!settings.telegramChatId) throw new Error('Connect your Telegram chat first.')
    await sendTelegramText(settings.telegramChatId, 'Camera Recorder test notification. Telegram alerts are connected.')
    return true
  })
  ipcMain.handle('telegram:send-motion-alert', async (_event, imageData?: ArrayBuffer) => {
    const settings = await readSettings()
    if (!settings.motionAlertsEnabled) throw new Error('Motion alerts are turned off.')
    if (!settings.telegramChatId) throw new Error('Connect Telegram in Settings to receive motion alerts.')
    const timestamp = new Date().toLocaleString()
    const message = `Motion detected by Camera Recorder at ${timestamp}.`
    if (imageData) await sendTelegramPhoto(settings.telegramChatId, message, imageData)
    else await sendTelegramText(settings.telegramChatId, message)
    return true
  })
  ipcMain.handle('telegram:disconnect', async () => {
    stopTelegramPolling()
    await unlink(telegramTokenPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    activeTelegramChallenge = null
    await withStorageLock(async () => {
      const current = await readSettings()
      await persistSettings({ ...current, telegramBotUsername: '', telegramChatId: '', motionAlertsEnabled: false })
    })
    return true
  })
  ipcMain.handle('folder:choose', async (_event, currentPath: string) => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where video clips are saved',
      defaultPath: currentPath || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('recording:save-segment', (_event, payload: { fileName: string; data: ArrayBuffer }) => withStorageLock(async () => {
    const current = await readSettings()
    const name = path.basename(payload.fileName)
    if (!/^clip_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{3})?_\d+\.webm$/.test(name)) throw new Error('Invalid clip file name')
    await mkdir(current.outputDirectory, { recursive: true })
    const fullPath = path.join(current.outputDirectory, name)
    const content = Buffer.from(payload.data)
    await writeFile(fullPath, content, { flag: 'wx' })
    const storage = await enforceStorageLimit(current)
    return { name, path: fullPath, sizeBytes: content.byteLength, retained: !storage.removedFiles.includes(name), storage }
  }))
  ipcMain.handle('power:acquire', (_event, reason: string, keepDisplayAwake: boolean) => {
    if (reason !== 'recording' && reason !== 'motion') return false
    powerRequests.set(reason, keepDisplayAwake === true)
    return updatePowerBlocker()
  })
  ipcMain.handle('power:release', (_event, reason: string) => {
    powerRequests.delete(reason)
    updatePowerBlocker()
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
  void readSettings().then((settings) => {
    if (settings.telegramChatId) startTelegramPolling()
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => {
  stopTelegramPolling()
  powerRequests.clear()
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
  powerBlockerId = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
