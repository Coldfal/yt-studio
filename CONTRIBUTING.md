# Contributing to YT Studio

Thanks for helping improve YT Studio. This project is a local-first tool: changes must keep credentials and media on the operator's machine by default.

## Before opening an issue

- Search existing issues and the troubleshooting guide.
- Never include API keys, OAuth tokens, cookies, databases, logs containing personal data, or media you do not have permission to share.
- Include the operating system, Python and Node versions, reproduction steps, expected behaviour, and sanitised logs where useful.

## Development workflow

Follow [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), then run these checks before a pull request:

```powershell
cd backend
.\venv\Scripts\python.exe -m pytest

cd ..\backend\visualizer_engine
npm ci
npm run build

cd ..\..\frontend
npm ci
npm run lint
npm run build
```

Keep pull requests focused, include tests for behaviour changes, and update public documentation when installation, configuration, or user-visible behaviour changes.

## Pull requests

By submitting a contribution, you agree to license it under Apache-2.0. Do not submit material you do not have the right to contribute.
