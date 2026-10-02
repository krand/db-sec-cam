import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RecorderSettings, SavedClip, StorageStatus } from '../shared/settings'
import { estimateClipSizeBytes, formatBytes, formatGigabytes } from '../shared/settings'
import './styles.css'

declare global {
  interface Window {
    cameraRecorder: import('../preload').CameraRecorderApi
  }
}

function App() {
  const [settings, setSettings] = useState<RecorderSettings | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [cameraState, setCameraState] = useState<'off' | 'loading' | 'ready' | 'error'>('off')
  const [cameraError, setCameraError] = useState('')
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [clips, setClips] = useState<SavedClip[]>([])
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null)
  const [storageLimitDraft, setStorageLimitDraft] = useState('2')
  const [motionStatus, setMotionStatus] = useState('Motion monitoring is off.')
  const [telegramTokenDraft, setTelegramTokenDraft] = useState('')
  const [telegramStatus, setTelegramStatus] = useState('')
  const [telegramBusy, setTelegramBusy] = useState(false)
  const [telegramNeedsStart, setTelegramNeedsStart] = useState(false)
  const [saveState, setSaveState] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const rotateTimerRef = useRef<number | null>(null)
  const recordingRef = useRef(false)
  const segmentStartRef = useRef(0)
  const settingsRef = useRef<RecorderSettings | null>(null)
  const activeSegmentsRef = useRef(0)
  const pendingSavesRef = useRef(0)
  const previousMotionFrameRef = useRef<Uint8Array | null>(null)
  const lastMotionAlertAtRef = useRef(0)

  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => { streamRef.current = stream }, [stream])

  useEffect(() => {
    void window.cameraRecorder.getSettings().then(async (loaded) => {
      setSettings(loaded)
      setStorageLimitDraft(String(loaded.storageLimitGB))
      const status = await window.cameraRecorder.getStorageStatus()
      setStorageStatus(status)
      if (status.removedFiles.length > 0) {
        setSaveState(`Removed ${status.removedFiles.length} oldest clip${status.removedFiles.length === 1 ? '' : 's'} to meet the storage limit.`)
      }
    })
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (video && stream) {
      video.srcObject = stream
      void video.play().catch(() => undefined)
    }
  }, [stream, cameraState])

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - segmentStartRef.current) / 1000)), 250)
    return () => window.clearInterval(timer)
  }, [recording])

  useEffect(() => {
    if (!settings?.motionAlertsEnabled || !stream) {
      previousMotionFrameRef.current = null
      setMotionStatus(settings?.motionAlertsEnabled ? 'Start the camera to monitor for motion.' : 'Motion monitoring is off.')
      return
    }

    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const video = videoRef.current
    if (!context || !video) return
    let monitoring = true
    void window.cameraRecorder.startMotionPowerBlocker(settings.keepDisplayAwake)
      .then((started) => { if (monitoring && !started) setMotionStatus('Could not keep the Mac awake for motion monitoring.') })
      .catch(() => { if (monitoring) setMotionStatus('Could not keep the Mac awake for motion monitoring.') })
    previousMotionFrameRef.current = null
    setMotionStatus('Watching for changes…')

    const sample = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      context.filter = 'blur(1px)'
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      context.filter = 'none'
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
      const current = new Uint8Array(canvas.width * canvas.height)
      let currentMean = 0
      for (let i = 0; i < current.length; i += 1) {
        const offset = i * 4
        const gray = Math.round(rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114)
        current[i] = gray
        currentMean += gray
      }

      const previous = previousMotionFrameRef.current
      previousMotionFrameRef.current = current
      if (!previous) {
        setMotionStatus('Monitoring · establishing a baseline')
        return
      }
      let previousMean = 0
      for (let i = 0; i < previous.length; i += 1) previousMean += previous[i]
      const meanShift = (currentMean - previousMean) / current.length
      let changedPixels = 0
      for (let i = 0; i < current.length; i += 1) {
        if (Math.abs((current[i] - previous[i]) - meanShift) >= 26) changedPixels += 1
      }
      const changedPercent = (changedPixels / current.length) * 100
      if (changedPercent < settings.motionSensitivityPercent) {
        setMotionStatus(`Monitoring · ${changedPercent.toFixed(1)}% changed`)
        return
      }

      const now = Date.now()
      if (now - lastMotionAlertAtRef.current < settings.motionAlertCooldownSeconds * 1000) {
        setMotionStatus(`Change detected · alert cooldown active`)
        return
      }
      lastMotionAlertAtRef.current = now
      if (!settings.telegramChatId) {
        setMotionStatus('Change detected · connect Telegram to send alerts')
        return
      }
      setMotionStatus('Change detected · sending Telegram alert…')
      void window.cameraRecorder.sendMotionAlert()
        .then(() => setMotionStatus(`Motion alert sent · ${changedPercent.toFixed(1)}% changed`))
        .catch((error) => setMotionStatus(error instanceof Error ? `Telegram alert failed · ${error.message}` : 'Telegram alert failed.'))
    }

    const interval = window.setInterval(sample, settings.motionCheckIntervalSeconds * 1000)
    return () => {
      monitoring = false
      window.clearInterval(interval)
      previousMotionFrameRef.current = null
      void window.cameraRecorder.stopMotionPowerBlocker()
    }
  }, [settings?.motionAlertsEnabled, settings?.motionCheckIntervalSeconds, settings?.motionSensitivityPercent, settings?.motionAlertCooldownSeconds, settings?.telegramChatId, settings?.keepDisplayAwake, stream])

  useEffect(() => () => {
    recordingRef.current = false
    if (rotateTimerRef.current !== null) window.clearTimeout(rotateTimerRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void window.cameraRecorder.stopPowerBlocker()
  }, [])

  const persistSetting = useCallback(async (next: RecorderSettings) => {
    const previous = settingsRef.current
    setSettings(next)
    setSavingSettings(true)
    try {
      const saved = await window.cameraRecorder.saveSettings(next)
      setSettings(saved)
      settingsRef.current = saved
      setStorageLimitDraft(String(saved.storageLimitGB))
      if (saved.resolution !== previous?.resolution || saved.frameRate !== previous?.frameRate) {
        const track = streamRef.current?.getVideoTracks()[0]
        if (track) {
          const width = saved.resolution === '1080p' ? 1920 : 1280
          const height = saved.resolution === '1080p' ? 1080 : 720
          await track.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: saved.frameRate } })
            .catch(() => setSaveState('Camera kept its supported resolution and frame rate.'))
        }
      }
      const storagePolicyChanged = saved.storageLimitEnabled !== previous?.storageLimitEnabled
        || saved.storageLimitGB !== previous?.storageLimitGB
        || saved.outputDirectory !== previous?.outputDirectory
      if (storagePolicyChanged) {
        const status = saved.storageLimitEnabled
          ? await window.cameraRecorder.enforceStorageLimit()
          : await window.cameraRecorder.getStorageStatus()
        setStorageStatus(status)
        if (status.removedFiles.length > 0) {
          const removed = new Set(status.removedFiles)
          setClips((current) => current.filter((clip) => !removed.has(clip.name)))
          setSaveState(`Removed ${status.removedFiles.length} oldest clip${status.removedFiles.length === 1 ? '' : 's'} to meet the storage limit.`)
        }
      }
    } finally {
      setSavingSettings(false)
    }
  }, [])

  const startCamera = useCallback(async () => {
    setCameraState('loading')
    setCameraError('')
    try {
      const allowed = await window.cameraRecorder.requestCameraPermission()
      if (!allowed) throw new Error('Camera access is disabled. Allow it in System Settings → Privacy & Security → Camera.')
      const current = settingsRef.current
      const width = current?.resolution === '1080p' ? 1920 : 1280
      const height = current?.resolution === '1080p' ? 1080 : 720
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: current?.frameRate ?? 30 } },
      })
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = nextStream
      setStream(nextStream)
      setCameraState('ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The camera could not be started.'
      setCameraError(message)
      setCameraState('error')
    }
  }, [])

  const stopCamera = useCallback(() => {
    if (recordingRef.current) return
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setStream(null)
    setCameraState('off')
  }, [])

  const nextFileName = () => {
    const date = new Date()
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}-${String(date.getMilliseconds()).padStart(3, '0')}`
    return `clip_${stamp}_${String(activeSegmentsRef.current++).padStart(3, '0')}.webm`
  }

  const recordSegment = useCallback(() => {
    const current = settingsRef.current
    const currentStream = streamRef.current
    if (!current || !currentStream || !recordingRef.current) return

    const candidates = ['video/webm;codecs=vp8', 'video/webm']
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) {
      setSaveState('This Electron build does not support a compatible video format.')
      recordingRef.current = false
      setRecording(false)
      void window.cameraRecorder.stopPowerBlocker()
      return
    }

    const bitsPerSecond = Math.round(current.bitrateMbps * 1_000_000)
    const recorder = new MediaRecorder(currentStream, { mimeType, videoBitsPerSecond: bitsPerSecond })
    const chunks: BlobPart[] = []
    recorderRef.current = recorder
    segmentStartRef.current = Date.now()
    setElapsed(0)
    setSaveState('')
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
    recorder.onerror = () => setSaveState('Recording encountered an error. Check available disk space and camera access.')
    recorder.onstop = async () => {
      const stoppedAt = Date.now()
      const durationSeconds = Math.max(1, (stoppedAt - segmentStartRef.current) / 1000)
      const blob = new Blob(chunks, { type: mimeType })
      const fileName = nextFileName()
      if (recordingRef.current) recordSegment()
      if (blob.size === 0) {
        if (!recordingRef.current && pendingSavesRef.current === 0) void window.cameraRecorder.stopPowerBlocker()
        return
      }
      pendingSavesRef.current += 1
      void (async () => {
        try {
          const data = await blob.arrayBuffer()
          const saved = await window.cameraRecorder.saveSegment(fileName, data)
          setStorageStatus(saved.storage)
          const removed = new Set(saved.storage.removedFiles)
          setClips((previous) => {
            const remaining = previous.filter((clip) => !removed.has(clip.name))
            return saved.retained
              ? [{ ...saved, durationSeconds, createdAt: new Date(stoppedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }, ...remaining].slice(0, 20)
              : remaining
          })
          if (!saved.retained) setSaveState('The clip was larger than the storage limit and was removed. Increase the limit or reduce clip length/bitrate.')
          else if (saved.storage.removedFiles.length > 0) setSaveState(`Saved ${saved.name}; removed ${saved.storage.removedFiles.length} oldest clip${saved.storage.removedFiles.length === 1 ? '' : 's'} to stay within the limit.`)
          else setSaveState(`Saved ${saved.name} · ${formatBytes(saved.sizeBytes)}`)
        } catch (error) {
          setSaveState(error instanceof Error ? `Could not save clip: ${error.message}` : 'Could not save clip. Check the destination folder.')
        } finally {
          pendingSavesRef.current -= 1
          if (!recordingRef.current && pendingSavesRef.current === 0) void window.cameraRecorder.stopPowerBlocker()
        }
      })()
    }
    recorder.start()
    rotateTimerRef.current = window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, current.clipDurationSeconds * 1000)
  }, [])

  const startRecording = useCallback(async () => {
    if (!streamRef.current || recordingRef.current) return
    recordingRef.current = true
    activeSegmentsRef.current = 0
    setRecording(true)
    setElapsed(0)
    const current = settingsRef.current
    try {
      const blockerStarted = await window.cameraRecorder.startPowerBlocker(current?.keepDisplayAwake ?? false)
      if (!blockerStarted) throw new Error('macOS could not keep the computer awake.')
      recordSegment()
    } catch (error) {
      recordingRef.current = false
      setRecording(false)
      setSaveState(error instanceof Error ? error.message : 'Could not start recording.')
      await window.cameraRecorder.stopPowerBlocker()
    }
  }, [recordSegment])

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    if (rotateTimerRef.current !== null) window.clearTimeout(rotateTimerRef.current)
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    else if (pendingSavesRef.current === 0) void window.cameraRecorder.stopPowerBlocker()
  }, [])

  const chooseFolder = async () => {
    if (!settings) return
    const chosen = await window.cameraRecorder.chooseFolder(settings.outputDirectory)
    if (chosen) await persistSetting({ ...settings, outputDirectory: chosen })
  }

  const patchSettings = (patch: Partial<RecorderSettings>) => {
    if (!settings) return
    const next = { ...settings, ...patch }
    void persistSetting(next)
  }

  const commitStorageLimit = () => {
    if (!settings) return
    const parsed = Number(storageLimitDraft)
    if (!Number.isFinite(parsed)) {
      setStorageLimitDraft(String(settings.storageLimitGB))
      return
    }
    const value = Math.min(10_000, Math.max(0.1, parsed))
    setStorageLimitDraft(String(value))
    if (value !== settings.storageLimitGB) patchSettings({ storageLimitGB: value })
  }

  const updateTelegramSettings = (patch: Partial<RecorderSettings>) => {
    const current = settingsRef.current
    if (!current) return
    const next = { ...current, ...patch }
    settingsRef.current = next
    setSettings(next)
  }

  const saveTelegramToken = async () => {
    setTelegramBusy(true)
    setTelegramStatus('Checking and securely saving the bot token…')
    try {
      const result = await window.cameraRecorder.saveTelegramToken(telegramTokenDraft)
      updateTelegramSettings({ telegramBotUsername: result.username, telegramChatId: '' })
      setTelegramTokenDraft('')
      setTelegramNeedsStart(true)
      setTelegramStatus(`Bot @${result.username} verified. Next, connect your Telegram chat.`)
    } catch (error) {
      setTelegramStatus(error instanceof Error ? error.message : 'Could not verify the bot token.')
    } finally {
      setTelegramBusy(false)
    }
  }

  const beginTelegramConnect = async () => {
    setTelegramBusy(true)
    setTelegramStatus('Opening Telegram…')
    try {
      const result = await window.cameraRecorder.beginTelegramConnect()
      updateTelegramSettings({ telegramBotUsername: result.username })
      setTelegramNeedsStart(true)
      setTelegramStatus(`Start the chat with @${result.username}, then check the connection here.`)
    } catch (error) {
      setTelegramStatus(error instanceof Error ? error.message : 'Could not open Telegram.')
    } finally {
      setTelegramBusy(false)
    }
  }

  const completeTelegramConnect = async () => {
    setTelegramBusy(true)
    setTelegramStatus('Checking for the Telegram /start message…')
    try {
      const result = await window.cameraRecorder.completeTelegramConnect()
      if (!result.connected) {
        setTelegramNeedsStart(true)
        setTelegramStatus('No connection message found yet. Press Start in Telegram, then try again.')
        return
      }
      updateTelegramSettings({ telegramChatId: result.chatId })
      setTelegramNeedsStart(false)
      setTelegramStatus(`Connected to @${settingsRef.current?.telegramBotUsername ?? 'your bot'}.`)
    } catch (error) {
      setTelegramStatus(error instanceof Error ? error.message : 'Could not connect Telegram.')
    } finally {
      setTelegramBusy(false)
    }
  }

  const testTelegram = async () => {
    setTelegramBusy(true)
    setTelegramStatus('Sending a test notification…')
    try {
      await window.cameraRecorder.testTelegram()
      setTelegramStatus('Test notification sent. Check your Telegram chat.')
    } catch (error) {
      setTelegramStatus(error instanceof Error ? error.message : 'Could not send a test notification.')
    } finally {
      setTelegramBusy(false)
    }
  }

  const disconnectTelegram = async () => {
    setTelegramBusy(true)
    try {
      await window.cameraRecorder.disconnectTelegram()
      updateTelegramSettings({ telegramChatId: '', telegramBotUsername: '', motionAlertsEnabled: false })
      setTelegramNeedsStart(false)
      setTelegramStatus('Telegram disconnected; the bot token was removed from this Mac.')
    } catch (error) {
      setTelegramStatus(error instanceof Error ? error.message : 'Could not disconnect Telegram.')
    } finally {
      setTelegramBusy(false)
    }
  }

  const estimate = useMemo(() => settings ? formatBytes(estimateClipSizeBytes(settings)) : '—', [settings])
  const progress = settings ? Math.min(100, (elapsed / settings.clipDurationSeconds) * 100) : 0
  const resolution = settings?.resolution ?? '720p'
  const storageUsagePercent = storageStatus?.limitBytes
    ? Math.min(100, (storageStatus.totalBytes / storageStatus.limitBytes) * 100)
    : 0

  if (!settings) return <div className="loading-screen">Loading recorder…</div>

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div><div className="brand-name">Camera Recorder</div><div className="brand-caption">LOCAL VIDEO CAPTURE</div></div>
        </div>
        <div className={`status-pill ${recording ? 'is-recording' : cameraState === 'ready' ? 'is-ready' : ''}`}>
          <span className="status-dot" />{recording ? 'Recording' : cameraState === 'ready' ? 'Camera ready' : 'Not recording'}
        </div>
      </header>

      <div className="content-grid">
        <section className="main-column">
          <div className="section-heading">
            <div><div className="eyebrow">CAMERA</div><h1>Live preview</h1></div>
            <div className="camera-label"><span className="camera-glyph">◉</span> Built-in camera</div>
          </div>

          <div className={`preview-frame ${recording ? 'recording-frame' : ''}`}>
            <video ref={videoRef} className={stream ? 'preview-video' : 'preview-video hidden'} autoPlay muted playsInline />
            {!stream && <div className="preview-empty">
              <div className="empty-camera-icon"><span /></div>
              <strong>{cameraState === 'loading' ? 'Connecting to camera…' : cameraState === 'error' ? 'Camera unavailable' : 'Camera preview is off'}</strong>
              <span>{cameraState === 'error' ? cameraError : 'Start the camera to see the live view.'}</span>
            </div>}
            {stream && <div className="preview-overlay"><span className="live-badge"><i />{recording ? 'REC' : 'LIVE'}</span><span className="resolution-badge">{resolution} · {settings.frameRate} FPS</span></div>}
            {recording && <div className="clip-progress"><span style={{ width: `${progress}%` }} /></div>}
          </div>

          <div className="preview-actions">
            {cameraState === 'ready' ? <button className="button button-secondary" onClick={stopCamera} disabled={recording}>Turn camera off</button> : <button className="button button-secondary" onClick={() => void startCamera()} disabled={cameraState === 'loading'}>{cameraState === 'loading' ? 'Starting camera…' : 'Start camera'}</button>}
            {!recording ? <button className="button button-record" onClick={() => void startRecording()} disabled={cameraState !== 'ready'}><span className="record-icon" />Start recording</button> : <button className="button button-stop" onClick={stopRecording}><span className="stop-icon" />Stop recording</button>}
            {recording && <div className="clip-clock"><span className="recording-dot" />{formatClock(elapsed)} <span className="clock-divider">/</span> {formatClock(settings.clipDurationSeconds)}</div>}
          </div>
          {cameraError && cameraState === 'error' && <div className="inline-error">{cameraError}</div>}

          <div className="recent-card">
            <div className="recent-header"><div><div className="eyebrow">SESSION</div><h2>Recent clips</h2></div><span className="clip-count">{clips.length} saved</span></div>
            {clips.length === 0 ? <div className="empty-list"><span className="file-icon">▤</span><div><strong>No clips yet</strong><span>Your saved video segments will appear here.</span></div></div> : <div className="clip-list">{clips.map((clip) => <div className="clip-row" key={clip.path}><div className="clip-file-icon">▶</div><div className="clip-info"><strong>{clip.name}</strong><span>{clip.createdAt} · {clip.durationSeconds.toFixed(0)} sec</span></div><span className="clip-size">{formatBytes(clip.sizeBytes)}</span><button className="open-folder" title="Open destination folder" onClick={() => void window.cameraRecorder.showFolder(clip.path)}>↗</button></div>)}</div>}
          </div>
        </section>

        <aside className="settings-column">
          <div className="settings-card">
            <div className="card-heading"><div className="settings-icon">⚙</div><div><div className="eyebrow">CONFIGURATION</div><h2>Recording settings</h2></div></div>
            <div className="field-group">
              <label htmlFor="clip-duration">Clip length</label>
              <div className="input-with-unit"><input id="clip-duration" type="number" min="5" max="600" step="1" value={settings.clipDurationSeconds} onChange={(event) => patchSettings({ clipDurationSeconds: Number(event.target.value) || 5 })} /><span>seconds</span></div>
              <small>Each clip is saved as its own playable video file.</small>
            </div>
            <div className="field-group">
              <label htmlFor="resolution">Resolution</label>
              <select id="resolution" value={settings.resolution} onChange={(event) => patchSettings({ resolution: event.target.value as RecorderSettings['resolution'] })}>
                <option value="720p">HD · 1280 × 720</option><option value="1080p">Full HD · 1920 × 1080</option>
              </select>
            </div>
            <div className="field-row">
              <div className="field-group compact"><label htmlFor="frame-rate">Frame rate</label><select id="frame-rate" value={settings.frameRate} onChange={(event) => patchSettings({ frameRate: Number(event.target.value) as RecorderSettings['frameRate'] })}><option value="15">15 FPS</option><option value="24">24 FPS</option><option value="30">30 FPS</option></select></div>
              <div className="field-group compact"><label htmlFor="bitrate">Target bitrate</label><div className="input-with-unit"><input id="bitrate" type="number" min="0.5" max="20" step="0.5" value={settings.bitrateMbps} onChange={(event) => patchSettings({ bitrateMbps: Number(event.target.value) || 0.5 })} /><span>Mbps</span></div></div>
            </div>
            <div className="estimate-card"><div className="estimate-icon">↗</div><div><span>Estimated clip size</span><strong>~{estimate}</strong><small>Per {settings.clipDurationSeconds}-second clip</small></div><span className="estimate-info" title="Actual size varies with camera output and video complexity">i</span></div>
            <div className="divider" />
            <div className="field-group destination-group">
              <label>Save location</label>
              <div className="destination-box"><span className="folder-icon">▰</span><span title={settings.outputDirectory}>{settings.outputDirectory}</span></div>
              <button className="button button-outline" onClick={() => void chooseFolder()}>Choose folder</button>
              <small>Choose a Dropbox folder to sync clips online. Dropbox must be installed and signed in.</small>
            </div>
            <div className="divider" />
            <div className="storage-section">
              <label className="toggle-setting">
                <span className="toggle-copy"><strong>Limit recorded clip storage</strong><small>Automatically remove the oldest clips when needed.</small></span>
                <input type="checkbox" checked={settings.storageLimitEnabled} onChange={(event) => patchSettings({ storageLimitEnabled: event.target.checked })} />
                <span className="toggle-track" />
              </label>
              <div className="storage-controls">
                <div className="field-group compact">
                  <label htmlFor="storage-limit">Maximum total size</label>
                  <div className="input-with-unit"><input id="storage-limit" type="number" min="0.1" max="10000" step="0.1" value={storageLimitDraft} disabled={!settings.storageLimitEnabled} onChange={(event) => setStorageLimitDraft(event.target.value)} onBlur={commitStorageLimit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><span>GB</span></div>
                </div>
                <div className="storage-usage">
                  <div className="storage-usage-copy"><span>Current clips</span><strong>{storageStatus ? `${formatGigabytes(storageStatus.totalBytes)}${settings.storageLimitEnabled ? ` / ${settings.storageLimitGB} GB` : ''}` : 'Calculating…'}</strong></div>
                  {settings.storageLimitEnabled && <div className="storage-meter"><span style={{ width: `${storageUsagePercent}%` }} /></div>}
                  <small>{storageStatus?.clipCount ?? 0} recorded clips. Only Camera Recorder clips are managed.</small>
                </div>
              </div>
              <small className="storage-help">When enabled, the app deletes its oldest recorded clips until the folder is within this limit. Other files are left alone.</small>
            </div>
            <div className="divider" />
            <label className="toggle-setting">
              <span className="toggle-copy"><strong>Keep display awake</strong><small>Prevent the screen from sleeping while recording or monitoring motion.</small></span>
              <input type="checkbox" checked={settings.keepDisplayAwake} onChange={(event) => patchSettings({ keepDisplayAwake: event.target.checked })} />
              <span className="toggle-track" />
            </label>
            <div className="save-indicator">{savingSettings ? 'Saving settings…' : 'Settings are saved automatically'}</div>
          </div>

          <div className="settings-card motion-card">
            <div className="card-heading"><div className="settings-icon motion-icon">⌁</div><div><div className="eyebrow">CLASSICAL IMAGE COMPARISON</div><h2>Motion alerts</h2></div></div>
            <label className="toggle-setting">
              <span className="toggle-copy"><strong>Enable motion monitoring</strong><small>Compare camera frames while the camera is on.</small></span>
              <input type="checkbox" checked={settings.motionAlertsEnabled} onChange={(event) => patchSettings({ motionAlertsEnabled: event.target.checked })} />
              <span className="toggle-track" />
            </label>
            <div className="motion-status"><span className={settings.motionAlertsEnabled && stream ? 'motion-status-dot active' : 'motion-status-dot'} />{motionStatus}</div>
            <div className="field-row motion-fields">
              <div className="field-group compact"><label htmlFor="motion-interval">Compare every</label><div className="input-with-unit"><input id="motion-interval" type="number" min="1" max="60" step="1" value={settings.motionCheckIntervalSeconds} onChange={(event) => patchSettings({ motionCheckIntervalSeconds: Number(event.target.value) || 1 })} /><span>sec</span></div></div>
              <div className="field-group compact"><label htmlFor="motion-threshold">Changed area</label><div className="input-with-unit"><input id="motion-threshold" type="number" min="0.5" max="50" step="0.5" value={settings.motionSensitivityPercent} onChange={(event) => patchSettings({ motionSensitivityPercent: Number(event.target.value) || 0.5 })} /><span>%</span></div></div>
            </div>
            <div className="field-group compact cooldown-field"><label htmlFor="motion-cooldown">Alert cooldown</label><div className="input-with-unit"><input id="motion-cooldown" type="number" min="10" max="3600" step="10" value={settings.motionAlertCooldownSeconds} onChange={(event) => patchSettings({ motionAlertCooldownSeconds: Number(event.target.value) || 10 })} /><span>seconds</span></div></div>
            <small className="motion-explainer">Frames are downscaled and compared locally. No AI is used; comparison images are kept in memory only and are not saved.</small>
            <div className="divider" />
            <div className="telegram-topline"><div><strong>Telegram notifications</strong><small>{settings.telegramChatId ? `Connected to @${settings.telegramBotUsername}` : 'Connect a private bot chat to receive alerts.'}</small></div><span className={`telegram-badge ${settings.telegramChatId ? 'connected' : ''}`}>{settings.telegramChatId ? 'CONNECTED' : 'OPTIONAL'}</span></div>
            {!settings.telegramChatId && <div className="telegram-token-row"><input type="password" autoComplete="off" aria-label="Telegram bot token" placeholder="Paste bot token from @BotFather" value={telegramTokenDraft} onChange={(event) => setTelegramTokenDraft(event.target.value)} /><button className="button button-outline" disabled={telegramBusy || !telegramTokenDraft.trim()} onClick={() => void saveTelegramToken()}>{telegramBusy ? 'Working…' : 'Save token'}</button></div>}
            {settings.telegramBotUsername && !settings.telegramChatId && <div className="telegram-connect-actions"><button className="button button-outline" disabled={telegramBusy} onClick={() => void beginTelegramConnect()}>Open Telegram &amp; connect</button>{telegramNeedsStart && <button className="button button-outline" disabled={telegramBusy} onClick={() => void completeTelegramConnect()}>Check connection</button>}</div>}
            {settings.telegramChatId && <div className="telegram-connect-actions"><button className="button button-outline" disabled={telegramBusy} onClick={() => void testTelegram()}>Send test</button><button className="button button-outline danger-outline" disabled={telegramBusy} onClick={() => void disconnectTelegram()}>Disconnect</button></div>}
            {telegramStatus && <div className="telegram-message">{telegramStatus}</div>}
          </div>

          <div className="privacy-note"><span className="privacy-lock">◇</span><span><strong>Private by default</strong><small>Video stays local unless its folder syncs online. If enabled, motion alerts send text to your Telegram bot.</small></span></div>
        </aside>
      </div>

      <footer className="app-footer"><span className="footer-led" /> CAMERA PERMISSION IS CONTROLLED BY macOS <span className="footer-spacer" />{saveState && <span className="save-message">{saveState}</span>}</footer>
    </main>
  )
}

function formatClock(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
