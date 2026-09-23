/**
 * Export a canvas as an MP4 file using WebCodecs + mp4-muxer.
 *
 * @param {HTMLCanvasElement} canvas   - source canvas (already sized correctly)
 * @param {number}            duration - seconds to record
 * @param {function}          onProgress - (0–1) progress callback
 * @param {object}            [opts]
 * @param {number}            [opts.fps=30]
 * @param {number}            [opts.bitrate=8_000_000]
 * @returns {Promise<Blob>}   MP4 blob
 */
export async function exportMp4(canvas, duration, onProgress, opts = {}) {
  const { fps = 30, bitrate = 8_000_000 } = opts
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: canvas.width,
      height: canvas.height,
    },
    fastStart: 'in-memory',
  })

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e },
  })

  encoder.configure({
    codec: 'avc1.4d002a', // H.264 High Profile Level 4.2
    width: canvas.width,
    height: canvas.height,
    bitrate,
    framerate: fps,
  })

  const totalFrames = Math.ceil(duration * fps)

  for (let i = 0; i < totalFrames; i++) {
    if (encoder.encodeQueueSize > 10) {
      // back-pressure: wait for encoder to drain a bit
      await new Promise(r => setTimeout(r, 0))
    }

    const timestampUs = Math.round((i / fps) * 1_000_000)
    const frame = new VideoFrame(canvas, { timestamp: timestampUs })
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
    frame.close()

    onProgress?.((i + 1) / totalFrames)

    // Yield to let the RAF loop update the canvas between frames
    await new Promise(r => setTimeout(r, 0))
  }

  await encoder.flush()
  muxer.finalize()

  const { buffer } = target
  return new Blob([buffer], { type: 'video/mp4' })
}
