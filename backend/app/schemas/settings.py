from __future__ import annotations

from typing import Dict

from pydantic import BaseModel


class SettingsUpdate(BaseModel):
    settings: Dict[str, str]


class SettingItem(BaseModel):
    key: str
    value: str
    is_secret: bool
