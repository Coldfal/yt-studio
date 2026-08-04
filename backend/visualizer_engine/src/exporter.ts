/**
 * Server-side video renderer.
 *
 * Extracted from the Music Visualiser's Next.js `/api/render` route.
 * Takes a fully-resolved render job (absolute paths, config, output path)
 * and produces an MP4 on disk, emitting NDJSON progress events as it goes.
 *
 * The FFmpeg pipeline:
 *   renderer → canvas.encode("jpeg") → MJPEG stdin → libx264 / hw encoder → MP4
 *
 * Overlap: while @napi-rs/canvas encodes frame N on the libuv thread pool,
 * we render frame N+1 on the main JS thread. Cuts wall time by roughly the
 * slower of the two stages.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { createCanvas, GlobalFonts, loadImage, type Image } from "@napi-rs/canvas";

import { computeSpectrum } from "./audio-spectrum";
import { createBeatState, renderFrame } from "./frame-renderer";
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from "./types";
import { sendProgress } from "./progress";

// Pick the ffmpeg binary to use.
//
// Resolution order:
//   1. ``$FFMPEG_PATH`` (explicit override, e.g. for testing a custom build).
//   2. A system ``ffmpeg`` on $PATH if it can be located AND can encode
//      with h264_nvenc (when the user wants HW encoding). The
//      ``@ffmpeg-installer/ffmpeg`` package ships a static binary from
//      2018 whose NVENC SDK errors out with "Cannot get the preset
//      configuration: unsupported param (12)" against any modern NVIDIA
//      driver — so we MUST prefer a recent system build when one exists.
//   3. The bundled binary as a last resort.
//
// The check is one-shot at module load so we don't shell out on every render.
function resolveFfmpeg(): string {
  const env = process.env.FFMPEG_PATH?.trim();
  if (env && existsSync(env)) return env;
  // Try ``where ffmpeg`` (Windows) or ``which ffmpeg`` (POSIX). Both
  // exit non-zero when the binary is missing; we catch that and fall
  // back to the bundled path.
  try {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    if (probe.status === 0) {
      const first = (probe.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (first && existsSync(first)) return first;
    }
  } catch {
    // ignore — fall through to bundled
  }
  return ffmpegInstaller.path;
}
const FFMPEG = resolveFfmpeg();
process.stderr.write(`[ffmpeg path] ${FFMPEG}\n`);

// ─── Bundled fonts ─────────────────────────────────────────────────
// Register every font file under ``backend/visualizer_engine/fonts/``
// once at module load. Without this, @napi-rs/canvas only sees system-
// installed fonts — which means a font like Trajan Pro 3 (often
// activated through Adobe Fonts only) wouldn't render server-side
// even though it shows up correctly in the browser preview.
//
// The family name comes from the .otf/.ttf metadata, so once
// registered we can refer to it by the same string the user picks in
// the Text panel ("Trajan Pro 3"). If the directory doesn't exist
// (fresh checkout, font files git-ignored), this is a no-op — the
// engine falls back to ``sans-serif`` per ``fontStack()``.
(function registerBundledFonts() {
  try {
    // exporter.ts ships in dist/ at runtime; fonts/ lives one level up.
    const fontsDir = path.resolve(__dirname, "..", "fonts");
    if (!existsSync(fontsDir)) return;
    const entries = readdirSync(fontsDir);
    for (const name of entries) {
      if (!/\.(otf|ttf)$/i.test(name)) continue;
      const full = path.join(fontsDir, name);
      try {
        GlobalFonts.registerFromPath(full);
        process.stderr.write(`[fonts] registered ${name}\n`);
      } catch (e) {
        process.stderr.write(
          `[fonts] failed to register ${name}: ${(e as Error).message}\n`,
        );
      }
    }
  } catch (e) {
    process.stderr.write(`[fonts] scan failed: ${(e as Error).message}\n`);
  }
})();

// ─── Encoder probe (cached at module scope) ────────────────────────

type EncoderChoice = {
  name: string;
  args: string[];
};

let cachedEncoder: EncoderChoice | null = null;

function pickEncoder(crf: number): EncoderChoice {
  if (cachedEncoder) return cachedEncoder;
  let list = "";
  try {
    const out = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    list = (out.stdout || "") + (out.stderr || "");
  } catch {
    list = "";
  }
  const has = (name: string): boolean => list.includes(name);
  let choice: EncoderChoice;

  // Hardware encoders (NVENC/QSV/AMF) are a minefield across driver/ffmpeg
  // versions. Default to libx264 -preset veryfast which is reliable and
  // close to HW speed on modern CPUs for our resolution.
  // Override with VIZWAVE_ENCODER=h264_nvenc|h264_qsv|h264_amf.
  const forced = process.env.VIZWAVE_ENCODER?.trim();
  if (forced === "h264_nvenc" && has("h264_nvenc")) {
    // NVENC needs an explicit rate-control mode AND a preset name
    // ffmpeg's option parser can handle. We use the legacy preset
    // ``medium`` (== hq 1-pass) — the modern p1-p7 names are accepted
    // by the encoder but ffmpeg's generic option parser treats them
    // as math expressions and errors out with ``Undefined constant or
    // missing '(' in 'p5'`` on ffmpeg 8.1 even though the encoder
    // advertises p5 as valid — the two paths read the value
    // differently. Legacy names have been supported by every NVENC
    // release for a decade.
    //
    // We deliberately do NOT use ``slow`` (== hq 2-pass). Our rate
    // control is VBR-with-CQ-target — there's nothing for the second
    // pass to optimize. Empirically, 2-pass on a 34-minute spectrum
    // render clocked 1.15× real-time on an RTX 3060; ``medium`` is
    // ~2× faster with no perceptible quality drop on the kind of
    // content the visualizer produces (bg image + animated bars).
    //
    // Rate control: VBR with CQ target = NVENC's analogue of libx264
    // CRF. ``-b:v 0`` makes the CQ target win over any default bitrate
    // cap. No ``-tune`` — recent builds reject it with "AVOption tune
    // … has not been used for any stream" because tuning is folded
    // into the preset on this code path. ``-pix_fmt yuv420p`` drops
    // the JPEG full-range tag from the MJPEG input.
    choice = {
      name: "h264_nvenc",
      args: [
        "-c:v", "h264_nvenc",
        "-preset", "medium",
        "-rc", "vbr",
        "-cq", String(crf),
        "-b:v", "0",
        "-pix_fmt", "yuv420p",
      ],
    };
  } else if (forced === "h264_qsv" && has("h264_qsv")) {
    choice = {
      name: "h264_qsv",
      args: ["-c:v", "h264_qsv", "-global_quality", String(crf)],
    };
  } else if (forced === "h264_amf" && has("h264_amf")) {
    choice = {
      name: "h264_amf",
      args: [
        "-c:v",
        "h264_amf",
        "-rc",
        "cqp",
        "-qp_i",
        String(crf),
        "-qp_p",
        String(crf),
      ],
    };
  } else {
    choice = {
      name: "libx264",
      args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf)],
    };
  }
  cachedEncoder = choice;
  return choice;
}

// ─── Types ──────────────────────────────────────────────────────────

export interface RenderArgs {
  /** Partial project config — merged on top of DEFAULT_PROJECT_CONFIG. */
  config: Partial<ProjectConfig>;
  /** Preset ID (e.g. "trap-nation", "radial-waveform", …). */
  presetId: string;
  /** Absolute paths to audio tracks; concatenated in order. */
  audioPaths: string[];
  /** Absolute paths to optional image assets. */
  logoPath?: string | null;
  backgroundPath?: string | null;
  overlayPath?: string | null;
  /** Absolute path where the MP4 will be written. Mutually exclusive with
   *  ``rtmpUrl`` — exactly one of them must be set. */
  outputPath?: string;
  /** RTMP URL to stream to (YouTube Live ingestion). When set, the encoder
   *  uses FLV container, real-time audio pacing, and streaming-tuned
   *  GOP/bitrate flags. The sidecar runs at real time until the audio
   *  ends — so call with `audioPaths` repeated to fill the target length. */
  rtmpUrl?: string;
  /** Output resolution / framerate / quality. */
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
}

