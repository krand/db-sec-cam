import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RecorderSettings, SavedClip } from '../shared/settings'
import { estimateClipSizeBytes, formatBytes } from '../shared/settings'
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

  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => { streamRef.current = stream }, [stream])

  useEffect(() => {
    void window.cameraRecorder.getSettings().then(setSettings)
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
      if (saved.resolution !== previous?.resolution || saved.frameRate !== previous?.frameRate) {
        const track = streamRef.current?.getVideoTracks()[0]
        if (track) {
          const width = saved.resolution === '1080p' ? 1920 : 1280
          const height = saved.resolution === '1080p' ? 1080 : 720
          await track.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: saved.frameRate } })
            .catch(() => setSaveState('Camera kept its supported resolution and frame rate.'))
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
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`
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
          setClips((previous) => [{ ...saved, durationSeconds, createdAt: new Date(stoppedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }, ...previous].slice(0, 20))
          setSaveState(`Saved ${saved.name} · ${formatBytes(saved.sizeBytes)}`)
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

  const estimate = useMemo(() => settings ? formatBytes(estimateClipSizeBytes(settings)) : '—', [settings])
  const progress = settings ? Math.min(100, (elapsed / settings.clipDurationSeconds) * 100) : 0
  const resolution = settings?.resolution ?? '720p'

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
            <label className="toggle-setting">
              <span className="toggle-copy"><strong>Keep display awake</strong><small>Prevent the screen from sleeping while recording.</small></span>
              <input type="checkbox" checked={settings.keepDisplayAwake} onChange={(event) => patchSettings({ keepDisplayAwake: event.target.checked })} />
              <span className="toggle-track" />
            </label>
            <div className="save-indicator">{savingSettings ? 'Saving settings…' : 'Settings are saved automatically'}</div>
          </div>

          <div className="privacy-note"><span className="privacy-lock">◇</span><span><strong>Private by default</strong><small>Clips are saved on this Mac. The app does not upload anything unless you choose a synced folder.</small></span></div>
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
