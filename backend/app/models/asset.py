from __future__ import annotations

from datetime import datetime
from typing import Optional, TYPE_CHECKING

from sqlalchemy import Integer, String, Text, DateTime, Float, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.channel import Channel


class AssetFolder(Base):
    """Per-channel folders for organising assets by type.

    Folders belong to exactly one channel. The render pipeline is
    always channel-scoped (Quick Generate, automation runs, etc.),
    so a folder shared across channels has no functional meaning —
    the renderer would never read from it. Keeping the channel_id
    invariant strict means the UI can offer a channel-first sidebar
    with no surprises.

    Same name is allowed across channels (YomiBeats's "Lofi" and
    ZenTaoSounds's "Lofi" are separate rows) and across asset_types
    within a channel (Music/Lofi and Image/Lofi are separate).
    Uniqueness is on the (channel_id, asset_type, name) triple.
    """
    __tablename__ = "asset_folders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    asset_type: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Free-text label that ties folders across asset types together.
    # When two folders share the same ``pair_group`` (e.g. an image
    # folder tagged "lofi-day" and a music folder tagged "lofi-day"),
    # Quick Generate can opt in (via AutomationPreset.use_folder_pairing)
    # to pick the image first, read its folder.pair_group, then
    # constrain the music selection to folders with the same label.
    # NULL means "ungrouped" — does not participate in pairing.
    # Named ``pair_group`` (not just ``group``) because GROUP is a SQL
    # reserved word — keeps raw DDL paths simple.
    pair_group: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "channel_id", "asset_type", "name",
            name="uq_folder_channel_type_name",
        ),
    )

    assets: Mapped[list["Asset"]] = relationship("Asset", back_populates="folder")


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    asset_type: Mapped[str] = mapped_column(String(20), nullable=False)
    # Optional sub-classification of an image asset:
    #   "background"  — video background images (the only kind Quick Generate picks)
    #   "thumbnail"   — YouTube thumbnail JPEGs (output of the thumbnail editor)
    #   "overlay"     — corner overlays (subscribe animation, watermarks)
    #   "reference"   — AI-generated content + the catch-all bucket
    # Stays nullable; ``asset_type`` remains the storage discriminator.
    # Quick Generate's image picker filters ``role='background'`` so a
    # thumbnail or overlay never gets rendered as a video background.
    role: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    filepath: Mapped[str] = mapped_column(String(1000), nullable=False)
    file_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    mime_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    generation_params: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    external_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    title: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    folder_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("asset_folders.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    channel: Mapped["Channel"] = relationship("Channel", back_populates="assets")
    folder: Mapped[Optional["AssetFolder"]] = relationship("AssetFolder", back_populates="assets")
