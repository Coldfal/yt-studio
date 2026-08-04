"""Persisted YouTube analytics snapshots and refresh-run audit log.

Two tables that together let the app reason about channel performance
over time without hitting the YouTube API on every page load:

- ``VideoAnalyticsSnapshot``: one row per (video, day) capturing the
  public + analytics metrics for that video as of that date. The
  scheduled refresh worker UPSERTs against the unique
  (youtube_video_id, snapshot_date) constraint so re-runs on the
  same day are idempotent.

- ``AnalyticsRunLog``: one row per refresh attempt per channel.
  Lets the dashboard render "Last updated 4h ago" and lets the
  scheduler tell whether a channel is due for refresh.

Snapshot history fuels:
- The /analytics page's recent-videos list and trend curves.
- The title-token bandit (Phase 3) — its UCB1-ish recompute walks
  these rows to build per-token aggregates.
"""
from __future__ import annotations

from datetime import datetime, date
from typing import Optional, TYPE_CHECKING

from sqlalchemy import (
    Date, DateTime, Float, ForeignKey, Integer, JSON, String, Text,
    UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.channel import Channel


class VideoAnalyticsSnapshot(Base):
    """A single (video, day) sample of public + analytics metrics.

    Why per-day instead of per-fetch: hourly resolution would multiply
    storage 24× for no operator benefit (CTR doesn't move that fast on
    a chill-rap channel). Per-day also makes "compare last 7d vs
    previous 7d" a clean SQL query without bucket arithmetic.

    The unique constraint on (youtube_video_id, snapshot_date) means
    the worker can safely UPSERT — re-running today's refresh later
    in the day overwrites today's row instead of duplicating it.
    """
    __tablename__ = "video_analytics_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    youtube_video_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # Public Data API stats — always populated.
    view_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    like_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    comment_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Computed at insert: views / max(1, days_since_publish). Stored so
    # cross-video trend queries don't have to recompute every time.
    views_per_day: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    # YouTube Analytics API metrics — null until the channel has the
    # ``yt-analytics.readonly`` scope AND the project has the API
    # enabled. CTR + avg_view_percentage are 0..1 fractions (NOT
    # percentages); avg_view_duration is seconds.
    impressions: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    ctr: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    avg_view_duration: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    avg_view_percentage: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Title cached at snapshot time so historical trend graphs survive
    # the user editing the title later (rare but happens).
    title_at_snapshot: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Phase 3: description + tags cached at snapshot time so the
    # description / tag bandits can tokenise them later without needing
    # to re-fetch from the public Data API. Stored as raw text/JSON so
    # the bandit recompute is a pure DB walk.
    description_at_snapshot: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tags_at_snapshot: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "youtube_video_id", "snapshot_date",
            name="uq_video_snapshot_per_day",
        ),
    )

    channel: Mapped["Channel"] = relationship("Channel")


class AnalyticsRunLog(Base):
    """Per-channel refresh-attempt audit row.

    Used by:
    - The scheduler's ``_maybe_refresh_analytics`` tick to decide
      whether a channel is due (compares ``completed_at`` vs now).
    - The dashboard's freshness pill (Phase 4) — green when the most
      recent ``completed_at`` is < 26h, yellow if > 26h, red if any
      channel has only failures.
    """
    __tablename__ = "analytics_run_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    started_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # "running" → "completed" on success; "failed" with error text on
    # any exception. The scheduler reads this state to skip channels
    # already in flight.
    status: Mapped[str] = mapped_column(String(20), default="running", nullable=False)
    videos_processed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # When the YT Analytics API isn't enabled or the user hasn't
    # granted yt-analytics scope, we still capture public stats — the
    # row completes successfully but this flag flips so the UI can
    # nudge the operator to enable it.
    analytics_skipped: Mapped[bool] = mapped_column(
        Integer, default=0, nullable=False  # SQLite doesn't have native Bool
    )

    channel: Mapped["Channel"] = relationship("Channel")


class VideoManualMetric(Base):
    """Operator-entered metrics for a YouTube video.

    YouTube doesn't expose CTR via the public Analytics API for
    regular channels (only YouTube Studio does), so the only way to
    feed real CTR back into the title bandit is to let the operator
    type it in. This table is the on-disk store for those manual
    entries — one row per video, UPSERT keyed on
    ``youtube_video_id``.

    Designed so the operator only needs to enter values for the few
    videos they actually care about; the bandit gracefully degrades
    to retention-only when manual CTR is sparse.
    """
    __tablename__ = "video_manual_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    youtube_video_id: Mapped[str] = mapped_column(
        String(50), nullable=False, unique=True,
    )
    # 0..1 fraction (e.g. 0.083 for 8.3%). Null clears the override.
    ctr: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    entered_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(),
    )


