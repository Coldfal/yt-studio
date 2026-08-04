"""Voice profile + voice history API.

Phase 2 of the farm redesign. Three concerns:

1. ``GET /api/voice-profiles`` — list reusable profiles.
2. ``POST /api/voice-profiles`` — save a channel's current voice as a profile.
3. ``POST /api/channels/{id}/apply-voice-profile/{profile_id}`` — copy a
   profile's fields onto a channel.
4. ``GET /api/channels/{id}/voice-history`` — list snapshots.
5. ``POST /api/channels/{id}/voice-history/{snapshot_id}/restore`` — restore.

Profiles are cross-channel (no ``channel_id`` FK on the table). History
is per-channel and immutable (append-only).
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Channel
from app.models.voice_profile import VoiceProfile, VoiceHistory


router = APIRouter(prefix="/api/voice-profiles", tags=["voice-profiles"])


# ── Schemas ──────────────────────────────────────────────────────────


class VoiceProfileResponse(BaseModel):
    id: int
    name: str
    notes: Optional[str]
    niche: Optional[str]
    brand_identity: Optional[str]
    target_audience: Optional[str]
    default_tags: Optional[str]
    title_template: Optional[str]
    description_template: Optional[str]
    ai_voice: Optional[str]
    ai_example_title: Optional[str]
    ai_example_description: Optional[str]
    ai_example_tags: Optional[str]
    thumbnail_style_notes: Optional[str]
    source_channel_id: Optional[int]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class VoiceProfileCreate(BaseModel):
    """Save a channel's current voice as a profile.

    The endpoint reads the channel's current voice fields itself so the
    client only sends the name + optional source channel — keeps the
    operation atomic and cheap to invoke from the UI menu.
    """

    name: str = Field(min_length=1, max_length=120)
    notes: Optional[str] = None
    source_channel_id: int


class VoiceProfileUpdate(BaseModel):
    """In-place edit of a saved profile (renames, note tweaks, voice diffs)."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    notes: Optional[str] = None
    niche: Optional[str] = None
    brand_identity: Optional[str] = None
    target_audience: Optional[str] = None
    default_tags: Optional[str] = None
    title_template: Optional[str] = None
    description_template: Optional[str] = None
    ai_voice: Optional[str] = None
    ai_example_title: Optional[str] = None
    ai_example_description: Optional[str] = None
    ai_example_tags: Optional[str] = None
    thumbnail_style_notes: Optional[str] = None


class VoiceHistoryResponse(BaseModel):
    id: int
    channel_id: int
    label: Optional[str]
    ai_voice: Optional[str]
    ai_example_title: Optional[str]
    ai_example_description: Optional[str]
    ai_example_tags: Optional[str]
    notes: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


# ── Profiles CRUD ────────────────────────────────────────────────────


@router.get("/", response_model=List[VoiceProfileResponse])
async def list_profiles(db: AsyncSession = Depends(get_db)):
    """All saved voice profiles, newest first."""
    stmt = select(VoiceProfile).order_by(VoiceProfile.updated_at.desc())
    return list((await db.execute(stmt)).scalars().all())


@router.post("/", response_model=VoiceProfileResponse, status_code=201)
async def create_profile(
    body: VoiceProfileCreate,
    db: AsyncSession = Depends(get_db),
) -> VoiceProfileResponse:
    """Save the source channel's current voice as a named profile.

    Reads the channel row server-side so the snapshot is atomic — a
    client that fetched stale voice fields can't accidentally save an
    out-of-date profile. Returns 409 on duplicate name (the table has
    a unique constraint on ``name``).
    """
    channel = await db.get(Channel, body.source_channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Source channel not found")

    profile = VoiceProfile(
        name=body.name.strip(),
        notes=body.notes,
        source_channel_id=channel.id,
        niche=channel.niche,
        brand_identity=channel.brand_identity,
        target_audience=channel.target_audience,
        default_tags=channel.default_tags,
        title_template=channel.title_template,
        description_template=channel.description_template,
        ai_voice=channel.ai_voice,
        ai_example_title=channel.ai_example_title,
        ai_example_description=channel.ai_example_description,
        ai_example_tags=channel.ai_example_tags,
        thumbnail_style_notes=channel.thumbnail_style_notes,
    )
    db.add(profile)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A voice profile named '{body.name}' already exists.",
        )
    await db.refresh(profile)
    return profile  # type: ignore[return-value]


