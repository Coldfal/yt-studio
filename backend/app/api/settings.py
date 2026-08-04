from __future__ import annotations

from typing import Optional

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import AppSetting
from app.schemas.settings import SettingItem, SettingsUpdate
from app.utils.crypto import encrypt, decrypt

router = APIRouter(prefix="/api/settings", tags=["settings"])

SECRET_KEYS = {
    "suno_api_key",
    "elevenlabs_api_key",
    "openai_api_key",
    "youtube_client_id",
    "youtube_client_secret",
    "youtube_api_key",
}


def _mask_value(value: str) -> str:
    if len(value) <= 4:
        return "****"
    return "****" + value[-4:]


async def _get_decrypted(db: AsyncSession, key: str) -> Optional[str]:
    setting = await db.get(AppSetting, key)
    if setting and setting.value:
        try:
            return decrypt(setting.value) if setting.is_secret else setting.value
        except Exception:
            return setting.value
    return None


@router.get("/", response_model=list[SettingItem])
async def list_settings(db: AsyncSession = Depends(get_db)) -> list[SettingItem]:
    result = await db.execute(select(AppSetting))
    settings = result.scalars().all()

    items: list[SettingItem] = []
    for s in settings:
        value = s.value
        if s.is_secret and value:
            try:
                decrypted = decrypt(value)
                value = _mask_value(decrypted)
            except Exception:
                value = "****"
        items.append(SettingItem(key=s.key, value=value, is_secret=s.is_secret))
    return items


@router.put("/", response_model=list[SettingItem])
async def update_settings(
    body: SettingsUpdate,
    db: AsyncSession = Depends(get_db),
) -> list[SettingItem]:
    items: list[SettingItem] = []
    for key, value in body.settings.items():
        is_secret = key in SECRET_KEYS
        stored_value = encrypt(value) if is_secret else value

        existing = await db.get(AppSetting, key)
        if existing:
            existing.value = stored_value
            existing.is_secret = is_secret
        else:
            setting = AppSetting(key=key, value=stored_value, is_secret=is_secret)
            db.add(setting)

        display_value = _mask_value(value) if is_secret else value
        items.append(SettingItem(key=key, value=display_value, is_secret=is_secret))

    await db.commit()
    return items


@router.get("/claude-cli-status")
async def claude_cli_status() -> dict:
    """Probe the Claude Code CLI for the Settings page badge.

    Returns ``{"available": bool, "version": str | None, "path": str | None}``.
    The CLI is what we shell out to in ``claude_cli_service`` for metadata
    generation, so this lets the user verify it's reachable before kicking
    off an automation.
    """
    from app.services.claude_cli_service import claude_cli_service
    return await claude_cli_service.status()


@router.post("/test/{provider}")
async def test_connection(
    provider: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    if provider == "suno":
        api_key = await _get_decrypted(db, "suno_api_key")
        api_url = await _get_decrypted(db, "suno_api_url")
        if not api_key:
            return {"success": False, "message": "Suno API key not configured"}
        url = (api_url or "https://api.sunoapi.org").rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{url}/api/v1/status",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if resp.status_code < 500:
                    return {"success": True, "message": f"Suno API reachable (HTTP {resp.status_code})"}
                return {"success": False, "message": f"Suno API error: HTTP {resp.status_code}"}
        except httpx.ConnectError:
            return {"success": False, "message": f"Cannot connect to {url}"}
        except Exception as e:
            return {"success": False, "message": f"Connection failed: {str(e)}"}

    elif provider == "claude_cli":
        # Verify the Claude Code CLI is installed and runnable. The CLI uses
        # the user's subscription credits (not an API key) when invoked
        # without --bare.
        from app.services.claude_cli_service import claude_cli_service
        status = await claude_cli_service.status()
        if status.get("available"):
            return {
                "success": True,
                "message": f"{status.get('version')} at {status.get('path')}",
            }
        return {
            "success": False,
            "message": (
                "Claude Code CLI not found on PATH. Install it from "
                "https://code.claude.com or set YTS_CLAUDE_CLI_PATH."
            ),
        }

    elif provider == "elevenlabs":
        api_key = await _get_decrypted(db, "elevenlabs_api_key")
        if not api_key:
            return {"success": False, "message": "ElevenLabs API key not configured"}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://api.elevenlabs.io/v1/user",
                    headers={"xi-api-key": api_key},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    name = data.get("first_name", "User")
                    return {"success": True, "message": f"Connected as {name}"}
                elif resp.status_code == 401:
                    return {"success": False, "message": "Invalid ElevenLabs API key"}
                return {"success": False, "message": f"ElevenLabs API returned HTTP {resp.status_code}"}
        except Exception as e:
            return {"success": False, "message": f"Connection failed: {str(e)}"}

    elif provider == "openai":
        api_key = await _get_decrypted(db, "openai_api_key")
        if not api_key:
            return {"success": False, "message": "OpenAI API key not configured"}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if resp.status_code == 200:
                    return {"success": True, "message": "OpenAI API key is valid"}
                elif resp.status_code == 401:
                    return {"success": False, "message": "Invalid OpenAI API key"}
                return {"success": False, "message": f"OpenAI API returned HTTP {resp.status_code}"}
        except Exception as e:
            return {"success": False, "message": f"Connection failed: {str(e)}"}

    elif provider == "youtube":
        client_id = await _get_decrypted(db, "youtube_client_id")
        client_secret = await _get_decrypted(db, "youtube_client_secret")
        if not client_id:
            return {"success": False, "message": "YouTube Client ID not configured"}
        if not client_secret:
            return {"success": False, "message": "YouTube Client Secret not configured"}
        # Can't fully test OAuth without browser flow, but validate format
        if ".apps.googleusercontent.com" in client_id or len(client_id) > 20:
            return {"success": True, "message": "YouTube credentials configured (OAuth required to fully verify)"}
        return {"success": False, "message": "Client ID format looks incorrect"}

    return {"success": False, "message": f"Unknown provider: {provider}"}
