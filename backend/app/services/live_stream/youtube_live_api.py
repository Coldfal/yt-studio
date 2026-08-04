"""YouTube Live API helpers — broadcast + stream + bind + transition.

Stateless wrappers over the ``googleapiclient`` calls. They take a
``Credentials`` object and don't touch DB state — the manager is
responsible for loading/storing credentials and persisting the
returned IDs.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Tuple

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


_DEFAULT_SCOPES = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.upload",
]


def credentials_from_json(creds_json: str) -> Credentials:
    """Build a google-auth ``Credentials`` from a stored JSON blob.

    The blob shape is what the OAuth callback persists in
    ``Channel.youtube_credentials_json`` (encrypted at rest, decrypted
    by ``credentials_service.get_channel_youtube_credentials``).
    """
    creds_data = json.loads(creds_json)
    return Credentials(
        token=creds_data.get("token"),
        refresh_token=creds_data.get("refresh_token"),
        token_uri=creds_data.get(
            "token_uri", "https://oauth2.googleapis.com/token"
        ),
        client_id=creds_data.get("client_id"),
        client_secret=creds_data.get("client_secret"),
        scopes=creds_data.get("scopes", _DEFAULT_SCOPES),
    )


def create_broadcast_and_stream(
    credentials: Credentials,
    title: str,
    description: str,
) -> Tuple[str, str, str]:
    """Create a YouTube Live broadcast + stream, bind them, return ids + RTMP URL.

    Three sequential API calls (each one network-bound, ~200–500ms):

    1. ``liveBroadcasts.insert`` — creates the public-facing
       broadcast that viewers find. ``enableAutoStart`` flips it
       live as soon as ingest starts.
    2. ``liveStreams.insert`` — creates the ingest endpoint
       (the RTMP URL we point FFmpeg at).
    3. ``liveBroadcasts.bind`` — links them so the broadcast
       reads from the stream.

    Returns ``(broadcast_id, stream_id, rtmp_url)``. The RTMP URL is
    ``{ingestionAddress}/{streamName}`` — same string FFmpeg's ``-f
    flv`` output expects.
    """
    youtube = build("youtube", "v3", credentials=credentials)

    # 1. Create broadcast
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    broadcast_body = {
        "snippet": {
            "title": title,
            "description": description,
            "scheduledStartTime": now_iso,
        },
        "status": {
            "privacyStatus": "public",
            "selfDeclaredMadeForKids": False,
        },
        "contentDetails": {
            "enableAutoStart": True,
            "enableAutoStop": True,
        },
    }
    broadcast_resp = youtube.liveBroadcasts().insert(
        part="snippet,status,contentDetails",
        body=broadcast_body,
    ).execute()
    broadcast_id = broadcast_resp["id"]

    # 2. Create stream
    stream_body = {
        "snippet": {"title": f"{title} - stream"},
        "cdn": {
            "frameRate": "30fps",
            "ingestionType": "rtmp",
            "resolution": "1080p",
        },
    }
    stream_resp = youtube.liveStreams().insert(
        part="snippet,cdn",
        body=stream_body,
    ).execute()
    stream_id = stream_resp["id"]
    ingestion_info = stream_resp["cdn"]["ingestionInfo"]
    rtmp_url = f"{ingestion_info['ingestionAddress']}/{ingestion_info['streamName']}"

    # 3. Bind
    youtube.liveBroadcasts().bind(
        id=broadcast_id,
        part="id,contentDetails",
        streamId=stream_id,
    ).execute()

    return broadcast_id, stream_id, rtmp_url


def transition_broadcast_complete(
    credentials: Credentials,
    broadcast_id: str,
) -> None:
    """Transition a YouTube Live broadcast to 'complete'.

    Called when the operator stops the stream — flips the broadcast
    out of live mode so YouTube doesn't keep showing "Stream
    interrupted" if the encoder dies abnormally.
    """
    youtube = build("youtube", "v3", credentials=credentials)
    youtube.liveBroadcasts().transition(
        broadcastStatus="complete",
        id=broadcast_id,
        part="id,status",
    ).execute()
