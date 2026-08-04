"""Filesystem-browsing endpoints for the New Project wizard's folder
picker.

The Music step in the wizard lets the user pick a folder of audio
files from anywhere on their local PC. Pasting a long Windows path
by hand is painful, so we expose a tiny "list directories under this
path" endpoint that the frontend wraps in a Browse-like dialog.

Single-user local app: this is fine. The backend already runs on
``127.0.0.1`` and the host is the operator's own machine, so there's
no cross-tenant leak risk. We still apply a couple of safety
constraints:

- Only directory entries are returned (no files, no symlinks
  outside the requested root).
- Hidden / system folders (anything starting with ``.`` or
  ``$RECYCLE.BIN``-style names) are filtered out so the browser
  isn't full of noise.
- ``access denied`` errors on individual subfolders are swallowed
  silently — you skip the folder you can't read instead of failing
  the whole listing.
"""
from __future__ import annotations

import os
import string
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/fs", tags=["fs"])


# Audio extensions match what the rest of the pipeline accepts. Used
# to count audio files in a folder for the picker UI ("17 tracks").
_AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus"}

# Skip these directory names in any listing — they're noise on Windows
# and macOS. The user can still navigate INTO one by typing its name,
# we just don't surface them by default.
_HIDDEN_DIR_NAMES = {
    "$RECYCLE.BIN",
    "System Volume Information",
    "RECYCLER",
    ".Trash",
    ".Trashes",
    "node_modules",
    "__pycache__",
    ".git",
    ".svn",
    ".DS_Store",
}


class FsEntry(BaseModel):
    name: str
    path: str
    audio_file_count: int = 0


class FsListResponse(BaseModel):
    path: str
    parent: Optional[str]
    entries: List[FsEntry]
    # When path is the empty string on Windows, we synthesise a list
    # of available drive letters as the entries. The frontend treats
    # any entry as "navigable", so this works seamlessly.
    is_root: bool = False


def _windows_drives() -> List[Path]:
    """Return paths for every drive letter that currently exists.

    Uses ``os.path.exists("C:\\")`` style checks per letter — fast
    enough (26 stat calls on a cold cache) and avoids pulling in
    ``ctypes`` or other Win32 helpers.
    """
    if os.name != "nt":
        return []
    out: List[Path] = []
    for letter in string.ascii_uppercase:
        d = Path(f"{letter}:\\")
        if d.exists():
            out.append(d)
    return out


@router.get("/list-dirs", response_model=FsListResponse)
def list_dirs(path: str = "") -> FsListResponse:
    """List the directories inside ``path``.

    Empty ``path`` returns the filesystem root: drive letters on
    Windows, ``/`` on Unix. The frontend uses this for the picker's
    initial state so the user doesn't have to type anything.

    Each entry includes ``audio_file_count`` — the number of files
    in that subfolder whose extension is in the audio whitelist. The
    UI badges this so the user can see at a glance which subfolders
    have music (vs random data folders).
    """
    if not path:
        # Root — drive list on Windows, / on Unix.
        if os.name == "nt":
            drives = _windows_drives()
            return FsListResponse(
                path="",
                parent=None,
                is_root=True,
                entries=[
                    FsEntry(
                        name=str(d).rstrip("\\/") or str(d),
                        path=str(d),
                        audio_file_count=0,
                    )
                    for d in drives
                ],
            )
        else:
            path = "/"

    p = Path(path).expanduser()
    try:
        p = p.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid path: {exc}",
        )
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {p}")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {p}")

    parent_str: Optional[str] = None
    if p.parent != p:
        parent_str = str(p.parent)
    elif os.name == "nt":
        # On Windows, ``C:\`` resolves with parent == self. Emit ``""``
        # as the parent so the frontend can navigate UP to the drive
        # list.
        parent_str = ""

    entries: List[FsEntry] = []
    try:
        with os.scandir(p) as it:
            for entry in it:
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                name = entry.name
                if name in _HIDDEN_DIR_NAMES:
                    continue
                if name.startswith("."):
                    continue
                # Cheap audio-count: scan one level deep, cap at the
                # first 200 entries so a 10k-file folder doesn't stall
                # the picker. The cap is purely a UX guardrail — the
                # actual scan-folder endpoint reads them all when the
                # user picks the folder.
                count = 0
                try:
                    sub = Path(entry.path)
                    with os.scandir(sub) as sub_it:
                        for i, child in enumerate(sub_it):
                            if i >= 200:
                                count = max(count, 200)
                                break
                            try:
                                if not child.is_file(follow_symlinks=False):
                                    continue
                            except OSError:
                                continue
                            ext = os.path.splitext(child.name)[1].lower()
                            if ext in _AUDIO_EXTS:
                                count += 1
                except (PermissionError, OSError):
                    count = 0
                entries.append(
                    FsEntry(name=name, path=entry.path, audio_file_count=count)
                )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied: {p}",
        )

    entries.sort(key=lambda e: e.name.lower())
    return FsListResponse(
        path=str(p),
        parent=parent_str,
        entries=entries,
        is_root=False,
    )
