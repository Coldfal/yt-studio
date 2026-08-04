export interface CustomText {
  id: string;
  text: string;
  x: number; // 0-1 fraction of canvas width (center of text)
  y: number; // 0-1 fraction of canvas height (baseline)
  size: number; // px at 1920 width
  color: string;
  weight: "normal" | "bold" | "black";
  align: "left" | "center" | "right";
}

export interface ProjectConfig {
  // Visualizer
  waveformScale: number;
  waveformSmoothing: number;
  reactivity: number;
  spectrumFill: "filled" | "outline";

  // Linear layout (linear-bars, linear-dots)
  linearPosition: "center" | "bottom";
  linearRepeat: number; // 1-10, horizontal repetitions
  linearBarColor: string; // dedicated color for linear bars/dots (overrides waveColor1)
  linearYOffset: number; // -0.4 to 0.4, fraction of H — fine-tune vertical position
  linearWidth: number; // 0.3 to 1.0, fraction of W — how wide the bars span
  linearCenterTextSource: "none" | "custom" | "artist" | "track";
  linearCenterText: string; // used when source = "custom"
  linearCenterTextSize: number; // px at 1920 width
  linearCenterTextOffsetY: number; // -0.5 .. 0.5, fraction of maxBarH, negative = up

  // Custom draggable text overlays
  customTexts: CustomText[];

  // Colors
  waveColor1: string;
  waveColor2: string;
  backgroundColor: string;
  accentColor: string;

  // Text
  artistName: string;
  trackName: string;
  fontFamily: string;
  fontSize: number;
  textPosition: "top" | "bottom" | "center";
  textColor: string;

  // Backdrop
  backgroundFit: "cover" | "contain" | "fill";
  reflection: "none" | "2-way" | "4-way";
  backgroundRotate: number;
  backgroundFilter: boolean;
  backgroundDrift: boolean;
  backgroundRumble: boolean;

  // Elements
  particles: boolean;
  particleStyle: "floating" | "snow" | "fireflies" | "rain" | "stars" | "smoke";
  particleDensity: number;
  particleColor: string;

  // Logo
  logoEnabled: boolean; // show the center logo / glow / placeholder circle
  logoScale: number;
  logoBorderRadius: number;
  /** Server-side path to the uploaded logo image (relative to
   *  ``settings.assets_dir``). Set when the user uploads a logo through the
   *  ImagesPanel — both the live preview AND the offline render need to
   *  see this. Without it the engine has no logo to draw. */
  logo_filepath?: string | null;

  // Overlay (corner image/logo/CTA)
  overlayEnabled: boolean;
  /** When set, the renderer resolves a built-in transparent overlay asset
   *  shipped with the app (e.g. ``"subscribe"`` →
   *  ``data/builtin/subscribe-animation.png``). Survives save/restore of a
   *  visualizer preset, unlike the live ``overlayUrl`` blob. */
  overlayBuiltin?: string | null;
  /** Server-side path to a user-uploaded custom overlay (PNG/WebP with
   *  alpha). Mirrors ``logo_filepath`` — set when the Images panel uploads
   *  a custom overlay so the offline render's chromakey/composite step
   *  finds the file. Mutually exclusive in practice with
   *  ``overlayBuiltin``: setting one clears the other. */
  overlay_filepath?: string | null;
  /**
   * Anchor strategy for the corner overlay's top-left corner.
   *
   * - One of the four corner names: anchored to that corner with a 3%
   *   safe-area margin, then optionally nudged by ``overlayOffsetX`` /
   *   ``overlayOffsetY`` (each in [-50, 50] as % of canvas dimension).
   * - ``"custom"``: ``overlayOffsetX`` and ``overlayOffsetY`` become the
   *   ABSOLUTE position of the overlay's top-left corner, expressed as
   *   % of canvas dimension (0 = flush left/top, 100 = flush right/
   *   bottom edge of the canvas). No anchor, no margin. This is what
   *   the dashboard's precise X/Y inputs use so the user can type
   *   ``X=72.5, Y=88`` and land the overlay exactly there.
   */
  overlayPosition:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "custom";
  overlayScale: number;
  overlayOpacity: number;
  overlayOffsetX: number; // -50 to 50, percentage of canvas width
  overlayOffsetY: number; // -50 to 50, percentage of canvas height
  // Timed overlay: null = show for entire video; seconds otherwise
  overlayStartTime: number | null; // seconds from start, null = 0
  overlayEndTime: number | null;   // seconds from start, null = show forever
  overlayFadeIn: number;           // fade-in duration in seconds (0 = instant)
  overlayFadeOut: number;          // fade-out duration in seconds (0 = instant)

  // Background type
  backgroundType: "image" | "video";

  // Beat effects
  beatShake: boolean;
  beatZoom: boolean;
  beatShakeIntensity: number;
  beatZoomIntensity: number;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  waveformScale: 1.0,
  waveformSmoothing: 0.7,
  reactivity: 0.6,
  spectrumFill: "filled",

  linearPosition: "bottom",
  linearRepeat: 6,
  linearBarColor: "#ff4444",
  linearYOffset: 0.08,
  linearWidth: 1.0,
  linearCenterTextSource: "none",
  linearCenterText: "",
  linearCenterTextSize: 140,
  linearCenterTextOffsetY: 0,

  customTexts: [],

  waveColor1: "#ffffff",
  waveColor2: "#a855f7",
  backgroundColor: "#0f0f1a",
  accentColor: "#ec4899",

  artistName: "",
  trackName: "",
  fontFamily: "Geist",
  fontSize: 32,
  textPosition: "bottom",
  textColor: "#ffffff",

  backgroundFit: "cover",
  reflection: "none",
  backgroundRotate: 0,
  backgroundFilter: false,
  backgroundDrift: false,
  backgroundRumble: false,

  particles: true,
  particleStyle: "floating",
  particleDensity: 50,
  particleColor: "#ffffff",

  logoEnabled: false,
  logoScale: 1.0,
  logoBorderRadius: 50,
  logo_filepath: null,

  overlayEnabled: false,
  overlayBuiltin: null,
  overlay_filepath: null,
  overlayPosition: "bottom-right",
  overlayScale: 0.5,
  overlayOpacity: 0.8,
  overlayOffsetX: 0,
  overlayOffsetY: 0,
  overlayStartTime: null,
  overlayEndTime: null,
  overlayFadeIn: 0.5,
  overlayFadeOut: 0.5,

  backgroundType: "image",

  beatShake: false,
  beatZoom: false,
  beatShakeIntensity: 0.6,
  beatZoomIntensity: 0.5,
};

// A single audio track in the project's playlist. Projects can have 1+ of
// these; they play back sequentially in order.
export interface AudioTrack {
  url: string;      // persisted URL (e.g. /uploads/foo.mp3)
  name: string;     // original filename for display
  duration: number; // seconds
}

export interface AudioWaveformData {
  sampleRate: number;
  duration: number;
  fps: number;
  frameCount: number;
  amplitude: number[];    // 0-1 per frame
  bass: number[];         // 0-1 per frame (20-250Hz)
  mid: number[];          // 0-1 per frame (250-2kHz)
  treble: number[];       // 0-1 per frame (2-16kHz)
  beats: number[];        // frame indices of detected beats
  spectrum: number[][];   // per-frame: array of ~64 frequency bins, 0-1
}
