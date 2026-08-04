from __future__ import annotations

import base64
import logging

from cryptography.fernet import Fernet

from app.config import settings

logger = logging.getLogger(__name__)

_fernet: Fernet | None = None


class CryptoKeyError(RuntimeError):
    """Raised when the encryption key file cannot be read, written, or is
    invalid. Callers should treat this as a configuration error, not a
    transient failure — restoring or regenerating ``data/studio.key`` is
    the only fix.
    """


def _get_fernet() -> Fernet:
    """Return a cached Fernet instance, creating the key file if needed.

    Raises ``CryptoKeyError`` if the key file is unreadable, unwritable,
    or contains invalid bytes. Callers that can recover (API endpoints
    decrypting stored creds) should catch and surface a clear error
    rather than 500-ing with a stack trace.
    """
    global _fernet
    if _fernet is not None:
        return _fernet

    key_path = settings.key_path

    try:
        if not key_path.exists():
            logger.info("Encryption key not found – generating new key at %s", key_path)
            try:
                key_path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise CryptoKeyError(
                    f"Could not create key directory {key_path.parent}: {exc}"
                ) from exc
            key = Fernet.generate_key()
            try:
                key_path.write_bytes(key)
            except OSError as exc:
                raise CryptoKeyError(
                    f"Could not write key file {key_path}: {exc}. "
                    "Check filesystem permissions / disk space."
                ) from exc
        else:
            try:
                key = key_path.read_bytes().strip()
            except OSError as exc:
                raise CryptoKeyError(
                    f"Could not read key file {key_path}: {exc}"
                ) from exc
            if not key:
                raise CryptoKeyError(
                    f"Key file {key_path} is empty. Restore from backup or "
                    "delete the file to let the app generate a new key "
                    "(stored encrypted credentials will become unreadable)."
                )

        try:
            _fernet = Fernet(key)
        except (ValueError, TypeError) as exc:
            raise CryptoKeyError(
                f"Key file {key_path} contains invalid bytes (not a "
                f"valid Fernet key): {exc}"
            ) from exc

        return _fernet
    except CryptoKeyError:
        raise
    except Exception as exc:  # last-ditch defensive catch
        raise CryptoKeyError(f"Unexpected crypto initialisation error: {exc}") from exc


def ensure_key_available() -> None:
    """Startup hook — touches the key so missing/invalid keys surface
    immediately at boot instead of mid-request. Logs a clear error and
    re-raises so the caller can decide whether to abort the boot.
    """
    try:
        _get_fernet()
    except CryptoKeyError as exc:
        logger.error("Encryption key check failed: %s", exc)
        raise


def encrypt(plaintext: str) -> str:
    """Encrypt *plaintext* and return a URL-safe base64-encoded ciphertext string."""
    f = _get_fernet()
    token = f.encrypt(plaintext.encode("utf-8"))
    return base64.urlsafe_b64encode(token).decode("ascii")


def decrypt(ciphertext: str) -> str:
    """Decrypt a base64-encoded *ciphertext* produced by :func:`encrypt`."""
    f = _get_fernet()
    token = base64.urlsafe_b64decode(ciphertext.encode("ascii"))
    return f.decrypt(token).decode("utf-8")
