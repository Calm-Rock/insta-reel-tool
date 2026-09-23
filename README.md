# Reel Tool

A small browser-only tool for turning HTML slides (or a background image plus a
video clip) into a ready-to-post 1080x1920 MP4, no server, no ffmpeg, no upload
of your files anywhere.

Built after doing this by hand a few times for real Instagram carousels and
reels: exporting an animated HTML slide to video usually means a screen
recorder or a Puppeteer script. This does it in the tab instead.

## What it does

**HTML to Reel**
- Drop in an `.html` file with CSS or JS animations
- External stylesheets (including Google Fonts), scripts, and any `url(...)`
  references inside them are fetched and inlined automatically, so the file
  renders correctly even with no network access at record time
- Set a duration, then either:
  - **Record Reel → MP4**: captures the live render frame by frame and
    encodes it client-side with the WebCodecs API (`VideoEncoder`) and
    [`mp4-muxer`](https://github.com/Vanilagy/mp4-muxer), H.264 High Profile,
    1080x1920, 30fps
  - **Screenshot → PNG**: a single still frame via `html-to-image`

**Image + Video**
- Drop in a background image and a video clip
- Drag and resize the video directly in the preview
- Export the composite as a 1080x1920 MP4

## Run locally

```bash
npm install
npm run dev
```

## Stack

React 19, Vite. No backend, everything (HTML parsing, asset inlining, canvas
capture, video encoding) runs in the browser.
