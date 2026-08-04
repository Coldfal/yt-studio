"""Voice profile + voice history models.

Phase 2 of the farm redesign. The operator can save a channel's current
"voice" (ai_voice + ai_example_* + brand fields) as a named profile,
then apply that profile to other channels in one click — much faster
than copy-pasting seven textareas. Every save of a channel's voice
also snapshots into ``voice_history`` so the operator can compare
versions and roll back.

Both are pure aux tables — they don't replace the canonical voice
fields on ``channels``. Profiles live cross-channel (no channel_id);
history rows are per-channel.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class VoiceProfile(Base):
    """A named, reusable voice configuration.

    Saved from a channel's current voice fields and apply-able to any
    other channel. Cross-channel by design — the operator wants to
    standardise on a "lofi-base" or "fantasy-narrative" voice and
    copy it onto 3+ channels.
    """

    __tablename__ = "voice_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # Human-readable name. Free-text — operator may use names like
    # "lofi-base", "yomi v3", "fantasy-narrative". Unique constraint at
    # the DB level prevents collisions; the UI surfaces a friendly error.
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)

    # Optional one-liner so the operator remembers what the profile is for.
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Voice fields — mirror Channel.ai_voice + ai_example_* + the
    # brand triplet so an apply restores everything in one click. ────
    niche: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    brand_identity: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    target_audience: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    title_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    description_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_voice: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    thumbnail_style_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Optional channel of origin — useful trivia ("forked from YomiBeats").
    # Stays an integer (no FK constraint) so deleting the source channel
    # doesn't cascade into deleting profiles the operator still wants.
    source_channel_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class VoiceHistory(Base):
    """Per-channel snapshot of voice fields, captured on every save.

    Lets the operator review "what did the voice look like last week"
    and one-click restore. Append-only — never deleted. A future
    cleanup job can prune rows older than N versions if it grows.
    """

    __tablename__ = "voice_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("channels.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Operator-supplied label for this snapshot (optional). Lets the
    # operator annotate a save with "switched to all-lowercase" so the
    # history list reads as a changelog.
    label: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    # Voice fields — same columns as VoiceProfile, no brand triplet
    # because that lives on the channel proper and doesn't change as
    # often. If we need to track those too we can add later; for the
    # operator's "what did my ai_voice look like last week" question,
    # the four ai_* fields are what matters.
    ai_voice: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True,
    )
