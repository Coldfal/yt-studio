from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import httpx

from app.database import async_session
from app.exceptions import CredentialError
from app.services.credentials_service import get_setting

logger = logging.getLogger(__name__)

_DEFAULT_API_URL = "https://api.sunoapi.org"
_POLL_MAX_SECONDS = 600  # 10 minutes
_POLL_INITIAL_INTERVAL = 5
_POLL_BACKOFF_INCREMENT = 5
_POLL_INTERVAL_CAP = 30


async def _get_setting(key: str) -> Optional[str]:
    """Read a setting through credentials_service. See openai_service for
    the rationale — was a local helper that hid decrypt failures."""
    async with async_session() as session:
        try:
            return await get_setting(session, key)
        except CredentialError as exc:
            logger.error("Suno setting %s could not be decrypted: %s", key, exc)
            return None


class SunoServiceError(Exception):
    """Raised when a Suno API operation fails."""


class SunoService:
    """Suno music generation via third-party API."""

    async def _get_client_config(self) -> tuple[str, str]:
        """Return ``(api_url, api_key)`` from app settings.

        Raises :class:`SunoServiceError` when the API key is not configured.
        """
        api_key = await _get_setting("suno_api_key")
        if not api_key:
            raise SunoServiceError(
                "Suno API key is not configured. "
                "Please set the 'suno_api_key' setting."
            )
        api_url = await _get_setting("suno_api_url") or _DEFAULT_API_URL
        return api_url, api_key

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def generate(
        self,
        prompt: str,
        duration_seconds: float = 120,
        instrumental: bool = True,
        style: Optional[str] = None,
        on_progress: Optional[Callable[[float], Any]] = None,
        channel_id: Optional[int] = None,
    ) -> dict:
        """Generate music via the Suno API.

        Returns
        -------
        dict
            ``{"audio_url": str, "title": str, "duration": float}``
        """
        # Rate-limit: suno bucket = 10/min, capacity 3. Suno doesn't
        # publish a hard rate but the community-observed throttle is
        # around there; staying inside avoids 429 retries that eat
        # credits.
        from app.services.rate_limiter import rate_limiter
        await rate_limiter.acquire(provider="suno", channel_id=channel_id)

        api_url, api_key = await self._get_client_config()
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload: Dict[str, Any] = {
            "prompt": prompt,
            "duration": duration_seconds,
            "instrumental": instrumental,
            "wait_audio": False,
        }
        if style is not None:
            payload["style"] = style

        # ----- Step 1: Submit generation request ---------------------------
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(
                    f"{api_url}/api/v1/generate",
                    json=payload,
                    headers=headers,
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise SunoServiceError(
                    f"Suno generate request failed (HTTP {exc.response.status_code}): "
                    f"{exc.response.text}"
                ) from exc
            except httpx.RequestError as exc:
                raise SunoServiceError(
                    f"Suno generate request failed: {exc}"
                ) from exc

            data = resp.json()
            task_id = data.get("task_id")
            if not task_id:
                raise SunoServiceError(
                    f"Suno API did not return a task_id. Response: {data}"
                )

            logger.info("Suno generation submitted – task_id=%s", task_id)

            # ----- Step 2: Poll for completion -----------------------------
            elapsed = 0.0
            interval = _POLL_INITIAL_INTERVAL

            while elapsed < _POLL_MAX_SECONDS:
                await asyncio.sleep(interval)
                elapsed += interval

                # Report progress (fraction of max wait time)
                if on_progress is not None:
                    fraction = min(elapsed / _POLL_MAX_SECONDS, 0.95)
                    try:
                        result = on_progress(fraction)
                        if asyncio.iscoroutine(result):
                            await result
                    except Exception:
                        logger.debug("on_progress callback error", exc_info=True)

                try:
                    status_resp = await client.get(
                        f"{api_url}/api/v1/status/{task_id}",
                        headers=headers,
                    )
                    status_resp.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    logger.warning(
                        "Suno status poll failed (HTTP %d), retrying…",
                        exc.response.status_code,
                    )
                    interval = min(interval + _POLL_BACKOFF_INCREMENT, _POLL_INTERVAL_CAP)
                    continue
                except httpx.RequestError as exc:
                    logger.warning("Suno status poll request error: %s, retrying…", exc)
                    interval = min(interval + _POLL_BACKOFF_INCREMENT, _POLL_INTERVAL_CAP)
                    continue

                status_data = status_resp.json()
                status = status_data.get("status", "").lower()

                logger.debug(
                    "Suno task %s status=%s (elapsed=%.0fs)", task_id, status, elapsed
                )

                if status == "complete":
                    audio_url = status_data.get("audio_url")
                    if not audio_url:
                        raise SunoServiceError(
                            "Suno task completed but no audio_url in response: "
                            f"{status_data}"
                        )

                    # Report 100 %
                    if on_progress is not None:
                        try:
                            result = on_progress(1.0)
                            if asyncio.iscoroutine(result):
                                await result
                        except Exception:
                            logger.debug("on_progress callback error", exc_info=True)

                    # Download to a temporary file
                    tmp_path = await self._download_to_temp(client, audio_url, headers)

                    return {
                        "audio_url": audio_url,
                        "title": status_data.get("title", ""),
                        "duration": float(status_data.get("duration", 0)),
                        "temp_filepath": tmp_path,
                    }

                if status in ("failed", "error"):
                    error_msg = status_data.get("error") or status_data.get("message") or "unknown"
                    raise SunoServiceError(
                        f"Suno generation failed: {error_msg}"
                    )

                # Exponential backoff
                interval = min(interval + _POLL_BACKOFF_INCREMENT, _POLL_INTERVAL_CAP)

            raise SunoServiceError(
                f"Suno generation timed out after {_POLL_MAX_SECONDS}s "
                f"(task_id={task_id})"
            )

    async def download_audio(self, url: str, filepath: str) -> None:
        """Download an audio file from *url* and save it to *filepath*."""
        dest = Path(filepath)
        dest.parent.mkdir(parents=True, exist_ok=True)

        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            try:
                async with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    with open(dest, "wb") as fh:
                        async for chunk in resp.aiter_bytes(chunk_size=65_536):
                            fh.write(chunk)
            except httpx.HTTPStatusError as exc:
                raise SunoServiceError(
                    f"Failed to download audio (HTTP {exc.response.status_code}): {url}"
                ) from exc
            except httpx.RequestError as exc:
                raise SunoServiceError(
                    f"Failed to download audio from {url}: {exc}"
                ) from exc

        logger.info("Downloaded audio to %s", filepath)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _download_to_temp(
        self,
        client: httpx.AsyncClient,
        audio_url: str,
        headers: dict,
    ) -> str:
        """Download *audio_url* into a temp file and return the path."""
        suffix = ".mp3"
        if ".wav" in audio_url:
            suffix = ".wav"
        elif ".ogg" in audio_url:
            suffix = ".ogg"

        tmp = tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, prefix="suno_"
        )
        tmp_path = tmp.name

        try:
            async with client.stream(
                "GET", audio_url, headers=headers, follow_redirects=True
            ) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_bytes(chunk_size=65_536):
                    tmp.write(chunk)
        except Exception as exc:
            tmp.close()
            Path(tmp_path).unlink(missing_ok=True)
            raise SunoServiceError(
                f"Failed to download generated audio: {exc}"
            ) from exc
        finally:
            tmp.close()

        logger.info("Downloaded Suno audio to temp file %s", tmp_path)
        return tmp_path


# Module-level singleton
suno_service = SunoService()
