import { useState, useRef, useCallback } from 'react'
import { toCanvas } from 'html-to-image'
import { exportMp4 } from '../lib/exportMp4'
import './HtmlToReel.css'

const REEL_W = 1080
const REEL_H = 1920

// ─── HTML Pre-processor ───────────────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed: ${url}`)
  return res.text()
}
async function fetchDataUri(url) {
  const res = await fetch(url)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}
async function inlineUrlsInCss(css, base) {
  const matches = [...new Set([...css.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g)].map(m => m[1]))]
  const map = {}
  await Promise.allSettled(matches.map(async u => {
    if (u.startsWith('data:') || u.startsWith('#')) return
    try { map[u] = await fetchDataUri(new URL(u, base).href) } catch {}
  }))
  return css.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (m, u) => map[u] ? `url("${map[u]}")` : m)
}
async function preprocessHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const tasks = []

  // Inline external CSS (incl. Google Fonts)
  for (const el of [...doc.querySelectorAll('link[rel="stylesheet"]')]) {
    const href = el.getAttribute('href')
    if (!href || href.startsWith('data:')) continue
    tasks.push(async () => {
      try {
        const css = await inlineUrlsInCss(await fetchText(href), href)
        const s = doc.createElement('style'); s.textContent = css; el.replaceWith(s)
      } catch { el.remove() }
    })
  }
  // Inline external JS
  for (const el of [...doc.querySelectorAll('script[src]')]) {
    const src = el.getAttribute('src')
    if (!src || src.startsWith('data:')) continue
    tasks.push(async () => {
      try {
        const js = await fetchText(src)
        const s = doc.createElement('script')
        for (const a of el.attributes) if (a.name !== 'src') s.setAttribute(a.name, a.value)
        s.textContent = js; el.replaceWith(s)
      } catch { el.remove() }
    })
  }
  // Inline url() refs in <style> tags
  for (const el of [...doc.querySelectorAll('style')]) {
    tasks.push(async () => {
      try { el.textContent = await inlineUrlsInCss(el.textContent, location.href) } catch {}
    })
  }
  // Inline <img src>, <source src>, <video src>, <audio src>
  for (const el of [...doc.querySelectorAll('img[src],source[src],video[src],audio[src]')]) {
    const src = el.getAttribute('src')
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) continue
    tasks.push(async () => {
      try { el.setAttribute('src', await fetchDataUri(src)) } catch {}
    })
  }
  // Inline inline style url() refs
  for (const el of [...doc.querySelectorAll('[style]')]) {
    const s = el.getAttribute('style')
    if (!s || !s.includes('url(')) continue
    tasks.push(async () => {
      try { el.setAttribute('style', await inlineUrlsInCss(s, location.href)) } catch {}
    })
  }

  await Promise.allSettled(tasks.map(t => t()))
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}

