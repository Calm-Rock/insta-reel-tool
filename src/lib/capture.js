/**
 * Captures a display media stream (user picks a window/tab),
 * draws it into a 1080×1920 canvas via a video element.
 * Returns { stream, canvas, ctx, video, stop }
 */
export async function startCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 }, width: { ideal: 1080 }, height: { ideal: 1920 } },
    audio: false,
  })

  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  await video.play()

  const canvas = document.createElement('canvas')
  canvas.width = 1080
  canvas.height = 1920
  const ctx = canvas.getContext('2d')

  let rafId
  function loop() {
    if (video.readyState >= 2) ctx.drawImage(video, 0, 0, 1080, 1920)
    rafId = requestAnimationFrame(loop)
  }
  rafId = requestAnimationFrame(loop)

  function stop() {
    cancelAnimationFrame(rafId)
    stream.getTracks().forEach(t => t.stop())
  }

  return { stream, canvas, ctx, video, stop }
}

/**
 * Grabs a single frame from a capture session and downloads it as PNG.
 */
export async function screenshotFromCapture(capture) {
  // Give one rAF tick to ensure canvas is drawn
  await new Promise(r => requestAnimationFrame(r))
  const blob = await new Promise(r => capture.canvas.toBlob(r, 'image/png'))
  capture.stop()
  return blob
}
