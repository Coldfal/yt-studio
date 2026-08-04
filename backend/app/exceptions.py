"""Centralised application exceptions.

The FastAPI exception handler in ``app.main`` maps these to consistent
JSON responses with the right HTTP status codes, so route handlers
can ``raise NotFoundError(...)`` instead of crafting an HTTPException
or returning ad-hoc 500 responses with stack traces.

Service-layer code (anything under ``app.services``) should raise
these instead of generic ``ValueError`` / ``RuntimeError`` whenever
the failure has a known shape — that way the task runner and HTTP
handlers can react predictably (e.g. don't retry a credential error,
do retry a transient ``ServiceError``).
"""
from __future__ import annotations

from typing import Any, Optional


class AppError(Exception):
    """Base class for all app-defined errors. Carries an HTTP status
    code and an optional ``details`` blob for the JSON response body.
    """

    status_code: int = 500
    code: str = "app_error"

    def __init__(
        self,
        message: str,
        *,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(AppError):
    """A specific row / file / external resource was not found."""

    status_code = 404
    code = "not_found"


class ValidationError(AppError):
    """User-supplied input failed validation. 400-level."""

    status_code = 400
    code = "validation_error"


class ServiceError(AppError):
    """An external integration (FFmpeg, Suno, OpenAI, YouTube, Claude)
    failed for a transient or service-side reason. The task runner
    treats these as candidates for retry with backoff.
    """

    status_code = 502
    code = "service_error"


class CredentialError(AppError):
    """Stored credentials are missing, malformed, or rejected by the
    upstream provider. Never retried — the operator must fix the
    credentials before any further attempts will succeed.
    """

    status_code = 401
    code = "credential_error"


class TimeoutExceededError(AppError):
    """A task exceeded its wall-clock timeout. Mapped to 504 in HTTP
    contexts; in the task runner it just marks the task ``failed``.
    """

    status_code = 504
    code = "timeout"


# Convenience tuple — exception types that the task runner should
# treat as retryable. Anything not in this tuple fails immediately.
RETRYABLE_EXCEPTIONS: tuple[type[Exception], ...] = (
    ServiceError,
    TimeoutExceededError,
    ConnectionError,
    TimeoutError,
)
