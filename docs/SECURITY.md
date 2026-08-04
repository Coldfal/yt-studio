# Security

YT Studio is a **single-operator, local-host application**. It is not designed to be exposed to a LAN or the public internet.

## Safe defaults

- The backend binds to `127.0.0.1` by default.
- The API has no login layer. Do not change the host to `0.0.0.0` or place it behind a public reverse proxy without independently adding authentication and a security review.
- `data/`, `.env`, OAuth-client JSON files, logs, and private keys are ignored by Git.

## Credentials and local data

Provider credentials entered in Settings are encrypted in `data/studio.db`. The decryption key is `data/studio.key`. The database and key together allow access to stored credentials; protect and back them up together.

Never publish or attach any of these to an issue:

- `data/` or database backups
- `.env`
- `client_secret_*.json`
- API keys, OAuth tokens, browser cookies, or screenshots containing them
- logs containing personal file paths, tokens, or media metadata

If any credential or data file was committed or shared, revoke the affected provider credential, create a replacement, and remove the secret from repository history before making the repository public.

## Key loss and rotation

The repository does **not** currently include an automated key-rotation script. If `data/studio.key` is lost or exposed, treat every stored credential as compromised: revoke or replace provider credentials, delete the unreadable encrypted values from the database, start with a new key, then reconnect/re-enter credentials through the UI. See [OPERATIONS.md](OPERATIONS.md) for recovery guidance.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or credential exposure. Contact the repository maintainer privately through the contact method listed in the repository profile, with a concise reproduction and no unnecessary secret material. The maintainer will acknowledge the report, assess impact, and coordinate a fix before public disclosure.

## Responsible use

You are responsible for the media you import, download, render, stream, or upload, and for compliance with the terms and policies of YouTube and any connected provider.
