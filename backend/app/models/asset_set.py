"""Asset Set model — Phase 5 of farm redesign.

An ``AssetSet`` is a named ``(background, thumbnail, [overlay])``
tuple the operator pairs once and reuses forever. When a channel
opts into Sets mode (``automation_presets.use_asset_sets=True``),
Quick Generate picks a random ACTIVE set from the channel's library
instead of independently picking a background image + sticky
thumbnail. Replaces the half-baked sticky-thumbnail flow with a
cleaner abstraction now that Phase 0 gave every image a ``role``.

Set members reference Asset rows via FK. Deleting an asset that's
in a Set cascades to deleting the Set (otherwise we'd silently
break Quick Generate on the next pick).
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional, TYPE_CHECKING

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, String, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.channel import Channel
    from app.models.asset import Asset


class AssetSet(Base):
    __tablename__ = "asset_sets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)

    # Required pair. Both FKs CASCADE-delete the Set when either
    # underlying asset is deleted — keeping the set around with a
    # dangling pointer would silently break Quick Generate.
    background_asset_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("assets.id", ondelete="CASCADE"),
        nullable=False,
    )
    thumbnail_asset_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("assets.id", ondelete="CASCADE"),
        nullable=False,
    )

    # Optional third member. Visualizer overlay PNG (subscribe corner,
    # watermark, etc.). SET NULL so deleting the overlay file just
    # clears the slot — the Set still works as a (bg, thumb) pair.
    overlay_asset_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("assets.id", ondelete="SET NULL"),
        nullable=True,
    )

    # When False, Quick Generate skips this set in random picks.
    # Lets the operator keep retired sets around without deleting.
    is_active: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(),
    )

    # No back-populates on Asset — would multiply FK relationship
    # definitions across three columns. Sets are queried by
    # channel_id directly.
    channel: Mapped["Channel"] = relationship("Channel")
    background: Mapped["Asset"] = relationship(
        "Asset", foreign_keys=[background_asset_id],
    )
    thumbnail: Mapped["Asset"] = relationship(
        "Asset", foreign_keys=[thumbnail_asset_id],
    )
    overlay: Mapped[Optional["Asset"]] = relationship(
        "Asset", foreign_keys=[overlay_asset_id],
    )