export interface RenderResult {
  outputPath: string;
  sizeBytes: number;
  durationSec: number;
  frameCount: number;
  fps: number;
  encoder: string;
  elapsedMs: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function tryLoadImage(p: string | null | undefined): Promise<Image | null> {
  if (!p) return null;
  try {
    // Pass the path directly to loadImage — passing a Buffer triggers
    // @napi-rs/canvas's auto-detect heuristic which has a bug where some
    // PNGs (esp. with non-standard chunks) get mis-classified as SVG and
    // fail to load. Loading by path uses the file extension as a hint
    // and decodes correctly. This was leaving every rendered video with
    // a black background — particles drew but bgImg stayed null.
    return await loadImage(p);
  } catch (e) {
    // Surface the failure so it shows up in the engine's stderr (then
    // bubbles into the backend log) — silent null was hiding this bug
    // for months.
    process.stderr.write(`tryLoadImage failed for ${p}: ${(e as Error).message}\n`);
    return null;
  }
}

// ─── Main render ────────────────────────────────────────────────────

export async function renderVideo(args: RenderArgs): Promise<RenderResult> {
  const width = args.width ?? 1920;
  const height = args.height ?? 1080;
  const fps = args.fps ?? 30;
  const crf = args.crf ?? 23;

  if (!args.audioPaths || args.audioPaths.length === 0) {
    throw new Error("renderVideo: no audio paths provided");
  }
  const live = Boolean(args.rtmpUrl);
  if (!args.outputPath && !args.rtmpUrl) {
    throw new Error("renderVideo: provide either outputPath or rtmpUrl");
  }
  if (args.outputPath && args.rtmpUrl) {
    throw new Error("renderVideo: outputPath and rtmpUrl are mutually exclusive");
  }
  if (!args.presetId) {
    throw new Error("renderVideo: no presetId");
  }

  // Verify audio files exist
  for (const p of args.audioPaths) {
    try {
      await stat(p);
    } catch {
      throw new Error(`Audio file not found: ${p}`);
    }
  }

  // Ensure output directory exists (only for file output — RTMP has no path)
  if (args.outputPath) {
    await mkdir(path.dirname(args.outputPath), { recursive: true });
  }

  const startTs = Date.now();

  // ─── Analyse audio ──────────────────────────────────────────────
  sendProgress({ stage: "analysing_audio", trackCount: args.audioPaths.length });
  const spectrum = await computeSpectrum({
    inputPaths: args.audioPaths,
    fps,
    fftSize: 2048,
    sampleRate: 44100,
    smoothing: 0.7,
    minDecibels: -100,
    maxDecibels: -30,
  });

  // ─── Load images ────────────────────────────────────────────────
  sendProgress({
    stage: "loading_assets",
    frameCount: spectrum.frames.length,
    durationSec: spectrum.duration,
  });

  const [logoImg, bgImg, overlayImg] = await Promise.all([
    tryLoadImage(args.logoPath ?? null),
    // Fallback: if no explicit background, use the logo as the background
    // (same behaviour as MV's original route).
    tryLoadImage(args.backgroundPath ?? args.logoPath ?? null),
    tryLoadImage(args.overlayPath ?? null),
  ]);

  // ─── Set up canvas ──────────────────────────────────────────────
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // @napi-rs/canvas is structurally compatible with the browser
  // CanvasRenderingContext2D parts we use. Cast to match the shared
  // frame-renderer signature (which types against DOM Canvas).
  const ctxAny = ctx as unknown as CanvasRenderingContext2D;
  const canvasAny = canvas as unknown as HTMLCanvasElement;

  const config: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG, ...(args.config ?? {}) };
  const beatState = createBeatState();

