#!/usr/bin/env node
/**
 * CLI entrypoint for the visualizer sidecar.
 *
 * Invoked by the Python backend:
 *   node dist/cli.js --config <config.json> --output <out.mp4>
 *
 * The config JSON file must contain:
 *   {
 *     "config":         <partial ProjectConfig>,
 *     "presetId":       <string, e.g. "trap-nation">,
 *     "audioPaths":     [<absolute path>, ...],
 *     "logoPath":       <absolute path | null>,
 *     "backgroundPath": <absolute path | null>,
 *     "overlayPath":    <absolute path | null>,
 *     "width":          1920,
 *     "height":         1080,
 *     "fps":            30,
 *     "crf":            23
 *   }
 *
 * Progress is emitted as NDJSON on stdout; logs on stderr. Exits 0 on
 * success with a final {"stage":"done",...} event; exits 1 on failure
 * with a final {"stage":"error","error":"..."} event.
 */

import { readFile } from "node:fs/promises";
import { renderVideo } from "./exporter";
import { sendProgress } from "./progress";
import type { ProjectConfig } from "./types";

interface CliArgs {
  configPath: string;
  outputPath?: string;
  rtmpUrl?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") {
      args.configPath = argv[++i];
    } else if (a === "--output" || a === "-o") {
      args.outputPath = argv[++i];
    } else if (a === "--rtmp") {
      args.rtmpUrl = argv[++i];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.configPath) throw new Error("--config <path> is required");
  if (!args.outputPath && !args.rtmpUrl)
    throw new Error("--output <path> or --rtmp <url> is required");
  if (args.outputPath && args.rtmpUrl)
    throw new Error("--output and --rtmp are mutually exclusive");
  return args as CliArgs;
}

function printHelp(): void {
  process.stderr.write(
    [
      "Usage:",
      "  node cli.js --config <config.json> --output <out.mp4>",
      "  node cli.js --config <config.json> --rtmp <rtmp://...>",
      "",
      "  -c, --config <path>  Path to render job JSON",
      "  -o, --output <path>  Path where the MP4 will be written",
      "      --rtmp <url>     RTMP ingestion URL for live streaming",
      "  -h, --help           Show this help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = await readFile(args.configPath, "utf8");
  let job: {
    config?: Partial<ProjectConfig>;
    presetId?: string;
    audioPaths?: string[];
    logoPath?: string | null;
    backgroundPath?: string | null;
    overlayPath?: string | null;
    width?: number;
    height?: number;
    fps?: number;
    crf?: number;
  };
  try {
    job = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${args.configPath}: ${(e as Error).message}`);
  }

  if (!job.presetId) throw new Error("config.presetId is required");
  if (!Array.isArray(job.audioPaths) || job.audioPaths.length === 0) {
    throw new Error("config.audioPaths must be a non-empty array");
  }

  const result = await renderVideo({
    config: job.config ?? {},
    presetId: job.presetId,
    audioPaths: job.audioPaths,
    logoPath: job.logoPath ?? null,
    backgroundPath: job.backgroundPath ?? null,
    overlayPath: job.overlayPath ?? null,
    outputPath: args.outputPath,
    rtmpUrl: args.rtmpUrl,
    width: job.width ?? 1920,
    height: job.height ?? 1080,
    fps: job.fps ?? 30,
    crf: job.crf ?? 23,
  });

  sendProgress({
    stage: "done",
    outputPath: result.outputPath,
    sizeBytes: result.sizeBytes,
    durationSec: result.durationSec,
    frameCount: result.frameCount,
    fps: result.fps,
    encoder: result.encoder,
    elapsedMs: result.elapsedMs,
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  sendProgress({ stage: "error", error: msg });
  // eslint-disable-next-line no-console
  console.error(`[visualizer-engine] fatal: ${msg}`);
  if (err instanceof Error && err.stack) {
    // eslint-disable-next-line no-console
    console.error(err.stack);
  }
  process.exit(1);
});
