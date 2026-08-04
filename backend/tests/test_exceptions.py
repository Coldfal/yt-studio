"""Smoke tests for the AppError hierarchy."""
from __future__ import annotations

import pytest

from app.exceptions import (
    AppError,
    CredentialError,
    NotFoundError,
    RETRYABLE_EXCEPTIONS,
    ServiceError,
    TimeoutExceededError,
    ValidationError,
)


def test_apperror_carries_message_and_details():
    exc = AppError("boom", details={"foo": 1})
    assert exc.message == "boom"
    assert exc.details == {"foo": 1}
    assert str(exc) == "boom"


def test_subclass_status_codes_are_distinct():
    # Status codes pin the HTTP response; they must not collide silently.
    codes = {
        NotFoundError.status_code,
        ValidationError.status_code,
        ServiceError.status_code,
        CredentialError.status_code,
        TimeoutExceededError.status_code,
    }
    assert len(codes) == 5


def test_credential_error_default_details_is_empty_dict():
    # We rely on `.details` always being a dict for the FastAPI handler.
    exc = CredentialError("nope")
    assert exc.details == {}


def test_retryable_tuple_excludes_credential_and_validation():
    # CredentialError and ValidationError must NEVER appear in the
    # retryable tuple — retrying them just burns API quota.
    assert CredentialError not in RETRYABLE_EXCEPTIONS
    assert ValidationError not in RETRYABLE_EXCEPTIONS
    assert NotFoundError not in RETRYABLE_EXCEPTIONS


def test_retryable_tuple_includes_service_error():
    assert ServiceError in RETRYABLE_EXCEPTIONS
    assert TimeoutExceededError in RETRYABLE_EXCEPTIONS