  // ─── Spawn FFmpeg ───────────────────────────────────────────────
  const encoder = pickEncoder(crf);
  // eslint-disable-next-line no-console
  console.error(
    `[render] encoder=${encoder.name} frames=${spectrum.frames.length} tracks=${args.audioPaths.length}`,
  );

  // For live (RTMP) we apply -re on each audio input so FFmpeg reads audio
  // at its real-time rate, which paces the whole pipeline. The JS loop below
  // then blocks on ffmpeg's stdin drain and stays synced.
  const audioInputArgs: string[] = [];
  for (const p of args.audioPaths) {
    if (live) audioInputArgs.push("-re");
    audioInputArgs.push("-i", p);
  }

  const audioMapArgs: string[] = [];
  if (args.audioPaths.length === 1) {
    audioMapArgs.push("-map", "0:v", "-map", "1:a");
  } else {
    const inputs = args.audioPaths.map((_, i) => `[${i + 1}:a]`).join("");
    const filter = `${inputs}concat=n=${args.audioPaths.length}:v=0:a=1[aout]`;
    audioMapArgs.push("-filter_complex", filter, "-map", "0:v", "-map", "[aout]");
  }

  // Encoder + output differ between file and live modes.
  const outputArgs = live
    ? [
        // Streaming tuning: 2-second GOP, CBR-ish, FLV container to RTMP
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-b:v", "3000k",
        "-maxrate", "3000k",
        "-bufsize", "6000k",
        "-g", String(fps * 2),
        "-keyint_min", String(fps * 2),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "44100",
        "-f", "flv",
        args.rtmpUrl as string,
      ]
    : [
        ...encoder.args,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        args.outputPath as string,
      ];

  const ffmpegFullArgs = [
    "-y",
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-framerate", String(fps),
    "-thread_queue_size", "512",
    "-i", "-",
    ...audioInputArgs,
    ...audioMapArgs,
    ...outputArgs,
  ];
  // One-line dump of the full ffmpeg invocation so we can paste it
  // back into a shell verbatim when something goes wrong. Encoder
  // negotiation failures are nearly impossible to debug without this.
  process.stderr.write(
    `[ffmpeg cmdline] ${FFMPEG} ${ffmpegFullArgs.map(a => /[\s"]/.test(a) ? `"${a}"` : a).join(" ")}\n`,
  );
  const ffmpegProc = spawn(FFMPEG, ffmpegFullArgs);

