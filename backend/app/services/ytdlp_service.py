"""Download audio from YouTube videos using pytubefix (with yt-dlp info fallback)."""
from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from functools import partial
from pathlib import Path
from typing import Callable, Optional

from app.config import settings
from app.utils.file_utils import get_asset_dir

logger = logging.getLogger(__name__)

# Path to the Netscape-format cookies file (kept for legacy compat)
COOKIES_PATH = settings.data_dir / "cookies.txt"

# Regex to extract a YouTube video ID from various URL formats
_YT_ID_RE = re.compile(
    r"(?:youtu\.be/|youtube\.com/(?:watch\?.*v=|embed/|v/|shorts/))"
    r"([\w-]{11})"
)


class YtDlpError(Exception):
    """Raised when a YouTube download/info fetch fails."""


def _sanitize_filename(title: str) -> str:
    """Remove characters that are unsafe for filenames."""
    sanitized = re.sub(r'[\\/:*?"<>|]', "", title)
    sanitized = sanitized.strip(". ")
    return sanitized[:120] or "download"


def extract_video_id(url: str) -> Optional[str]:
    """Pull the 11-char video ID out of a YouTube URL, or return None."""
    m = _YT_ID_RE.search(url)
    return m.group(1) if m else None


def _format_duration(seconds: int) -> str:
    """Format seconds into HH:MM:SS or MM:SS."""
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


# Lines that look like "MM:SS Title", "HH:MM:SS Title", or with leading
# bullet/track markers like "01. 04:10 — Title" or "▸ 4:10 - Title".
# We deliberately keep this simple: the line starts with optional decoration,
# then a timestamp, then a separator (space/-/—/–/.), then the title.
_TIMESTAMP_LINE_RE = re.compile(
    r"""^
        \s*
        (?:[\d]{1,3}[\.\)]\s+)?            # optional "01. " or "01) "
        (?:[▸▶•◦*\-–—]\s*)?                # optional bullet
        (?P<ts>\d{1,2}:\d{2}(?::\d{2})?)   # MM:SS or HH:MM:SS
        \s*[\-–—:.\)]?\s*                  # optional separator
        (?P<title>.+?)                     # title
        \s*$
    """,
    re.VERBOSE,
)


