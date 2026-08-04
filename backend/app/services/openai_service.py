from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any, Callable, List, Optional
from uuid import uuid4

import httpx

from app.config import settings
from app.database import async_session
from app.exceptions import CredentialError
from app.services.credentials_service import get_setting
from app.utils.file_utils import get_asset_dir

logger = logging.getLogger(__name__)


async def _get_setting(key: str) -> Optional[str]:
    """Read a setting through credentials_service.

    Was a local helper that swallowed Fernet decrypt errors and returned
    None — that hid corrupt-key bugs. credentials_service raises a clean
    CredentialError on decrypt failure; we keep the None return for
    "row missing or empty" to preserve the existing call-site contract.
    """
    async with async_session() as session:
        try:
            return await get_setting(session, key)
        except CredentialError as exc:
            logger.error("OpenAI setting %s could not be decrypted: %s", key, exc)
            return None


class OpenAIServiceError(Exception):
    """Raised when an OpenAI API operation fails."""


class OpenAIService:
    """Image generation via OpenAI DALL-E 3."""

    async def _get_api_key(self) -> str:
        api_key = await _get_setting("openai_api_key")
        if not api_key:
            raise OpenAIServiceError(
                "OpenAI API key is not configured. "
                "Please set the 'openai_api_key' setting."
            )
        return api_key

    async def generate_images(
        self,
        prompt: str,
        channel_id: int,
        count: int = 1,
        size: str = "1792x1024",
        on_progress: Optional[Callable[[float, str], Any]] = None,
    ) -> List[dict]:
        """Generate images via DALL-E 3 and save to the asset directory.

        Returns a list of dicts:
        ``[{"asset_path": str, "filename": str, "file_size": int, "revised_prompt": str}]``

        DALL-E 3 only supports ``n=1`` per request, so we loop *count* times.
        """
        api_key = await self._get_api_key()
        count = max(1, min(count, 4))

        results: List[dict] = []

        # Rate-limit: openai_dalle bucket = 5/min, capacity 2.
        # Each image is one acquire — a `count=4` request spends
        # 4 tokens but doesn't all arrive in one second.
        from app.services.rate_limiter import rate_limiter

        async with httpx.AsyncClient(timeout=90, follow_redirects=True) as client:
            for i in range(count):
                if on_progress:
                    msg = f"Generating image {i + 1}/{count}..."
                    _safe_callback(on_progress, i / count, msg)
                await rate_limiter.acquire(
                    provider="openai_dalle", channel_id=channel_id,
                )

                # --- Request generation ---
                try:
                    resp = await client.post(
                        "https://api.openai.com/v1/images/generations",
                        json={
                            "prompt": prompt,
                            "n": 1,
                            "size": size,
                            "model": "dall-e-3",
                            "quality": "standard",
                        },
                        headers={"Authorization": f"Bearer {api_key}"},
                    )
                    resp.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    body = exc.response.text[:500]
                    raise OpenAIServiceError(
                        f"DALL-E request failed (HTTP {exc.response.status_code}): {body}"
                    ) from exc
                except httpx.RequestError as exc:
                    raise OpenAIServiceError(
                        f"DALL-E request failed: {exc}"
                    ) from exc

                data = resp.json()
                image_data = data.get("data", [{}])[0]
                image_url = image_data.get("url")
                revised_prompt = image_data.get("revised_prompt", prompt)

                if not image_url:
                    raise OpenAIServiceError(
                        f"DALL-E returned no image URL. Response: {data}"
                    )

                # --- Download image ---
                if on_progress:
                    _safe_callback(on_progress, (i + 0.5) / count, f"Downloading image {i + 1}/{count}...")

                prefix = uuid4().hex[:8]
                filename = f"dalle_{prefix}.png"
                asset_dir = get_asset_dir(channel_id, "image")
                dest = asset_dir / filename

                try:
                    async with client.stream("GET", image_url) as img_resp:
                        img_resp.raise_for_status()
                        with open(dest, "wb") as fh:
                            async for chunk in img_resp.aiter_bytes(chunk_size=65_536):
                                fh.write(chunk)
                except Exception as exc:
                    dest.unlink(missing_ok=True)
                    raise OpenAIServiceError(
                        f"Failed to download generated image: {exc}"
                    ) from exc

                file_size = dest.stat().st_size
                relative_path = dest.relative_to(settings.assets_dir).as_posix()

                results.append({
                    "asset_path": relative_path,
                    "filename": filename,
                    "file_size": file_size,
                    "revised_prompt": revised_prompt,
                })

                logger.info(
                    "Generated DALL-E image %d/%d -> %s (%d bytes)",
                    i + 1, count, relative_path, file_size,
                )

        if on_progress:
            _safe_callback(on_progress, 1.0, "Image generation complete")

        return results


def _safe_callback(
    cb: Callable[[float, str], Any],
    fraction: float,
    message: str,
) -> None:
    """Call *cb*, swallowing errors and awaiting coroutines."""
    try:
        result = cb(fraction, message)
        if asyncio.iscoroutine(result):
            # Best-effort await – if there's no running loop just drop it
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(result)
            except RuntimeError:
                pass
    except Exception:
        logger.debug("on_progress callback error", exc_info=True)


# Module-level singleton
openai_service = OpenAIService()
