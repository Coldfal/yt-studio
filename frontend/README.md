# YT Studio frontend

This React/Vite application is the browser UI for the local YT Studio backend.

From this directory:

```powershell
npm ci
npm run dev
npm run lint
npm run build
```

The development server proxies `/api` and `/files` to `http://localhost:8000`. Run the backend first; see the repository [README](../README.md) for the full setup and security constraints.
