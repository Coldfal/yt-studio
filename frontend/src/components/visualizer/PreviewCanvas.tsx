

import { useRef, useEffect, useCallback } from "react";
import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { generateProceduralFreq } from "./preset-renderers";
import type { ProjectConfig } from "@/types/visualizer";
import {
  renderFrame,
  createBeatState,
  hitTestCustomText,
} from "./frame-renderer";
// Note: MV's client-side exporter (MediaRecorder based) is not used here —
// the server handles rendering via the visualizer_engine sidecar.

// ─── Component ───────────────────────────────────────────────────────

export function PreviewCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const beatAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeRef = useRef(0);
  const lastFrameRef = useRef(0);
  const beatRef = useRef(createBeatState());
  const logoImgRef = useRef<HTMLImageElement | null>(null);
  const logoLoadedRef = useRef<string | null>(null);
  const bgImgRef = useRef<HTMLImageElement | null>(null);
  const bgLoadedRef = useRef<string | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoLoadedRef = useRef<string | null>(null);
  const overlayImgRef = useRef<HTMLImageElement | null>(null);
  const overlayLoadedRef = useRef<string | null>(null);
  // Optional video element for animated overlays (e.g. a chroma-keyed
  // Subscribe animation served as transparent WebM). When set, drawCornerOverlay
  // draws the current video frame instead of the still image.
  const overlayVideoRef = useRef<HTMLVideoElement | null>(null);
  const overlayVideoLoadedRef = useRef<string | null>(null);

  const setCanvasEl = useVisualizerEditorStore((s) => s.setCanvasEl);

  // Register this canvas in the store so PresetManager can capture snapshots.
  useEffect(() => {
    setCanvasEl(canvasRef.current);
    return () => setCanvasEl(null);
  }, [setCanvasEl]);

  const config = useVisualizerEditorStore((s) => s.config);
  const audioUrl = useVisualizerEditorStore((s) => s.audioUrl);
  const audioTracks = useVisualizerEditorStore((s) => s.audioTracks);
  const currentTrackIndex = useVisualizerEditorStore((s) => s.currentTrackIndex);
  const isPlaying = useVisualizerEditorStore((s) => s.isPlaying);
  const logoUrl = useVisualizerEditorStore((s) => s.logoUrl);
  const backgroundUrl = useVisualizerEditorStore((s) => s.backgroundUrl);
  const overlayUrl = useVisualizerEditorStore((s) => s.overlayUrl);
  const setOverlayUrl = useVisualizerEditorStore((s) => s.setOverlayUrl);
  const presetId = useVisualizerEditorStore((s) => s.presetId);

  // Saved presets reference the built-in Subscribe animation via
  // ``config.overlayBuiltin`` (a marker that survives JSON storage), but
  // the actual blob URL lives in the store. When a preset is restored,
  // populate overlayUrl from the marker so the animation reappears.
  useEffect(() => {
    const builtin = (config as ProjectConfig & { overlayBuiltin?: string | null }).overlayBuiltin;
    if (builtin === "subscribe" && overlayUrl !== "/subscribe-animation.webm") {
      setOverlayUrl("/subscribe-animation.webm");
    } else if (!builtin && overlayUrl === "/subscribe-animation.webm" && !config.overlayEnabled) {
      // The preset turned the overlay off — clear the URL too.
      setOverlayUrl(null);
    }
  }, [config, overlayUrl, setOverlayUrl]);
  

  // Latest values from the store read by the RAF loop via refs, so config
  // changes never restart the animation (which used to cause flicker).
  const configRef = useRef<ProjectConfig>(config);
  const presetIdRef = useRef<string | null | undefined>(presetId);
  const isPlayingRef = useRef<boolean>(isPlaying);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { presetIdRef.current = presetId; }, [presetId]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // ── Logo image loading ────────────────────────────────────────────
  useEffect(() => {
    if (!logoUrl) {
      logoImgRef.current = null;
      logoLoadedRef.current = null;
      return;
    }
    if (logoUrl === logoLoadedRef.current) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      logoImgRef.current = img;
      logoLoadedRef.current = logoUrl;
    };
    img.onerror = () => { logoImgRef.current = null; };
    img.src = logoUrl;
  }, [logoUrl]);

  // ── Background image ────────────────────────────────────────────
  useEffect(() => {
    const bgUrl = backgroundUrl || logoUrl;
    if (!bgUrl) {
      bgImgRef.current = null;
      bgLoadedRef.current = null;
      return;
    }
    if (bgUrl === bgLoadedRef.current) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgImgRef.current = img;
      bgLoadedRef.current = bgUrl;
    };
    img.onerror = () => { bgImgRef.current = null; };
    img.src = bgUrl;
  }, [backgroundUrl, logoUrl]);

  // ── Background video ────────────────────────────────────────────
  useEffect(() => {
    if (config.backgroundType !== "video") {
      if (bgVideoRef.current) {
        bgVideoRef.current.pause();
        bgVideoRef.current.src = "";
      }
      bgVideoRef.current = null;
      bgVideoLoadedRef.current = null;
      return;
    }
    const bgUrl = backgroundUrl;
    if (!bgUrl) {
      bgVideoRef.current = null;
      bgVideoLoadedRef.current = null;
      return;
    }
    if (bgUrl === bgVideoLoadedRef.current) return;
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.src = bgUrl;
    video.play().catch(() => {});
    bgVideoRef.current = video;
    bgVideoLoadedRef.current = bgUrl;
    return () => {
      video.pause();
      video.src = "";
    };
  }, [backgroundUrl, config.backgroundType]);

  // ── Overlay image OR video ───────────────────────────────────────
  // Detect video extensions and load via <video>; otherwise <img>.
  useEffect(() => {
    // Tear down previous video if any
    if (overlayVideoRef.current) {
      try {
        overlayVideoRef.current.pause();
        overlayVideoRef.current.src = "";
      } catch { /* noop */ }
      overlayVideoRef.current = null;
      overlayVideoLoadedRef.current = null;
    }
    if (!overlayUrl) {
      overlayImgRef.current = null;
      overlayLoadedRef.current = null;
      return;
    }

    const isVideo = /\.(webm|mp4|mov)(\?|$)/i.test(overlayUrl);
    if (isVideo) {
      // Animated transparent overlay (e.g. our built-in Subscribe WebM)
      overlayImgRef.current = null;
      overlayLoadedRef.current = null;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.loop = true;
      video.src = overlayUrl;
      video.play().catch(() => {});
      overlayVideoRef.current = video;
      overlayVideoLoadedRef.current = overlayUrl;
      return () => {
        try {
          video.pause();
          video.src = "";
        } catch { /* noop */ }
      };
    }

    // Still image path
    if (overlayUrl === overlayLoadedRef.current) return;
    const img = new Image();
    // Data URLs are same-origin — setting crossOrigin breaks the load
    // on Chrome/Safari for inline SVGs. Only set for http(s) sources.
    if (!overlayUrl.startsWith("data:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      overlayImgRef.current = img;
      overlayLoadedRef.current = overlayUrl;
    };
    img.onerror = () => { overlayImgRef.current = null; };
    img.src = overlayUrl;
  }, [overlayUrl]);

  // ── Audio element ────────────────────────────────────────────────
  // Whenever the current track's URL changes we spin up a fresh <audio>
  // element. Web Audio's MediaElementSource is one-shot per element, so
  // the old source must also be torn down and a new one wired into the
  // existing analysers.
  useEffect(() => {
    if (!audioUrl) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      if (sourceRef.current) {
        try { sourceRef.current.disconnect(); } catch { /* noop */ }
        sourceRef.current = null;
      }
      return;
    }

    const audio = new Audio(audioUrl);
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;
    audio.addEventListener("loadedmetadata", () => {
      if (audio.duration && isFinite(audio.duration)) {
        useVisualizerEditorStore.getState().setAudioDuration(audio.duration);
      }
    });

    // Re-wire source → analysers on the shared context, if it's already up.
    const ctx = audioContextRef.current;
    const analyser = analyserRef.current;
    const beatAnalyser = beatAnalyserRef.current;
    if (ctx && analyser && beatAnalyser) {
      if (sourceRef.current) {
        try { sourceRef.current.disconnect(); } catch { /* noop */ }
      }
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      source.connect(beatAnalyser);
      sourceRef.current = source;
    }

    return () => {
      audio.pause();
      audio.src = "";
    };
  }, [audioUrl]);

  // ── Audio pipeline (context + analysers) ─────────────────────────
  // First call: create AudioContext, analyser nodes, and source. Later
  // calls reuse them. Source creation for a fresh <audio> element is
  // handled in the audioUrl effect above.
  const ensureAudioPipeline = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return null;
    if (audioContextRef.current && sourceRef.current) {
      return audioContextRef.current;
    }

    const ctx = audioContextRef.current ?? new AudioContext();
    const currentPreset = presetIdRef.current;
    const currentConfig = configRef.current;

    let analyser = analyserRef.current;
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = currentPreset === "trap-nation" ? 16384 : 2048;
      analyser.smoothingTimeConstant = currentPreset === "trap-nation" ? 0.1 : currentConfig.waveformSmoothing;
      if (currentPreset === "trap-nation") {
        analyser.minDecibels = -40;
        analyser.maxDecibels = -30;
      }
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
    }

    let beatAnalyser = beatAnalyserRef.current;
    if (!beatAnalyser) {
      beatAnalyser = ctx.createAnalyser();
      beatAnalyser.fftSize = 2048;
      beatAnalyser.smoothingTimeConstant = 0.5;
      beatAnalyserRef.current = beatAnalyser;
    }

    if (!sourceRef.current) {
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      source.connect(beatAnalyser);
      sourceRef.current = source;
    }

    audioContextRef.current = ctx;
    return ctx;
  }, []);

  // ── Play/pause ───────────────────────────────────────────────────
  // audioUrl is in the deps so that when the playlist advances to the
  // next track (new <audio> element, same `isPlaying`=true), we
  // re-invoke play() on the fresh element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      const ctx = ensureAudioPipeline();
      if (analyserRef.current) {
        const a = analyserRef.current;
        if (presetId === "trap-nation") {
          a.fftSize = 16384;
          a.smoothingTimeConstant = 0.1;
          a.minDecibels = -40;
          a.maxDecibels = -30;
        } else {
          a.fftSize = 2048;
          a.smoothingTimeConstant = config.waveformSmoothing;
          a.minDecibels = -100;
          a.maxDecibels = -30;
        }
      }
      ctx?.resume();
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [isPlaying, audioUrl, config.waveformSmoothing, presetId, ensureAudioPipeline]);

  // ── Seek ────────────────────────────────────────────────────────
  const seekTo = useVisualizerEditorStore((s) => s.seekTo);
  useEffect(() => {
    if (seekTo === null) return;
    const audio = audioRef.current;
    if (audio) audio.currentTime = seekTo;
    useVisualizerEditorStore.setState({ seekTo: null });
  }, [seekTo]);

  // ── Time tracking ────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => {
      useVisualizerEditorStore.setState({ currentTime: audio.currentTime });
    };
    const onEnded = () => {
      const state = useVisualizerEditorStore.getState();
      const nextIdx = state.currentTrackIndex + 1;
      if (nextIdx < state.audioTracks.length) {
        // Advance to next track; keep `isPlaying` true so the
        // play/pause effect auto-starts it after the audio element
        // is re-created.
        useVisualizerEditorStore.setState({
          currentTrackIndex: nextIdx,
          audioUrl: state.audioTracks[nextIdx].url,
          currentTime: 0,
        });
      } else {
        // End of playlist — rewind to the first track, stop.
        useVisualizerEditorStore.setState({
          currentTrackIndex: 0,
          audioUrl: state.audioTracks[0]?.url ?? null,
          currentTime: 0,
          isPlaying: false,
        });
      }
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl]);

  // ── Render loop ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const container = canvas.parentElement;
    if (container) {
      const aspect = 16 / 9;
      const maxW = container.clientWidth - 32;
      const maxH = container.clientHeight - 32;
      let w = maxW;
      let h = w / aspect;
      if (h > maxH) {
        h = maxH;
        w = h * aspect;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = 1920;
      canvas.height = 1080;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    lastFrameRef.current = 0;

    const draw = (timestamp: number) => {
      animFrameRef.current = requestAnimationFrame(draw);
      const config = configRef.current;
      const presetId = presetIdRef.current;
      const isPlaying = isPlayingRef.current;

      if (!lastFrameRef.current) lastFrameRef.current = timestamp;
      const dt = Math.min((timestamp - lastFrameRef.current) / 1000, 0.1);
      lastFrameRef.current = timestamp;
      timeRef.current += dt;
      const t = timeRef.current;

      const W = canvas.width;
      const H = canvas.height;

      let freq: number[];
      if (analyserRef.current && isPlaying) {
        const raw = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(raw);
        freq = Array.from(raw).map((v) => v / 255);
      } else if (presetId === "trap-nation") {
        freq = new Array(128).fill(0);
      } else {
        freq = generateProceduralFreq(t);
      }

      let beatFreq: number[];
      if (beatAnalyserRef.current && isPlaying) {
        const beatRaw = new Uint8Array(beatAnalyserRef.current.frequencyBinCount);
        beatAnalyserRef.current.getByteFrequencyData(beatRaw);
        beatFreq = Array.from(beatRaw).map((v) => v / 255);
      } else {
        beatFreq = freq;
      }

      // Use the audio element's currentTime for overlay visibility so the
      // timed CTA in preview matches where it'll appear in the rendered
      // video. When no audio is loaded yet, fall back to wall-clock t.
      const audioEl = audioRef.current;
      const overlayTime =
        audioEl && isFinite(audioEl.currentTime) && audioEl.currentTime > 0
          ? audioEl.currentTime
          : t;

      renderFrame({
        ctx,
        canvas,
        W,
        H,
        t,
        overlayTime,
        dt,
        freq,
        beatFreq,
        beatState: beatRef.current,
        config,
        presetId,
        logoImg: logoImgRef.current,
        bgImg: bgImgRef.current,
        bgVideo: bgVideoRef.current,
        overlayImg: overlayImgRef.current,
        overlayVideo: overlayVideoRef.current,
      });
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  // ── Custom text drag ────────────────────────────────────────────
  const dragRef = useRef<{ index: number; offsetX: number; offsetY: number } | null>(null);

  const clientToCanvas = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const texts = configRef.current.customTexts;
    for (let i = texts.length - 1; i >= 0; i--) {
      if (hitTestCustomText(ctx, canvas.width, canvas.height, texts[i], x, y)) {
        dragRef.current = {
          index: i,
          offsetX: x - texts[i].x * canvas.width,
          offsetY: y - texts[i].y * canvas.height,
        };
        break;
      }
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const newX = Math.max(0, Math.min(1, (x - drag.offsetX) / canvas.width));
    const newY = Math.max(0, Math.min(1, (y - drag.offsetY) / canvas.height));
    const { config: currentConfig, updateConfig } = useVisualizerEditorStore.getState();
    const texts = currentConfig.customTexts.map((t, idx) =>
      idx === drag.index ? { ...t, x: newX, y: newY } : t,
    );
    updateConfig({ customTexts: texts });
  };

  const onMouseUp = () => {
    dragRef.current = null;
  };

  const onMouseMoveHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (dragRef.current) {
      onMouseMove(e);
      canvas.style.cursor = "grabbing";
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const texts = configRef.current.customTexts;
    let over = false;
    for (let i = texts.length - 1; i >= 0; i--) {
      if (hitTestCustomText(ctx, canvas.width, canvas.height, texts[i], x, y)) {
        over = true;
        break;
      }
    }
    canvas.style.cursor = over ? "grab" : "default";
  };

  return (
    <canvas
      ref={canvasRef}
      className="rounded-lg shadow-2xl shadow-primary/10"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMoveHover}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    />
  );
}
