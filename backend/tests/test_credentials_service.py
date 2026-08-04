"""Tests for the credentials service.

Covers the encrypt → decrypt round-trip and the failure modes that
matter (missing channel, no creds set, corrupt ciphertext).
"""
from __future__ import annotations

import json

import pytest

from app.exceptions import CredentialError
from app.models import AppSetting, Channel
from app.services.credentials_service import (
    get_channel_youtube_credentials,
    get_channel_youtube_credentials_dict,
    get_setting,
)
from app.utils.crypto import encrypt


pytestmark = pytest.mark.asyncio


async def test_get_setting_returns_none_when_missing(db):
    assert await get_setting(db, "does_not_exist") is None


async def test_get_setting_returns_plaintext_when_not_secret(db):
    db.add(AppSetting(key="public", value="hello", is_secret=False))
    await db.commit()
    assert await get_setting(db, "public") == "hello"


async def test_get_setting_decrypts_when_secret(db):
    db.add(AppSetting(key="api_key", value=encrypt("sk-secret"), is_secret=True))
    await db.commit()
    assert await get_setting(db, "api_key") == "sk-secret"


async def test_get_setting_raises_credential_error_on_corrupt_ciphertext(db):
    db.add(AppSetting(key="bad_key", value="not-real-ciphertext", is_secret=True))
    await db.commit()
    with pytest.raises(CredentialError):
        await get_setting(db, "bad_key")


async def test_get_channel_youtube_credentials_none_when_channel_missing(db):
    assert await get_channel_youtube_credentials(db, channel_id=99999) is None


async def test_get_channel_youtube_credentials_none_when_not_connected(db, channel: Channel):
    # Channel exists but has no creds yet
    assert await get_channel_youtube_credentials(db, channel.id) is None


async def test_get_channel_youtube_credentials_round_trip(db, channel: Channel):
    raw = json.dumps({"token": "t1", "refresh_token": "r1"})
    channel.youtube_credentials_json = encrypt(raw)
    await db.commit()

    decrypted = await get_channel_youtube_credentials(db, channel.id)
    assert decrypted == raw

    parsed = await get_channel_youtube_credentials_dict(db, channel.id)
    assert parsed == {"token": "t1", "refresh_token": "r1"}


async def test_get_channel_youtube_credentials_dict_raises_on_invalid_json(db, channel: Channel):
    # Successfully decrypts to non-JSON content — must surface as a
    # CredentialError so the operator gets a clear "reconnect" hint.
    channel.youtube_credentials_json = encrypt("this is not json")
    await db.commit()
    with pytest.raises(CredentialError):
        await get_channel_youtube_credentials_dict(db, channel.id)


async def test_get_channel_youtube_credentials_raises_on_corrupt_ciphertext(db, channel: Channel):
    channel.youtube_credentials_json = "garbage-not-fernet"
    await db.commit()
    with pytest.raises(CredentialError):
        await get_channel_youtube_credentials(db, channel.id)
