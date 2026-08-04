import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Asset } from "@/types/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaTrack {
  id: number;
  title: string;
  subtitle?: string;
  url: string;
  duration?: number;
  type: "audio" | "video";
  asset?: Asset;
}

interface MediaPlayerState {
  /** Currently loaded track (or null) */
  track: MediaTrack | null;
  /** Ordered playlist */
  playlist: MediaTrack[];
  /** Is the media actively playing? */
  playing: boolean;
  /** Current playback position in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Volume 0–1 */
  volume: number;
  /** Is the footer player visible? */
  visible: boolean;
}

interface MediaPlayerActions {
  /** Play a single track (replaces playlist) */
  play: (track: MediaTrack) => void;
  /** Load a playlist and optionally start at an index */
  playList: (tracks: MediaTrack[], startIndex?: number) => void;
  /** Toggle play / pause */
  togglePlay: () => void;
  /** Pause playback */
  pause: () => void;
  /** Resume playback */
  resume: () => void;
  /** Seek to a position (seconds) */
  seek: (time: number) => void;
  /** Set volume 0–1 */
  setVolume: (v: number) => void;
  /** Skip to next track in playlist */
  next: () => void;
  /** Skip to previous track */
  prev: () => void;
  /** Close / dismiss the player */
  close: () => void;
}

type MediaPlayerCtx = MediaPlayerState & MediaPlayerActions;

const Ctx = createContext<MediaPlayerCtx | null>(null);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaPlayer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMediaPlayer must be used inside MediaPlayerProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function MediaPlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [track, setTrack] = useState<MediaTrack | null>(null);
  const [playlist, setPlaylist] = useState<MediaTrack[]>([]);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.8);
  const [visible, setVisible] = useState(false);

  // Ensure we always have an <audio> element
  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.volume = 0.8;
    }

    const el = audioRef.current;

    const onTimeUpdate = () => setCurrentTime(el.currentTime);
    const onDuration = () => setDuration(el.duration || 0);
    const onEnded = () => {
      setPlaying(false);
      // Auto-advance to next track
      handleNextInternal();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDuration);
    el.addEventListener("ended", onEnded);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);

    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDuration);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ref-based next handler so the ended callback always has latest state
  const trackRef = useRef(track);
  const playlistRef = useRef(playlist);
  trackRef.current = track;
  playlistRef.current = playlist;

  const handleNextInternal = useCallback(() => {
    const pl = playlistRef.current;
    const cur = trackRef.current;
    if (!cur || pl.length === 0) return;
    const idx = pl.findIndex((t) => t.id === cur.id);
    if (idx < pl.length - 1) {
      loadAndPlay(pl[idx + 1]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAndPlay = useCallback((t: MediaTrack) => {
    const el = audioRef.current;
    if (!el) return;
    setTrack(t);
    setVisible(true);
    el.src = t.url;
    el.load();
    el.play().catch(() => {});
  }, []);

  // ── Public API ──

  const play = useCallback(
    (t: MediaTrack) => {
      setPlaylist([t]);
      loadAndPlay(t);
    },
    [loadAndPlay],
  );

  const playListFn = useCallback(
    (tracks: MediaTrack[], startIndex = 0) => {
      setPlaylist(tracks);
      if (tracks.length > 0) {
        loadAndPlay(tracks[startIndex] || tracks[0]);
      }
    },
    [loadAndPlay],
  );

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, []);

  const pauseFn = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const resumeFn = useCallback(() => {
    audioRef.current?.play().catch(() => {});
  }, []);

  const seek = useCallback((time: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = time;
    setCurrentTime(time);
  }, []);

  const setVolume = useCallback((v: number) => {
    const el = audioRef.current;
    if (el) el.volume = v;
    setVolumeState(v);
  }, []);

  const next = useCallback(() => {
    if (!track || playlist.length === 0) return;
    const idx = playlist.findIndex((t) => t.id === track.id);
    if (idx < playlist.length - 1) {
      loadAndPlay(playlist[idx + 1]);
    }
  }, [track, playlist, loadAndPlay]);

  const prev = useCallback(() => {
    if (!track || playlist.length === 0) return;
    const el = audioRef.current;
    // If more than 3s in, restart current track
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      return;
    }
    const idx = playlist.findIndex((t) => t.id === track.id);
    if (idx > 0) {
      loadAndPlay(playlist[idx - 1]);
    }
  }, [track, playlist, loadAndPlay]);

  const close = useCallback(() => {
    audioRef.current?.pause();
    setVisible(false);
    setTrack(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setPlaylist([]);
  }, []);

  const ctx: MediaPlayerCtx = {
    track,
    playlist,
    playing,
    currentTime,
    duration,
    volume,
    visible,
    play,
    playList: playListFn,
    togglePlay,
    pause: pauseFn,
    resume: resumeFn,
    seek,
    setVolume,
    next,
    prev,
    close,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}
