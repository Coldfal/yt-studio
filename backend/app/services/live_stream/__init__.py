"""Live-streaming helpers split out of ``streaming_service.py``.

The public entry point is still ``app.services.streaming_service``
(the ``StreamManager`` orchestrator + the ``stream_manager``
singleton). This package holds the stateless helpers that don't need
to live on the manager:

- ``ffmpeg_helpers``    — building ffmpeg argv, graceful stop, fallback PNG.
- ``youtube_live_api``  — YouTube Live broadcast + stream + bind + transition.
"""
