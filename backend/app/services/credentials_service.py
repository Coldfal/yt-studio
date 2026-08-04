"""Single source of truth for reading encrypted credentials.

Every place that needs a YouTube OAuth blob, a Claude API key, a Suno
cookie, or any other secret stored in ``app_settings`` / ``channels``
should go through this service rather than calling
``decrypt(...)`` inline. That way:

- Decrypt failures (bad ciphertext, missing Fernet key) produce a
  consistent ``CredentialError`` instead of an arbitrary ``Fernet``
  exception that callers may or may not catch.
- A future swap of the encryption library only touches one file.
- Logs / metrics for credential access live in one place.

Returns ``None`` for not-found / unreadable rather than raising on
common cases (so callers can branch cleanly), but does raise
``CredentialError`` for **decrypt failure on a present row** — that's
a real misconfiguration the operator needs to know about.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import CredentialError
from app.models import AppSetting, Channel
from app.utils.crypto import CryptoKeyError, decrypt

logger = logging.getLogger(__name__)


async def get_setting(db: AsyncSession, key: str) -> Optional[str]:
    """Read a single ``AppSetting`` value, decrypting if marked secret.

    Returns ``None`` if the row is missing or empty. Raises
    :class:`~app.exceptions.CredentialError` if the row exists,
    is marked secret, but cannot be decrypted (bad key / corrupt
    ciphertext).
    """
    row = await db.get(AppSetting, key)
    if not row or not row.value:
        return None
    if not row.is_secret:
        return row.value
    try:
        return decrypt(row.value)
    except CryptoKeyError as exc:
        logger.error("Crypto key unavailable while reading setting %s: %s", key, exc)
        raise CredentialError(
            f"Encryption key unavailable; cannot decrypt setting '{key}'.",
            details={"key": key},
        ) from exc
    except Exception as exc:
        logger.error("Could not decrypt AppSetting[%s]: %s", key, exc)
        raise CredentialError(
            f"Stored value for '{key}' is corrupted or was encrypted with a different key.",
            details={"key": key},
        ) from exc


async def get_channel_youtube_credentials(
    db: AsyncSession, channel_id: int
) -> Optional[str]:
    """Decrypt and return the YouTube OAuth credentials JSON for a
    channel. Returns ``None`` if the channel isn't connected to
    YouTube; raises :class:`CredentialError` on decrypt failure.
    """
    channel = await db.get(Channel, channel_id)
    if not channel:
        return None
    if not channel.youtube_credentials_json:
        return None
    try:
        return decrypt(channel.youtube_credentials_json)
    except CryptoKeyError as exc:
        logger.error("Crypto key unavailable for channel %s: %s", channel_id, exc)
        raise CredentialError(
            "Encryption key unavailable; cannot decrypt YouTube credentials.",
            details={"channel_id": channel_id},
        ) from exc
    except Exception as exc:
        logger.error("Could not decrypt YouTube creds for channel %s: %s", channel_id, exc)
        raise CredentialError(
            "Stored YouTube credentials are corrupted. Disconnect and reconnect "
            "YouTube on the channel's Settings page.",
            details={"channel_id": channel_id},
        ) from exc


async def get_channel_youtube_credentials_dict(
    db: AsyncSession, channel_id: int
) -> Optional[dict[str, Any]]:
    """Same as :func:`get_channel_youtube_credentials` but returns the
    parsed JSON dict (or ``None``). Useful when you need to feed it
    into ``google.oauth2.credentials.Credentials`` directly.
    """
    raw = await get_channel_youtube_credentials(db, channel_id)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CredentialError(
            "Stored YouTube credentials are not valid JSON. Reconnect the channel.",
            details={"channel_id": channel_id},
        ) from exc