@router.put("/{profile_id}", response_model=VoiceProfileResponse)
async def update_profile(
    profile_id: int,
    body: VoiceProfileUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Edit a saved profile in place."""
    profile = await db.get(VoiceProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(profile, k, v)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="That name is already taken by another profile.",
        )
    await db.refresh(profile)
    return profile  # type: ignore[return-value]


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(
    profile_id: int,
    db: AsyncSession = Depends(get_db),
):
    profile = await db.get(VoiceProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    await db.delete(profile)
    await db.commit()


# ── Apply profile to channel ─────────────────────────────────────────


_CHANNEL_FIELDS_FROM_PROFILE = [
    "niche",
    "brand_identity",
    "target_audience",
    "default_tags",
    "title_template",
    "description_template",
    "ai_voice",
    "ai_example_title",
    "ai_example_description",
    "ai_example_tags",
    "thumbnail_style_notes",
]


# Mounted on the channels router by registering a sibling route — using
# the voice-profiles router lets us colocate the code with the model.
# The path lives under /api/channels/{channel_id}/apply-voice-profile/...
# so the frontend hook can stay on a single URL pattern.
apply_router = APIRouter(prefix="/api/channels", tags=["voice-profiles"])


@apply_router.post("/{channel_id}/apply-voice-profile/{profile_id}")
async def apply_voice_profile(
    channel_id: int,
    profile_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Copy a profile's fields onto a channel. Snapshots the previous
    channel voice into ``voice_history`` first so it's restorable.
    """
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    profile = await db.get(VoiceProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Snapshot before mutation so the operator can revert in one click.
    db.add(VoiceHistory(
        channel_id=channel.id,
        label=f"before applying profile '{profile.name}'",
        ai_voice=channel.ai_voice,
        ai_example_title=channel.ai_example_title,
        ai_example_description=channel.ai_example_description,
        ai_example_tags=channel.ai_example_tags,
        notes=channel.notes,
    ))

    for field in _CHANNEL_FIELDS_FROM_PROFILE:
        value = getattr(profile, field, None)
        # Only overwrite when the profile has a non-empty value. A
        # profile with NULL ``description_template`` shouldn't blank
        # out the channel's existing template by accident.
        if value is not None and value != "":
            setattr(channel, field, value)
    await db.commit()
    return {"channel_id": channel.id, "profile_id": profile.id, "applied": True}


# ── History list + restore ───────────────────────────────────────────


history_router = APIRouter(prefix="/api/channels", tags=["voice-history"])


@history_router.get(
    "/{channel_id}/voice-history",
    response_model=List[VoiceHistoryResponse],
)
async def list_voice_history(
    channel_id: int,
    limit: int = 30,
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(VoiceHistory)
        .where(VoiceHistory.channel_id == channel_id)
        .order_by(VoiceHistory.created_at.desc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


@history_router.post("/{channel_id}/voice-history/{snapshot_id}/restore")
async def restore_voice_snapshot(
    channel_id: int,
    snapshot_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Restore a snapshot onto the channel. Also snapshots the current
    state first so 'restore the restore' is a single click away.
    """
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    snap = await db.get(VoiceHistory, snapshot_id)
    if not snap or snap.channel_id != channel_id:
        raise HTTPException(status_code=404, detail="Snapshot not found")

    db.add(VoiceHistory(
        channel_id=channel.id,
        label=f"before restore of #{snap.id}",
        ai_voice=channel.ai_voice,
        ai_example_title=channel.ai_example_title,
        ai_example_description=channel.ai_example_description,
        ai_example_tags=channel.ai_example_tags,
        notes=channel.notes,
    ))

    channel.ai_voice = snap.ai_voice
    channel.ai_example_title = snap.ai_example_title
    channel.ai_example_description = snap.ai_example_description
    channel.ai_example_tags = snap.ai_example_tags
    channel.notes = snap.notes
    await db.commit()
    return {"channel_id": channel.id, "restored_snapshot_id": snap.id}
