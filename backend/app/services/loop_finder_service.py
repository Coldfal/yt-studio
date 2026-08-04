"""Find seamless loop points in audio assets.

Wraps PyMusicLooper (https://github.com/arkrow/PyMusicLooper) to find
musically-coherent loop pairs in a music asset and, optionally, export
a new audio file that loops the segment cleanly to a target duration.

Why this exists
---------------
The compose pipeline already had a "loop the music to fill the target
duration" path, but it just concatenated the same track end-to-end —
listeners hear the seam every loop boundary. PyMusicLooper finds a pair
of similar musical positions inside the track so we can splice from the
end-position back to the start-position with a tiny crossfade. The user
gets a 1-hour track that sounds continuous instead of obviously looped.

Runtime / threading
-------------------
The analysis is CPU-bound (chroma + STFT + pairwise scoring via numba).
Numba releases the GIL during the heavy loops, so calling these helpers
through ``loop.run_in_executor`` from an async endpoint is fine — no
need for a process pool. Typical 3-min track lands in 5–20s on a modern
desktop CPU; the first call after process start takes longer because of
numba's JIT warmup.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LoopCandidate:
    """A single loop suggestion, in seconds (the user-facing unit).

    Sample indices are kept around because PyMusicLooper's export APIs
    take samples, not seconds, and converting back via
    ``seconds_to_samples`` could re-quantise to a slightly different
    spot than the one that scored well.
    """

    loop_start_seconds: float
    loop_end_seconds: float
    loop_start_samples: int
    loop_end_samples: int
    score: float
    duration_seconds: float  # loop_end - loop_start (the span that will repeat)


def find_loop_candidates(
    filepath: str,
    *,
    max_candidates: int = 5,
    min_loop_duration: Optional[float] = None,
    max_loop_duration: Optional[float] = None,
    brute_force: bool = False,
) -> List[LoopCandidate]:
    """Run PyMusicLooper on ``filepath`` and return the top loop pairs.

    PyMusicLooper returns pairs sorted by score (best first); we cap at
    ``max_candidates`` so the response stays small. Returning a list lets
    the UI offer the next-best candidate when the user previews and
    rejects the top one.
    """
    # Lazy import — pymusiclooper pulls in numba/scikit-learn/librosa
    # on import, which is a 1–2s cold start we don't want to pay on
    # every backend boot.
    from pymusiclooper.core import MusicLooper

    looper = MusicLooper(filepath=str(filepath))
    pairs = looper.find_loop_pairs(
        min_loop_duration=min_loop_duration,
        max_loop_duration=max_loop_duration,
        brute_force=brute_force,
    )
    out: List[LoopCandidate] = []
    for p in pairs[:max_candidates]:
        start_s = looper.samples_to_seconds(p.loop_start)
        end_s = looper.samples_to_seconds(p.loop_end)
        out.append(
            LoopCandidate(
                loop_start_seconds=float(start_s),
                loop_end_seconds=float(end_s),
                loop_start_samples=int(p.loop_start),
                loop_end_samples=int(p.loop_end),
                score=float(p.score),
                duration_seconds=float(end_s - start_s),
            )
        )
    logger.info(
        "Loop analysis: %s → %d candidates (best score=%.3f)",
        Path(filepath).name,
        len(out),
        out[0].score if out else 0.0,
    )
    return out


def export_seamless_loop(
    filepath: str,
    *,
    loop_start_samples: int,
    loop_end_samples: int,
    extended_length_seconds: float,
    fade_length_seconds: float = 0.05,
    output_dir: str,
    output_format: str = "WAV",
) -> str:
    """Export a new audio file that loops the chosen segment to fill
    ``extended_length_seconds`` (with a small crossfade at each seam).

    Returns the absolute path to the exported file.

    Notes
    -----
    PyMusicLooper's ``extend`` defaults to a 5-second fade which sounds
    too washy for most chill-rap loops; we default to 50ms instead —
    short enough to be inaudible on most material, long enough to mask
    a phase mismatch at the loop point. Caller can override.
    """
    from pymusiclooper.core import MusicLooper

    looper = MusicLooper(filepath=str(filepath))
    out_path = looper.extend(
        loop_start=int(loop_start_samples),
        loop_end=int(loop_end_samples),
        extended_length=float(extended_length_seconds),
        fade_length=float(fade_length_seconds),
        format=output_format,
        output_dir=str(output_dir),
    )
    logger.info(
        "Exported seamless loop: %s (extended to %.1fs, fade %.3fs)",
        out_path, extended_length_seconds, fade_length_seconds,
    )
    return out_path