// ─── Capture helpers ──────────────────────────────────────────────────────────
function raf() { return new Promise(r => requestAnimationFrame(r)) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Wait for the iframe to finish loading
function waitForLoad(iframe) {
  return new Promise(resolve => {
    if (iframe.contentDocument?.readyState === 'complete') { resolve(); return }
    iframe.addEventListener('load', resolve, { once: true })
  })
}

// Capture one frame from the CAPTURE iframe (hidden, full 1080×1920)
async function captureFrame(iframe) {
  const doc = iframe.contentDocument
  // Inject a one-shot style ensuring clip + dimensions for this render pass
  const fix = doc.createElement('style')
  fix.textContent = `html,body{width:1080px!important;height:1920px!important;overflow:hidden!important;margin:0!important;}`
  doc.head.appendChild(fix)
  await raf()
  const canvas = await toCanvas(doc.documentElement, {
    width: REEL_W,
    height: REEL_H,
    pixelRatio: 1,
    skipFonts: false,
  })
  fix.remove()
  return canvas
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function HtmlToReel() {
  const [ready, setReady] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState(null)
  const [duration, setDuration] = useState(5)
  const [status, setStatus] = useState(null)
  const [progress, setProgress] = useState(0)
  const [dropDragging, setDropDragging] = useState(false)

  const blobUrlRef = useRef(null)
  // Preview iframe: scaled, visible to user
  const previewIframeRef = useRef(null)
  // Capture iframe: hidden, exact 1080×1920, no transform — used for recording
  const captureIframeRef = useRef(null)

  const maxH = window.innerHeight - 200
  const scale = Math.min(1, maxH / REEL_H, (window.innerWidth * 0.6) / REEL_W)

  const handleFile = useCallback(async (file) => {
    if (!file) return
    setError(null)
    setReady(false)
    setPreparing(true)
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    try {
      const html = await file.text()
      const processed = await preprocessHtml(html)
      const blob = new Blob([processed], { type: 'text/html' })
      blobUrlRef.current = URL.createObjectURL(blob)
      setReady(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setPreparing(false)
    }
  }, [])

  // ── Record ─────────────────────────────────────────────────
  const recordReel = useCallback(async () => {
    if (!ready || status) return
    setError(null)
    setStatus('recording')
    setProgress(0)

    try {
      const fps = 30
      const totalFrames = Math.ceil(duration * fps)
      const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')

      const target = new ArrayBufferTarget()
      const muxer = new Muxer({
        target,
        video: { codec: 'avc', width: REEL_W, height: REEL_H },
        fastStart: 'in-memory',
      })
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { throw e },
      })
      encoder.configure({
        codec: 'avc1.4d002a',
        width: REEL_W, height: REEL_H,
        bitrate: 8_000_000,
        framerate: fps,
      })

      // Use the hidden capture iframe — load fresh so animations start at t=0
      const captureIframe = captureIframeRef.current
      captureIframe.src = blobUrlRef.current
      await waitForLoad(captureIframe)

      // Give JS animations (GSAP etc.) time to initialize
      await sleep(100)
      await raf()

      // Check if there are CSS animations we can scrub
      const cssAnims = [...captureIframe.contentDocument.getAnimations()]
      const hasCssAnims = cssAnims.length > 0

      if (hasCssAnims) {
        // CSS animations: pause and scrub deterministically
        cssAnims.forEach(a => { try { a.pause() } catch {} })
      }

      for (let i = 0; i < totalFrames; i++) {
        const t = i / fps

        if (hasCssAnims) {
          // Seek all CSS animations to exact time t
          cssAnims.forEach(a => { try { a.currentTime = t * 1000 } catch {} })
          await raf()
          await raf()
        } else {
          // JS-driven animations: let them run, wait one frame
          await sleep(1000 / fps)
        }

        const canvas = await captureFrame(captureIframe)
        const timestampUs = Math.round(t * 1_000_000)
        const frame = new VideoFrame(canvas, { timestamp: timestampUs })
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
        frame.close()
        setProgress((i + 1) / totalFrames)
      }

      await encoder.flush()
      muxer.finalize()

      const mp4Blob = new Blob([target.buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(mp4Blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'reel.mp4'; a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError('Recording failed: ' + e.message)
    } finally {
      setStatus(null)
      setProgress(0)
    }
  }, [ready, status, duration])

  // ── Screenshot ─────────────────────────────────────────────
  const takeScreenshot = useCallback(async () => {
    if (!ready || status) return
    setError(null)
    setStatus('screenshotting')
    try {
      const captureIframe = captureIframeRef.current
      captureIframe.src = blobUrlRef.current
      await waitForLoad(captureIframe)
      await sleep(200)
      await raf()

      const canvas = await captureFrame(captureIframe)
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = 'screenshot.png'; a.click()
        URL.revokeObjectURL(url)
      }, 'image/png')
    } catch (e) {
      setError('Screenshot failed: ' + e.message)
    } finally {
      setStatus(null)
    }
  }, [ready, status])

  const isWorking = status !== null

  return (
    <div className="htr-layout">
      <div className="htr-panel">
        <div className="panel-section">
          <h2 className="panel-title">HTML to Reel</h2>
          <p className="panel-desc">
            Upload an HTML file with CSS or JS animations. All external fonts,
            CSS, JS, and images are inlined automatically.
          </p>
        </div>

        <div className="panel-section">
          <label className="field-label">HTML File</label>
          <div
            className={`dropzone ${dropDragging ? 'dragging' : ''} ${ready ? 'loaded' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDropDragging(true) }}
            onDragLeave={() => setDropDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDropDragging(false); handleFile(e.dataTransfer.files[0]) }}
            onClick={() => document.getElementById('html-input').click()}
          >
            {preparing
              ? <span className="dz-status preparing">Inlining resources…</span>
              : ready
                ? <span className="dz-status loaded">✓ Ready — click to replace</span>
                : <span className="dz-status">Drop .html file here or click to browse</span>
            }
          </div>
          <input id="html-input" type="file" accept=".html,.htm" style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files[0])} />
          {error && <p className="field-error">{error}</p>}
        </div>

        <div className="panel-section">
          <label className="field-label" htmlFor="dur">Duration (seconds)</label>
          <input id="dur" className="field-input" type="number" min="1" max="60" step="0.5"
            value={duration} onChange={(e) => setDuration(Number(e.target.value))}
            disabled={isWorking} />
        </div>

        {status === 'recording' && (
          <div className="panel-section">
            <div className="progress-row">
              <span className="progress-label">Encoding frames</span>
              <span className="progress-countdown">{Math.round(progress * 100)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill recording" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}

        <div className="panel-section panel-actions" style={{ flexDirection: 'column', gap: 8 }}>
          <button className="btn-primary" disabled={!ready || isWorking} onClick={recordReel}>
            {status === 'recording' ? `Encoding… ${Math.round(progress * 100)}%` : 'Record Reel → MP4'}
          </button>
          <button className="btn-secondary" disabled={!ready || isWorking} onClick={takeScreenshot}>
            {status === 'screenshotting' ? 'Capturing…' : 'Screenshot → PNG'}
          </button>
        </div>

        <div className="panel-hint">MP4 · H.264 · 1080×1920 · 30fps</div>
      </div>

      {/* Visible scaled preview */}
      <div className="htr-preview-area">
        <div className="reel-frame-wrapper"
          style={{ width: REEL_W * scale, height: REEL_H * scale }}>
          {!ready && !preparing && (
            <div className="reel-placeholder"><span>Preview</span></div>
          )}
          {preparing && (
            <div className="reel-placeholder">
              <div className="spinner" /><span>Preparing…</span>
            </div>
          )}
          <iframe
            ref={previewIframeRef}
            src={ready ? blobUrlRef.current : undefined}
            title="Preview"
            style={{
              position: 'absolute', top: 0, left: 0,
              width: REEL_W, height: REEL_H,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              border: 'none',
              display: ready ? 'block' : 'none',
              pointerEvents: 'none',
            }}
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      </div>

      {/* Hidden full-size capture iframe — no transform, off-screen */}
      <iframe
        ref={captureIframeRef}
        title="Capture"
        style={{
          position: 'fixed',
          left: '-1200px',
          top: 0,
          width: REEL_W,
          height: REEL_H,
          border: 'none',
          pointerEvents: 'none',
          visibility: 'hidden',
        }}
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  )
}