  const ffmpegErrChunks: Buffer[] = [];
  ffmpegProc.stderr?.on("data", (d: Buffer) => {
    ffmpegErrChunks.push(d);
    // Mirror FFmpeg warnings to stderr so the Python parent can capture.
    process.stderr.write(`[ffmpeg] ${d.toString("utf8").trim()}\n`);
  });
  // EPIPE when ffmpeg dies early — swallow so catch block wins.
  ffmpegProc.stdin?.on("error", (e: Error) => {
    process.stderr.write(`[ffmpeg stdin] ${e.message}\n`);
  });

  let ffmpegExitCode: number | null = null;
  const ffmpegClose = new Promise<number>((resolve, reject) => {
    ffmpegProc.on("close", (code) => {
      ffmpegExitCode = code ?? 0;
      resolve(code ?? 0);
    });
    ffmpegProc.on("error", reject);
  });

  // ─── Render loop ────────────────────────────────────────────────
  const frameCount = spectrum.frames.length;
  const binsPerFrame = spectrum.fftSize / 2;
  let lastProgressTs = Date.now();
  const progressIntervalMs = 250;

  const renderOne = (i: number): void => {
    const t = i / fps;
    const dt = 1 / fps;
    const bytes = spectrum.frames[i];
    const freq = new Array<number>(binsPerFrame);
    for (let j = 0; j < binsPerFrame; j++) freq[j] = bytes[j] / 255;
    renderFrame({
      ctx: ctxAny,
      canvas: canvasAny,
      W: width,
      H: height,
      t,
      dt,
      freq,
      beatFreq: freq,
      beatState,
      config,
      presetId: args.presetId,
      logoImg,
      bgImg,
      bgVideo: null,
      overlayImg,
    });
  };

  const writeJpeg = async (jpeg: Buffer): Promise<void> => {
    const stdin = ffmpegProc.stdin;
    if (!stdin || stdin.destroyed) {
      const stderr = Buffer.concat(ffmpegErrChunks).toString("utf8");
      throw new Error(`ffmpeg stdin closed: ${stderr.slice(-800)}`);
    }
    if (!stdin.write(jpeg)) {
      await new Promise<void>((r) => stdin.once("drain", () => r()));
    }
  };

  try {
    // Prime: render frame 0 and kick off its encode
    renderOne(0);
    let pendingEncode: Promise<Buffer> = canvas.encode("jpeg", 92);

    for (let i = 1; i < frameCount; i++) {
      // In parallel: render frame i on main thread, encode of frame i-1
      // runs on libuv thread pool.
      renderOne(i);
      const jpegPrev = await pendingEncode;

      if (ffmpegExitCode !== null) {
        const stderr = Buffer.concat(ffmpegErrChunks).toString("utf8");
        throw new Error(
          `ffmpeg exited early (code ${ffmpegExitCode}) after ${i - 1} frames: ${stderr.slice(-800)}`,
        );
      }

      await writeJpeg(jpegPrev);
      pendingEncode = canvas.encode("jpeg", 92);

      const now = Date.now();
      if (now - lastProgressTs > progressIntervalMs || i === frameCount - 1) {
        const elapsedMs = now - startTs;
        const rate = i > 0 ? i / (elapsedMs / 1000) : 0;
        const etaSec = rate > 0 ? (frameCount - i) / rate : 0;
        sendProgress({
          stage: "rendering",
          frame: i + 1,
          frameCount,
          elapsedMs,
          etaSec,
          fps: rate,
        });
        lastProgressTs = now;
      }
    }

    // Flush final frame
    const finalJpeg = await pendingEncode;
    await writeJpeg(finalJpeg);

    ffmpegProc.stdin?.end();
    sendProgress({ stage: "encoding" });

    const code = await ffmpegClose;
    if (code !== 0) {
      const stderr = Buffer.concat(ffmpegErrChunks).toString("utf8");
      throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 1000)}`);
    }

    const elapsedMs = Date.now() - startTs;
    let sizeBytes = 0;
    if (args.outputPath) {
      try {
        const stats = await stat(args.outputPath);
        sizeBytes = stats.size;
      } catch {
        // Streaming mode or file vanished — 0 is fine.
      }
    }

    return {
      outputPath: args.outputPath ?? (args.rtmpUrl as string),
      sizeBytes,
      durationSec: spectrum.duration,
      frameCount,
      fps,
      encoder: encoder.name,
      elapsedMs,
    };
  } catch (err) {
    // Best-effort: kill ffmpeg if still running so we don't leak a process.
    try {
      ffmpegProc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw err;
  }
}