def _ts_to_seconds(ts: str) -> int:
    """Convert "MM:SS" or "HH:MM:SS" to seconds."""
    parts = [int(p) for p in ts.split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return parts[0] * 60 + parts[1]


def parse_chapters_from_description(description: str, total_duration: int = 0) -> list[dict]:
    """Extract chapter sections from a YouTube description block.

    Returns a list of ``{title, start, end, duration}`` dicts (seconds).

    YouTube's own chapter detection requires the FIRST timestamp to be
    ``0:00`` and at least 3 timestamps total. We're more lenient — we
    return all detected timestamp lines so the user can decide. The first
    chapter's ``end`` is the second's start; the last chapter ends at
    ``total_duration`` (or its own start if duration is unknown).
    """
    if not description:
        return []
    chapters: list[dict] = []
    seen_starts: set[int] = set()
    for raw in description.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _TIMESTAMP_LINE_RE.match(line)
        if not m:
            continue
        start = _ts_to_seconds(m.group("ts"))
        title = m.group("title").strip().strip("-–—:.")
        if not title or len(title) > 200:
            continue
        if start in seen_starts:
            continue
        seen_starts.add(start)
        chapters.append({"title": title, "start": start})

    if not chapters:
        return []

    # Sort by start time, then fill in `end` and `duration`.
    chapters.sort(key=lambda c: c["start"])
    for i, c in enumerate(chapters):
        if i + 1 < len(chapters):
            c["end"] = chapters[i + 1]["start"]
        else:
            c["end"] = max(total_duration, c["start"]) if total_duration else c["start"]
        c["duration"] = max(0, c["end"] - c["start"])
    return chapters


class YtDlpService:
    """Wraps pytubefix to download best-quality audio as MP3."""

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    async def fetch_info(self, url: str) -> dict:
        """Fetch video metadata (title, duration, thumbnail) without downloading."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, partial(self._fetch_info_sync, url))

    async def download_audio(
        self,
        url: str,
        channel_id: Optional[int] = None,
        target_dir: Optional[str] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> dict:
        """Download best audio from *url* and convert to MP3.

        Either ``channel_id`` (writes into the channel's asset directory and
        returns a path relative to ``settings.assets_dir``) OR ``target_dir``
        (writes directly to the absolute folder path, returns an absolute
        path) must be provided.

        Returns
        -------
        dict  with keys:
            filepath   – relative to settings.assets_dir when channel mode,
                          absolute path when target_dir mode
            absolute_path – always the absolute path on disk
            filename   – just the filename
            title      – video title
            duration   – audio duration in seconds
            file_size  – bytes on disk
            thumbnail  – thumbnail URL (if available)
            video_id   – YouTube video ID
            mode       – "channel" or "folder"
        """
        if channel_id is None and not target_dir:
            raise YtDlpError("Either channel_id or target_dir is required")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            partial(self._download_sync, url, channel_id, target_dir, on_progress),
        )

    # ------------------------------------------------------------------
    # Sync internals (run in thread executor)
    # ------------------------------------------------------------------

    def _fetch_info_sync(self, url: str) -> dict:
        """Fetch video info using pytubefix.

        Also parses chapter sections from the description (YouTube doesn't
        return chapters via pytubefix's API but creators conventionally
        list them as ``MM:SS Title`` lines in the description).
        """
        try:
            from pytubefix import YouTube

            yt = YouTube(url)
            duration = yt.length or 0
            description = yt.description or ""
            # pytubefix's `chapters` is usually empty — parse the
            # description ourselves as a fallback.
            chapters = parse_chapters_from_description(description, duration)
            return {
                "video_id": yt.video_id or "",
                "title": yt.title or "Unknown",
                "duration": duration,
                "thumbnail": yt.thumbnail_url or "",
                "uploader": yt.author or "",
                "view_count": yt.views,
                "chapters": chapters,
            }
        except Exception as exc:
            raise YtDlpError(f"Could not fetch video info: {exc}") from exc

    def _download_sync(
        self,
        url: str,
        channel_id: Optional[int],
        target_dir: Optional[str],
        on_progress: Optional[Callable[[float, str], None]],
    ) -> dict:
        from pytubefix import YouTube

        # Resolve output directory based on mode. Folder mode bypasses the
        # asset library entirely — the file lands directly in the user's
        # chosen folder and isn't tracked in the DB.
        if target_dir:
            output_dir = Path(target_dir).expanduser().resolve()
            output_dir.mkdir(parents=True, exist_ok=True)
            mode = "folder"
        else:
            output_dir = get_asset_dir(int(channel_id), "music")
            mode = "channel"

        if on_progress:
            on_progress(0.05, "Fetching video info...")

        # Progress callback for pytubefix
        progress_state = {"total": 0, "downloaded": 0}

        def _pytube_progress(stream, chunk, bytes_remaining):
            if progress_state["total"] == 0:
                progress_state["total"] = stream.filesize or (bytes_remaining + len(chunk))
            downloaded = progress_state["total"] - bytes_remaining
            progress_state["downloaded"] = downloaded
            if progress_state["total"] > 0:
                pct = downloaded / progress_state["total"]
                if on_progress:
                    on_progress(pct * 0.7, f"Downloading... {pct:.0%}")

        try:
            yt = YouTube(url, on_progress_callback=_pytube_progress)
            title = yt.title or "Unknown"
            video_id = yt.video_id or "unknown"
            duration = yt.length or 0
            thumbnail = yt.thumbnail_url or ""
        except Exception as exc:
            raise YtDlpError(f"Could not fetch video info: {exc}") from exc

        if on_progress:
            on_progress(0.1, "Selecting best audio stream...")

        # Get best audio stream
        audio_streams = yt.streams.filter(only_audio=True).order_by("abr").desc()
        if not audio_streams:
            raise YtDlpError("No audio streams available for this video")

        stream = audio_streams.first()
        logger.info(
            "Downloading audio: %s (%s, %s)",
            title, stream.abr, stream.mime_type,
        )

        if on_progress:
            on_progress(0.15, f"Downloading audio ({stream.abr})...")

        # Download to output_dir with a temp name
        try:
            temp_filename = f"yt_{video_id}_temp"
            downloaded_path = stream.download(
                output_path=str(output_dir),
                filename=temp_filename,
            )
            downloaded_path = Path(downloaded_path)
        except Exception as exc:
            raise YtDlpError(f"Download failed: {exc}") from exc

        if on_progress:
            on_progress(0.75, "Converting to MP3...")

        # Convert to MP3 using FFmpeg
        safe_title = _sanitize_filename(title)
        final_name = f"yt_{video_id}_{safe_title}.mp3"
        final_path = output_dir / final_name

        ffmpeg_cmd = [
            settings.ffmpeg_path or "ffmpeg",
            "-i", str(downloaded_path),
            "-vn",                  # no video
            "-acodec", "libmp3lame",
            "-ab", "192k",
            "-y",                   # overwrite
            str(final_path),
        ]

        try:
            import sys
            startupinfo = None
            if sys.platform == "win32":
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

            result = subprocess.run(
                ffmpeg_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                startupinfo=startupinfo,
                timeout=300,
            )
            if result.returncode != 0:
                stderr_text = result.stderr.decode("utf-8", errors="replace")
                logger.error("FFmpeg conversion failed: %s", stderr_text[-500:])
                raise YtDlpError(f"FFmpeg conversion failed (exit {result.returncode})")
        except subprocess.TimeoutExpired:
            raise YtDlpError("FFmpeg conversion timed out after 5 minutes")
        except FileNotFoundError:
            raise YtDlpError(
                "FFmpeg not found. Please install FFmpeg and ensure it's in PATH."
            )
        finally:
            # Clean up the temp downloaded file
            if downloaded_path.exists():
                try:
                    downloaded_path.unlink()
                except Exception:
                    pass

        if on_progress:
            on_progress(0.95, "Finalising...")

        if not final_path.exists():
            raise YtDlpError("MP3 file was not created after conversion")

        file_size = final_path.stat().st_size
        # In channel mode the path is relative to the assets root (used by
        # /files mount + DB Asset.filepath). In folder mode it's just the
        # absolute path the user picked — no asset record is created.
        absolute_path = str(final_path)
        if mode == "channel":
            try:
                filepath_value = final_path.relative_to(settings.assets_dir).as_posix()
            except ValueError:
                filepath_value = absolute_path
        else:
            filepath_value = absolute_path

        if on_progress:
            on_progress(1.0, "Done")

        return {
            "filepath": filepath_value,
            "absolute_path": absolute_path,
            "filename": final_name,
            "title": title,
            "duration": duration,
            "file_size": file_size,
            "thumbnail": thumbnail,
            "video_id": video_id,
            "mode": mode,
        }

    # ------------------------------------------------------------------
    # Multi-chapter split: download once, ffmpeg-cut into N MP3s
    # ------------------------------------------------------------------

    async def download_chapters(
        self,
        url: str,
        chapters: list[dict],
        channel_id: int,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> list[dict]:
        """Download the full audio once, then slice into N chapter MP3s.

        Each entry in ``chapters`` must have ``start`` (seconds), ``end``
        (seconds), and ``title``. Returns a list of dicts with the same
        shape as ``download_audio``'s result, one per saved chapter.
        """
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            partial(self._download_chapters_sync, url, chapters, channel_id, on_progress),
        )

    def _download_chapters_sync(
        self,
        url: str,
        chapters: list[dict],
        channel_id: int,
        on_progress: Optional[Callable[[float, str], None]],
    ) -> list[dict]:
        from pytubefix import YouTube

        if not chapters:
            raise YtDlpError("No chapters provided")

        output_dir = get_asset_dir(channel_id, "music")

        # 1) Pull the full audio to a temp file (no MP3 conversion yet —
        # ffmpeg cut will re-encode each slice).
        if on_progress:
            on_progress(0.05, "Fetching video info...")
        try:
            yt = YouTube(url)
            video_id = yt.video_id or "unknown"
            video_title = yt.title or "Unknown"
        except Exception as exc:
            raise YtDlpError(f"Could not fetch video info: {exc}") from exc

        if on_progress:
            on_progress(0.10, "Selecting best audio stream...")
        audio_streams = yt.streams.filter(only_audio=True).order_by("abr").desc()
        if not audio_streams:
            raise YtDlpError("No audio streams available for this video")
        stream = audio_streams.first()

        if on_progress:
            on_progress(0.15, f"Downloading audio ({stream.abr})...")
        try:
            temp_filename = f"yt_{video_id}_full_temp"
            downloaded_path = stream.download(
                output_path=str(output_dir),
                filename=temp_filename,
            )
            downloaded_path = Path(downloaded_path)
        except Exception as exc:
            raise YtDlpError(f"Download failed: {exc}") from exc

        # 2) Cut into chapter MP3s. ffmpeg -ss/-to + libmp3lame for each.
        results: list[dict] = []
        try:
            n = len(chapters)
            for i, ch in enumerate(chapters):
                start = float(ch.get("start", 0) or 0)
                end = float(ch.get("end", 0) or 0)
                title = (ch.get("title") or f"Chapter {i + 1}").strip()
                if end <= start:
                    logger.warning("Skipping chapter %r with non-positive duration", title)
                    continue

                if on_progress:
                    pct = 0.30 + (0.65 * (i / max(1, n)))
                    on_progress(pct, f"Cutting {i + 1}/{n}: {title}")

                safe_title = _sanitize_filename(title)
                final_name = f"yt_{video_id}_{i + 1:02d}_{safe_title}.mp3"
                final_path = output_dir / final_name

                cmd = [
                    settings.ffmpeg_path or "ffmpeg",
                    "-i", str(downloaded_path),
                    "-ss", f"{start}",
                    "-to", f"{end}",
                    "-vn",
                    "-acodec", "libmp3lame",
                    "-ab", "192k",
                    "-y",
                    str(final_path),
                ]
                try:
                    import sys as _sys
                    si = None
                    if _sys.platform == "win32":
                        si = subprocess.STARTUPINFO()
                        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    r = subprocess.run(
                        cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        startupinfo=si,
                        timeout=300,
                    )
                    if r.returncode != 0:
                        logger.error(
                            "ffmpeg cut failed for %s: %s",
                            title, r.stderr.decode("utf-8", errors="replace")[-300:],
                        )
                        continue
                except FileNotFoundError:
                    raise YtDlpError("FFmpeg not found.")

                if not final_path.exists():
                    continue
                file_size = final_path.stat().st_size
                relative_path = final_path.relative_to(settings.assets_dir).as_posix()
                results.append({
                    "filepath": relative_path,
                    "filename": final_name,
                    "title": title,
                    "duration": end - start,
                    "file_size": file_size,
                    "video_id": video_id,
                    "video_title": video_title,
                    "chapter_index": i,
                })
        finally:
            try:
                downloaded_path.unlink()
            except Exception:
                pass

        if on_progress:
            on_progress(1.0, "Done")

        if not results:
            raise YtDlpError("No chapters were successfully extracted")
        return results

    # ------------------------------------------------------------------
    # Video downloads (mirror of audio path)
    # ------------------------------------------------------------------

    async def download_video(
        self,
        url: str,
        channel_id: int,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> dict:
        """Download a YouTube video at the highest available quality.

        Mirror of ``download_audio`` but stores under the channel's
        ``video/`` folder. Always prefers adaptive video+audio (highest
        resolution available, any codec) muxed via FFmpeg into MP4 (or
        MKV when the codec combination doesn't fit MP4 cleanly). Falls
        back to progressive ONLY when the best progressive resolution
        equals or exceeds the best adaptive (rare — YouTube's
        progressive caps at 720p).

        No hard resolution cap — 4K / 1440p / 1080p all download at
        their native resolution.
        """
        if not channel_id:
            raise YtDlpError("channel_id is required")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            partial(self._download_video_sync, url, channel_id, on_progress),
        )

    def _download_video_sync(
        self,
        url: str,
        channel_id: int,
        on_progress: Optional[Callable[[float, str], None]],
        dest_path: Optional[Path] = None,
    ) -> dict:
        """Download a video to the channel's library OR to ``dest_path``.

        When ``dest_path`` is provided, that path is the literal output
        target (used by ``_download_video_sections_sync`` to write the
        intermediate full-video to a guaranteed-unique temp location
        that won't collide with existing asset files on disk). When
        omitted, the canonical asset-naming pattern under the channel
        video folder is used.
        """
        from pytubefix import YouTube

        output_dir = get_asset_dir(channel_id, "video")

        if on_progress:
            on_progress(0.05, "Fetching video info...")

        progress_state = {"total": 0}

        def _pytube_progress(stream, chunk, bytes_remaining):
            if progress_state["total"] == 0:
                progress_state["total"] = stream.filesize or (
                    bytes_remaining + len(chunk)
                )
            if progress_state["total"] > 0:
                pct = (progress_state["total"] - bytes_remaining) / progress_state["total"]
                if on_progress:
                    on_progress(0.10 + pct * 0.65, f"Downloading... {pct:.0%}")

        try:
            yt = YouTube(url, on_progress_callback=_pytube_progress)
            title = yt.title or "Unknown"
            video_id = yt.video_id or "unknown"
            duration = yt.length or 0
            thumbnail = yt.thumbnail_url or ""
        except Exception as exc:
            raise YtDlpError(f"Could not fetch video info: {exc}") from exc

        # ── Stream pick: best adaptive video + best audio, mux ────────
        # YouTube's progressive (audio+video in one stream) caps at 720p
        # in practice. Adaptive streams go up to 4K (and 8K for some
        # uploads) but require muxing a video-only track with a
        # separate audio track. We ALWAYS prefer adaptive when it's
        # higher resolution than progressive — which it almost always
        # is. Only when the best progressive >= best adaptive do we
        # skip the mux. No codec filter — vp9/av1/h264 all welcome.
        def _res_int(s) -> int:
            r = (s.resolution or "").lower()
            try:
                return int(r.rstrip("p"))
            except (ValueError, AttributeError):
                return 0

        if on_progress:
            on_progress(0.08, "Selecting best stream...")

        # Best adaptive video-only track (any container, any codec).
        video_pool = [
            s for s in yt.streams.filter(only_video=True)
            if _res_int(s) > 0
        ]
        video_pool.sort(key=_res_int, reverse=True)
        # Best progressive (audio+video bundled — caps at 720p on YT).
        progressive_streams = [
            s for s in yt.streams.filter(progressive=True)
            if _res_int(s) > 0
        ]
        progressive_streams.sort(key=_res_int, reverse=True)

        adaptive_res = _res_int(video_pool[0]) if video_pool else 0
        progressive_res = _res_int(progressive_streams[0]) if progressive_streams else 0

        # Pick the higher-quality path. Tie goes to progressive (saves
        # the mux step). If neither pool has anything, error out.
        use_adaptive = adaptive_res > progressive_res

        safe_title = _sanitize_filename(title)
        if dest_path is not None:
            final_path = dest_path
            final_name = final_path.name
            final_path.parent.mkdir(parents=True, exist_ok=True)
        else:
            final_name = f"yt_{video_id}_{safe_title}.mp4"
            final_path = output_dir / final_name

        if not use_adaptive and progressive_streams:
            stream = progressive_streams[0]
            logger.info(
                "Downloading progressive video: %s (%s)",
                title, stream.resolution,
            )
            try:
                temp_name = f"yt_{video_id}_video_temp"
                downloaded = stream.download(
                    output_path=str(output_dir),
                    filename=temp_name,
                )
                # Rename the temp download to the final name. The
                # progressive stream is already a playable MP4 — no
                # re-encode needed.
                if final_path.exists():
                    final_path.unlink()
                Path(downloaded).rename(final_path)
            except Exception as exc:
                raise YtDlpError(f"Download failed: {exc}") from exc
        elif video_pool:
            # Adaptive: pick the highest-res video (any codec) + best
            # audio (highest abr) and mux with FFmpeg.
            v_stream = video_pool[0]
            audio_pool = list(
                yt.streams.filter(only_audio=True).order_by("abr").desc()
            )
            if not audio_pool:
                raise YtDlpError("No audio stream available")
            a_stream = audio_pool[0]
            logger.info(
                "Downloading adaptive video+audio: %s (%s %s + %s %s)",
                title, v_stream.resolution,
                getattr(v_stream, "video_codec", "?"),
                a_stream.abr, getattr(a_stream, "audio_codec", "?"),
            )
            try:
                v_temp = v_stream.download(
                    output_path=str(output_dir),
                    filename=f"yt_{video_id}_video_temp",
                )
                a_temp = a_stream.download(
                    output_path=str(output_dir),
                    filename=f"yt_{video_id}_audio_temp",
                )
            except Exception as exc:
                raise YtDlpError(f"Download failed: {exc}") from exc

            if on_progress:
                on_progress(0.80, "Muxing video + audio...")

            # Try MP4 first with -c copy. If FFmpeg refuses because the
            # codec/container combination isn't supported (e.g. VP9
            # audio mismatch on older FFmpeg, or weird WebM Opus), fall
            # back to MKV which accepts every codec combination. dest_path
            # callers (sections) always specify .mp4 — if mp4 fails for
            # them, re-encode video to H.264 so the existing slicing
            # path stays intact.
            def _run_mux(out_path: Path, force_h264: bool = False) -> tuple[int, str]:
                cmd = [
                    settings.ffmpeg_path or "ffmpeg",
                    "-i", str(v_temp),
                    "-i", str(a_temp),
                    "-y",
                ]
                if force_h264:
                    # Last-resort re-encode for stubborn codecs into MP4.
                    cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac"]
                else:
                    cmd += ["-c", "copy"]
                cmd += [str(out_path)]
                import sys as _sys
                si = None
                if _sys.platform == "win32":
                    si = subprocess.STARTUPINFO()
                    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                r = subprocess.run(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    startupinfo=si, timeout=900,
                )
                err = r.stderr.decode("utf-8", errors="replace")[-400:] if r.returncode != 0 else ""
                return r.returncode, err

            try:
                rc, err = _run_mux(final_path)
                if rc != 0:
                    if dest_path is not None:
                        # Sections caller demanded a specific .mp4 path —
                        # re-encode to H.264/AAC so we can deliver that
                        # container.
                        logger.warning(
                            "mux -c copy failed (%s); re-encoding to H.264 for sections caller", err,
                        )
                        rc2, err2 = _run_mux(final_path, force_h264=True)
                        if rc2 != 0:
                            raise YtDlpError(f"Mux failed (re-encode exit {rc2}): {err2}")
                    else:
                        # Try MKV — copies anything.
                        mkv_path = final_path.with_suffix(".mkv")
                        rc2, err2 = _run_mux(mkv_path)
                        if rc2 != 0:
                            raise YtDlpError(f"Mux failed (mp4: {err}; mkv: {err2})")
                        # Swap the final path to .mkv. Update final_name
                        # so the asset row records the right filename.
                        final_path = mkv_path
                        final_name = mkv_path.name
            except subprocess.TimeoutExpired:
                raise YtDlpError("Mux timed out after 15 minutes")
            except FileNotFoundError:
                raise YtDlpError("FFmpeg not found.")
            finally:
                for p in (v_temp, a_temp):
                    try:
                        Path(p).unlink()
                    except Exception:
                        pass
        else:
            raise YtDlpError("No suitable video stream available")

        if not final_path.exists():
            raise YtDlpError("Video file was not created")

        if on_progress:
            on_progress(0.97, "Finalising...")

        file_size = final_path.stat().st_size
        try:
            filepath_value = final_path.relative_to(settings.assets_dir).as_posix()
        except ValueError:
            filepath_value = str(final_path)

        if on_progress:
            on_progress(1.0, "Done")

        return {
            "filepath": filepath_value,
            "absolute_path": str(final_path),
            "filename": final_name,
            "title": title,
            "duration": duration,
            "file_size": file_size,
            "thumbnail": thumbnail,
            "video_id": video_id,
            "mode": "full",
        }

    async def download_video_sections(
        self,
        url: str,
        sections: list[dict],
        channel_id: int,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> list[dict]:
        """Download the full video once, slice into N MP4 sections.

        Each entry in ``sections`` must have ``start`` (seconds), ``end``
        (seconds), and ``title``. Mirrors ``download_chapters`` but
        produces MP4s under the channel's ``video/`` folder. Section
        cuts are sample-accurate (re-encoded via libx264 + aac).
        """
        if not sections:
            raise YtDlpError("No sections provided")
        if not channel_id:
            raise YtDlpError("channel_id is required")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            partial(
                self._download_video_sections_sync,
                url, sections, channel_id, on_progress,
            ),
        )

    def _download_video_sections_sync(
        self,
        url: str,
        sections: list[dict],
        channel_id: int,
        on_progress: Optional[Callable[[float, str], None]],
    ) -> list[dict]:
        from uuid import uuid4

        output_dir = get_asset_dir(channel_id, "video")

        # 1) Download full video to a GUARANTEED-UNIQUE temp path. We
        # reuse ``_download_video_sync`` via the ``dest_path`` override
        # so the intermediate full-video doesn't collide with the
        # canonical asset filename pattern. Collision = a previous
        # "Download full video" of the same URL has a real Asset row
        # pointing at the canonical path; if we wrote there + deleted
        # at end, we'd corrupt that Asset's file. Progress weight:
        # 0-60% download, 60-95% slicing.
        temp_full = output_dir / f".tmp_section_source_{uuid4().hex[:12]}.mp4"

        def _dl_progress(frac: float, msg: str) -> None:
            if on_progress:
                on_progress(frac * 0.60, msg)

        full = self._download_video_sync(
            url, channel_id, _dl_progress, dest_path=temp_full,
        )
        video_id = full.get("video_id") or "unknown"
        video_title = full.get("title") or "Unknown"

        # 2) Cut each section with re-encode for sample accuracy.
        results: list[dict] = []
        try:
            n = len(sections)
            for i, sec in enumerate(sections):
                start = float(sec.get("start", 0) or 0)
                end = float(sec.get("end", 0) or 0)
                title = (sec.get("title") or f"Section {i + 1}").strip()
                if end <= start:
                    logger.warning(
                        "Skipping section %r with non-positive duration", title,
                    )
                    continue

                if on_progress:
                    pct = 0.60 + (0.35 * (i / max(1, n)))
                    on_progress(pct, f"Cutting {i + 1}/{n}: {title}")

                safe_title = _sanitize_filename(title)
                final_name = f"yt_{video_id}_{i + 1:02d}_{safe_title}.mp4"
                final_path = output_dir / final_name

                cmd = [
                    settings.ffmpeg_path or "ffmpeg",
                    "-i", str(temp_full),
                    "-ss", f"{start}",
                    "-to", f"{end}",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-c:a", "aac", "-b:a", "192k",
                    "-pix_fmt", "yuv420p",
                    "-y",
                    str(final_path),
                ]
                try:
                    import sys as _sys
                    si = None
                    if _sys.platform == "win32":
                        si = subprocess.STARTUPINFO()
                        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    r = subprocess.run(
                        cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        startupinfo=si,
                        timeout=1200,  # 20 min per section
                    )
                    if r.returncode != 0:
                        logger.error(
                            "ffmpeg section cut failed for %s: %s",
                            title,
                            r.stderr.decode("utf-8", errors="replace")[-300:],
                        )
                        continue
                except FileNotFoundError:
                    raise YtDlpError("FFmpeg not found.")

                if not final_path.exists():
                    continue

                file_size = final_path.stat().st_size
                relative_path = final_path.relative_to(settings.assets_dir).as_posix()
                results.append({
                    "filepath": relative_path,
                    "filename": final_name,
                    "title": title,
                    "duration": end - start,
                    "file_size": file_size,
                    "video_id": video_id,
                    "video_title": video_title,
                    "section_index": i,
                    "mode": "section",
                })
        finally:
            try:
                temp_full.unlink()
            except Exception:
                pass

        if on_progress:
            on_progress(1.0, "Done")

        if not results:
            raise YtDlpError("No sections were successfully extracted")
        return results


# Module-level singleton
ytdlp_service = YtDlpService()
