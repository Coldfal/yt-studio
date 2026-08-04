/**
 * Node-side audio spectrum analysis for offline server rendering.
 *
 * Decodes an audio file to PCM via ffmpeg, then runs a short-time
 * Fourier transform at each frame time to produce a 0..1 normalised
 * spectrum array that matches what AnalyserNode.getByteFrequencyData
 * returns in the browser (minDecibels -100, maxDecibels -30).
 *
 * Output is shaped so the rendering code can use it interchangeably
 * with live analyser data.
 */

import { spawn } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import FFT from "fft.js";

const FFMPEG = ffmpegInstaller.path;

export interface SpectrumResult {
  fps: number;
  fftSize: number;
  sampleRate: number;
  duration: number;
  /** One Uint8Array of length fftSize/2 per frame. */
  frames: Uint8Array[];
}

/**
 * Decode an audio file to mono float32 PCM at the given sample rate.
 * Returns a single Float32Array of all samples.
 */
async function decodeToPCM(inputPath: string, sampleRate: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-ac", "1",            // mono
      "-ar", String(sampleRate),
      "-f", "f32le",
      "-",
    ];
    const proc = spawn(FFMPEG, args);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => { /* swallow — errors surface via exit code */ void d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode exited with code ${code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      resolve(f32);
    });
  });
}

/**
 * Compute a per-frame spectrum (Hann-windowed FFT magnitudes, converted
 * to the 0-255 dB scale used by AnalyserNode.getByteFrequencyData).
 */
export async function computeSpectrum(opts: {
  /** Single file path (legacy) — ignored if inputPaths is provided. */
  inputPath?: string;
  /** One or more file paths, decoded and concatenated in order. */
  inputPaths?: string[];
  fps: number;
  /** fftSize must be a power of 2. 2048 matches the preview's default. */
  fftSize?: number;
  sampleRate?: number;
  minDecibels?: number;
  maxDecibels?: number;
  /** Exponential smoothing across frames (matches smoothingTimeConstant). */
  smoothing?: number;
}): Promise<SpectrumResult> {
  const fps = opts.fps;
  const fftSize = opts.fftSize ?? 2048;
  const sampleRate = opts.sampleRate ?? 44100;
  const minDb = opts.minDecibels ?? -100;
  const maxDb = opts.maxDecibels ?? -30;
  const smoothing = opts.smoothing ?? 0.7;

  const paths = opts.inputPaths && opts.inputPaths.length > 0
    ? opts.inputPaths
    : opts.inputPath
    ? [opts.inputPath]
    : [];
  if (paths.length === 0) {
    throw new Error("computeSpectrum: no input paths");
  }

  // Decode each track to mono float32 PCM and concatenate them in order.
  const perTrack = await Promise.all(paths.map((p) => decodeToPCM(p, sampleRate)));
  const totalLen = perTrack.reduce((s, a) => s + a.length, 0);
  const pcm = new Float32Array(totalLen);
  let offset = 0;
  for (const part of perTrack) {
    pcm.set(part, offset);
    offset += part.length;
  }
  const duration = pcm.length / sampleRate;
  const totalFrames = Math.ceil(duration * fps);

  // Pre-compute Hann window
  const hann = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  }

  const fft = new FFT(fftSize);
  const input = fft.createComplexArray();
  const output = fft.createComplexArray();
  const bins = fftSize / 2;

  const frames: Uint8Array[] = new Array(totalFrames);
  const smoothed = new Float32Array(bins); // prior frame magnitudes for smoothing

  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps;
    const startSample = Math.floor(t * sampleRate);

    // Fill real input, zero-pad past end of audio
    for (let i = 0; i < fftSize; i++) {
      const idx = startSample + i;
      const sample = idx < pcm.length ? pcm[idx] : 0;
      input[i * 2] = sample * hann[i]; // real
      input[i * 2 + 1] = 0;             // imag
    }

    fft.transform(output, input);

    const byteFreq = new Uint8Array(bins);
    for (let k = 0; k < bins; k++) {
      const re = output[k * 2];
      const im = output[k * 2 + 1];
      const mag = Math.sqrt(re * re + im * im) / fftSize;
      // Exponential smoothing, same shape as AnalyserNode
      const smoothedMag = smoothing * smoothed[k] + (1 - smoothing) * mag;
      smoothed[k] = smoothedMag;

      // Convert to dB, clamp, normalise to 0..255 like getByteFrequencyData
      const db = smoothedMag > 0 ? 20 * Math.log10(smoothedMag) : -200;
      const norm = (db - minDb) / (maxDb - minDb);
      byteFreq[k] = Math.max(0, Math.min(255, Math.round(norm * 255)));
    }
    frames[f] = byteFreq;
  }

  return { fps, fftSize, sampleRate, duration, frames };
}
