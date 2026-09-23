import { useState, useRef, useCallback, useEffect } from 'react'
import { exportMp4 } from '../lib/exportMp4'
import './ImageVideoCompositor.css'

const REEL_W = 1080
const REEL_H = 1920
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

export default function ImageVideoCompositor() {
  // ── State (UI only — the draw loop reads from refs) ────────
  const [bgLoaded, setBgLoaded] = useState(false)
  const [videoLoaded, setVideoLoaded] = useState(false)
  const [videoDuration, setVideoDuration] = useState(0)
  const [rect, setRect] = useState({ x: 140, y: 600, w: 800, h: 450 })
  const [bgDragging, setBgDragging] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportError, setExportError] = useState(null)

  // ── Refs (read by RAF loop without React) ──────────────────
  const canvasRef = useRef(null)
  const videoRef = useRef(null)
  const bgImgRef = useRef(null)         // HTMLImageElement
  const rectRef = useRef(rect)
  const rafRef = useRef(null)
  const interactRef = useRef(null)      // drag/resize state
  const scaleRef = useRef(1)
  const exportingRef = useRef(false)

  // Keep rectRef in sync with state
  useEffect(() => { rectRef.current = rect }, [rect])

  // ── Compute display scale ──────────────────────────────────
  const maxH = window.innerHeight - 140
  const scale = Math.min(1, maxH / REEL_H, (window.innerWidth * 0.55) / REEL_W)
  scaleRef.current = scale

  // ── Draw loop (reads only refs, never state) ───────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, REEL_W, REEL_H)

    if (bgImgRef.current) {
      ctx.drawImage(bgImgRef.current, 0, 0, REEL_W, REEL_H)
    } else {
      ctx.fillStyle = '#1A1714'
      ctx.fillRect(0, 0, REEL_W, REEL_H)
    }

    const video = videoRef.current
    if (video && video.readyState >= 2) {
      const r = rectRef.current
      ctx.drawImage(video, r.x, r.y, r.w, r.h)
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [])

  // Start draw loop once
  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  // ── BG image upload ────────────────────────────────────────
  const handleBgFile = useCallback((file) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      bgImgRef.current = img
      setBgLoaded(true)
    }
    img.src = url
  }, [])

  // ── Video upload ───────────────────────────────────────────
  const handleVideoFile = useCallback((file) => {
    if (!file) return
    setExportError(null)
    const url = URL.createObjectURL(file)
    // Update the video element src directly via ref to avoid re-render timing issues
    const video = videoRef.current
    if (video) {
      video.src = url
      video.load()
    }
    setVideoLoaded(true)
  }, [])

  const onVideoMeta = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    setVideoDuration(video.duration)
    // Auto-size to match video aspect ratio, centered
    const aspect = video.videoWidth / video.videoHeight
    const w = Math.round(REEL_W * 0.74)
    const h = Math.round(w / aspect)
    const x = Math.round((REEL_W - w) / 2)
    const y = Math.round((REEL_H - h) / 2)
    const newRect = { x, y, w, h }
    setRect(newRect)
    rectRef.current = newRect
  }, [])

  // ── Canvas pointer interactions ────────────────────────────
  const toCanvas = useCallback((clientX, clientY) => {
    const r = canvasRef.current.getBoundingClientRect()
    const s = scaleRef.current
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s }
  }, [])

  const hitHandle = useCallback((cx, cy) => {
    const r = rectRef.current
    const HIT = 18 / scaleRef.current
    for (const h of HANDLES) {
      const hx = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2
      const hy = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2
      if (Math.abs(cx - hx) <= HIT && Math.abs(cy - hy) <= HIT) return h
    }
    return null
  }, [])

  const hitRect = useCallback((cx, cy) => {
    const r = rectRef.current
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h
  }, [])

  const getCursor = useCallback((cx, cy) => {
    const handle = hitHandle(cx, cy)
    if (handle) {
      const map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
        nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }
      return map[handle]
    }
    if (hitRect(cx, cy)) return 'grab'
    return 'default'
  }, [hitHandle, hitRect])

  const onPointerDown = useCallback((e) => {
    if (exportingRef.current) return
    const { x, y } = toCanvas(e.clientX, e.clientY)
    const handle = hitHandle(x, y)
    if (handle) {
      interactRef.current = { type: 'resize', handle, startX: x, startY: y, startRect: { ...rectRef.current } }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (hitRect(x, y)) {
      interactRef.current = { type: 'drag', startX: x, startY: y, startRect: { ...rectRef.current } }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }, [toCanvas, hitHandle, hitRect])

  const onPointerMove = useCallback((e) => {
    const { x, y } = toCanvas(e.clientX, e.clientY)
    const ia = interactRef.current
    if (!ia) {
      if (e.currentTarget) e.currentTarget.style.cursor = getCursor(x, y)
      return
    }
    const dx = x - ia.startX
    const dy = y - ia.startY
    const sr = ia.startRect
    let newRect

    if (ia.type === 'drag') {
      newRect = {
        ...sr,
        x: clamp(sr.x + dx, 0, REEL_W - sr.w),
        y: clamp(sr.y + dy, 0, REEL_H - sr.h),
      }
    } else {
      let { x: rx, y: ry, w: rw, h: rh } = sr
      const h = ia.handle
      if (h.includes('e')) rw = Math.max(80, sr.w + dx)
      if (h.includes('s')) rh = Math.max(80, sr.h + dy)
      if (h.includes('w')) { rw = Math.max(80, sr.w - dx); rx = sr.x + sr.w - rw }
      if (h.includes('n')) { rh = Math.max(80, sr.h - dy); ry = sr.y + sr.h - rh }
      newRect = { x: rx, y: ry, w: rw, h: rh }
    }

    rectRef.current = newRect
    setRect(newRect)
  }, [toCanvas, getCursor])

  const onPointerUp = useCallback(() => {
    interactRef.current = null
  }, [])

  // ── Export ─────────────────────────────────────────────────
  const exportReel = useCallback(async () => {
    const video = videoRef.current
    if (!video || exporting) return
    setExportError(null)
    setExporting(true)
    exportingRef.current = true
    setExportProgress(0)

    // Seek to start and play
    video.currentTime = 0
    await new Promise(resolve => {
      video.onseeked = resolve
      video.onerror = resolve
    })
    video.play().catch(() => {})

    // The RAF draw loop is already running and will draw video frames onto canvas
    const dur = videoDuration > 0 ? videoDuration : 10

    try {
      const blob = await exportMp4(canvasRef.current, dur, setExportProgress)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'reel-composite.mp4'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportError('Export failed: ' + e.message)
    } finally {
      video.pause()
      setExporting(false)
      exportingRef.current = false
      setExportProgress(0)
    }
  }, [exporting, videoDuration])

  // ── Handle positions for overlay ───────────────────────────
  const handleDots = HANDLES.map(h => {
    const hx = h.includes('w') ? rect.x : h.includes('e') ? rect.x + rect.w : rect.x + rect.w / 2
    const hy = h.includes('n') ? rect.y : h.includes('s') ? rect.y + rect.h : rect.y + rect.h / 2
    return { h, sx: hx * scale, sy: hy * scale }
  })

  return (
    <div className="ivc-layout">
      {/* ── Left panel ── */}
      <div className="htr-panel">
        <div className="panel-section">
          <h2 className="panel-title">Image + Video</h2>
          <p className="panel-desc">
            Composite a PNG background with a video overlay. Drag and resize the
            video in the preview, then export as a 1080×1920 MP4.
          </p>
        </div>

        <div className="panel-section">
          <label className="field-label">Background Image</label>
          <div
            className={`dropzone ${bgDragging ? 'dragging' : ''} ${bgLoaded ? 'loaded' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setBgDragging(true) }}
            onDragLeave={() => setBgDragging(false)}
            onDrop={(e) => { e.preventDefault(); setBgDragging(false); handleBgFile(e.dataTransfer.files[0]) }}
            onClick={() => document.getElementById('bg-input').click()}
          >
            <span className={`dz-status ${bgLoaded ? 'loaded' : ''}`}>
              {bgLoaded ? '✓ Background loaded — click to replace' : 'Drop PNG/JPG here or click to browse'}
            </span>
          </div>
          <input id="bg-input" type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => handleBgFile(e.target.files[0])} />
        </div>

        <div className="panel-section">
          <label className="field-label">Video File</label>
          <div
            className={`dropzone ${videoLoaded ? 'loaded' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleVideoFile(e.dataTransfer.files[0]) }}
            onClick={() => document.getElementById('video-input').click()}
          >
            <span className={`dz-status ${videoLoaded ? 'loaded' : ''}`}>
              {videoLoaded ? '✓ Video loaded — click to replace' : 'Drop video here or click to browse'}
            </span>
          </div>
          <input id="video-input" type="file" accept="video/*" style={{ display: 'none' }}
            onChange={(e) => handleVideoFile(e.target.files[0])} />
          {videoDuration > 0 && (
            <p className="field-meta">{videoDuration.toFixed(1)}s · drag + resize in preview</p>
          )}
        </div>

        {exporting && (
          <div className="panel-section">
            <div className="progress-row">
              <span className="progress-label">Encoding</span>
              <span className="progress-countdown">{Math.round(exportProgress * 100)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill exporting" style={{ width: `${exportProgress * 100}%` }} />
            </div>
          </div>
        )}

        {exportError && (
          <div className="panel-section">
            <p className="field-error">{exportError}</p>
          </div>
        )}

        <div className="panel-section panel-actions">
          <button className="btn-primary" disabled={!videoLoaded || exporting} onClick={exportReel}>
            {exporting ? 'Encoding…' : 'Export Reel'}
          </button>
        </div>

        <div className="panel-hint">Output: MP4 · H.264 · 1080×1920 · 30fps</div>
      </div>

      {/* ── Canvas preview ── */}
      <div className="htr-preview-area">
        <div
          className="reel-frame-wrapper"
          style={{ width: REEL_W * scale, height: REEL_H * scale }}
        >
          {!bgLoaded && !videoLoaded && (
            <div className="reel-placeholder"><span>Preview</span></div>
          )}

          <canvas
            ref={canvasRef}
            width={REEL_W}
            height={REEL_H}
            className="reel-canvas"
            style={{
              width: REEL_W * scale,
              height: REEL_H * scale,
              display: bgLoaded || videoLoaded ? 'block' : 'none',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />

          {/* Video rect border overlay */}
          {videoLoaded && !exporting && (
            <div
              className="video-rect-border"
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.w * scale,
                height: rect.h * scale,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* Resize handle dots */}
          {videoLoaded && !exporting && handleDots.map(({ h, sx, sy }) => (
            <div key={h} className="resize-handle" style={{ left: sx, top: sy }} />
          ))}
        </div>

        {/* Video element — hidden, used as draw source */}
        <video
          ref={videoRef}
          loop
          muted
          autoPlay
          playsInline
          crossOrigin="anonymous"
          onLoadedMetadata={onVideoMeta}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  )
}
