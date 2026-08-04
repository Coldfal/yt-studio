# Visualizer Engine

Node.js sidecar that renders Trap Nation / Specterr-style audio-reactive MP4 videos. Invoked by the Python backend as a one-shot subprocess per render job.

## Why a sidecar

The rendering core was extracted from the companion `Music Visualiser` project, which is a Next.js + Canvas 2D app. We keep the rendering in Node.js (rather than porting to Python/Pillow) because:

- Preserves 15 existing presets (trap-nation, radial-waveform, neon-ring, particle-storm, linear-bars, etc.) byte-for-byte.
- Uses `@napi-rs/canvas` — a Rust-backed Canvas 2D implementation that matches what browser-side preview renders.
- Re-runs identical draw code in the frontend for live preview, so server render matches preview exactly.

The Python backend spawns this as a subprocess per compose job. No long-running server, no HTTP.

## Requirements

- Node.js 20 LTS (see `.nvmrc`)
- FFmpeg bundled via `@ffmpeg-installer/ffmpeg` (prebuilt per-platform)

## Setup

```bash
cd backend/visualizer_engine
npm install
npm run build
```

Produces `dist/cli.js` which Python invokes.

## CLI

```bash
node dist/cli.js --config <path-to-config.json> --output <path-to-output.mp4>
```

The config file must contain:

```json
{
  "config": { /* full ProjectConfig from types.ts */ },
  "presetId": "trap-nation",
  "audioPaths": ["/abs/path/to/track1.mp3"],
  "logoPath": "/abs/path/to/logo.png",
  "backgroundPath": "/abs/path/to/bg.jpg",
  "overlayPath": null,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "crf": 23
}
```

Progress is reported as newline-delimited JSON on stdout:

```json
{"stage":"analysing_audio","trackCount":1}
{"stage":"loading_assets","frameCount":900,"durationSec":30}
{"stage":"rendering","frame":1,"frameCount":900,"fps":45,"etaSec":19.8}
...
{"stage":"encoding"}
{"stage":"done","outputPath":"/.../out.mp4","sizeBytes":5242880,"durationMs":19230}
```

Errors: `{"stage":"error","error":"..."}` and non-zero exit code.

## Hardware encoder override (optional)

Set `VIZWAVE_ENCODER=h264_nvenc|h264_qsv|h264_amf` to use a hardware encoder. Default is `libx264 -preset veryfast`.