class TrackPerformanceStat(Base):
    """Per-track retention + view aggregate (Phase: track bandit).

    Walks every video that has a VideoProject with a non-empty
    ``music_asset_ids`` and a recent snapshot; attributes the
    snapshot's retention + views/day to the FIRST track only (the
    one most viewers actually hear since they don't watch the whole
    multi-track set). Sums and sample counts let downstream code
    compute a per-track mean cheaply.

    Used by:
    - The Analytics page's "Top performing tracks" card.
    - A future track-bandit that biases music selection in
      ``select_tracks`` toward proven performers (out of scope today).
    """
    __tablename__ = "track_performance_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # FK to assets.id — the music track. ON DELETE SET NULL so a
    # deleted track leaves orphan stats we can clean up later.
    track_asset_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True,
    )
    # Cached for display so the UI doesn't have to JOIN to assets
    # every time. Recomputed on every aggregate walk.
    track_title: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    track_filename: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    videos_used_in: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_views: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_views_per_day: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total_retention_sum: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total_retention_samples: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    last_recomputed_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "channel_id", "track_asset_id",
            name="uq_track_perf_per_channel_asset",
        ),
    )


class TitleTokenStat(Base):
    """Per-channel, per-token (Phase 3) title-bandit aggregate.

    The bandit recompute walks ``video_analytics_snapshots``
    (latest snapshot per video), tokenises the cached title, and
    aggregates per token:
      - ``samples``: how many distinct videos used this token
      - ``total_views_per_day``: sum across those videos' latest VPDs
      - ``total_ctr_weighted_sum``: Σ (ctr × impressions) — used to
        compute an impression-weighted mean CTR without re-walking
        snapshots
      - ``total_impressions``: Σ impressions
      - ``score``: a UCB1-style combined score (CTR mean + views/day
        z-score + exploration bonus); recomputed on every walk
      - ``classification``: ``winner`` / ``cold`` / ``exploring``

    The unique constraint on (channel_id, kind, token) means ``kind``
    can be ``"title"``, ``"hashtag"``, or ``"tag"`` — same table, three
    parallel bandits per channel. Future-proofed with one extra column
    so we don't need to refactor when the hashtag/tag bandits ship.
    """
    __tablename__ = "title_token_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # ``title``, ``hashtag``, or ``tag``. Phase 3 ships ``title``;
    # ``hashtag`` and ``tag`` get wired in shortly after.
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="title")
    token: Mapped[str] = mapped_column(String(80), nullable=False, index=True)

    samples: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_views_per_day: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total_ctr_weighted_sum: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total_impressions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    # ``winner`` / ``cold`` / ``exploring``
    classification: Mapped[str] = mapped_column(
        String(16), default="exploring", nullable=False,
    )
    last_recomputed_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "channel_id", "kind", "token",
            name="uq_token_stat_per_channel_kind",
        ),
    )

    channel: Mapped["Channel"] = relationship("Channel")


class MetadataFeedback(Base):
    """Operator thumbs up/down on a previewed metadata package.

    Phase 3 of farm redesign. Until a channel has 8+ real video samples
    with snapshots, the bandit has little real CTR data to learn from.
    Operator gut signal fills the gap: thumbs-up on a Quick Generate
    preview marks its tokens as positive signal, thumbs-down marks
    them as negative. The bandit recompute walks these rows alongside
    the snapshot aggregates so feedback contributes to the score with
    a small but non-zero weight.

    Append-only by design — the operator's history of taste signals is
    intentionally kept so we can detect "their taste is changing".
    """
    __tablename__ = "metadata_feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # Optional FK — preview packages aren't always tied to a real
    # VideoProject. We DON'T set ondelete="CASCADE" here so the
    # feedback survives if the operator later deletes the project.
    project_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # The actual metadata the operator rated. Stored verbatim so the
    # bandit can tokenise the title/description/tags exactly as Claude
    # produced them.
    generated_title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    generated_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    generated_tags: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # -1 = thumbs down, +1 = thumbs up. 0 reserved for "noted but
    # neutral" (not used yet).
    operator_rating: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Free-form note so the operator can capture "title was too long"
    # / "description felt off-brand" — useful when reviewing the
    # feedback history later.
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True,
    )
