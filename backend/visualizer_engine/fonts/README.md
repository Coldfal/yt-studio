# Bundled fonts for the visualizer engine

Drop `.otf` / `.ttf` / `.woff` / `.woff2` files into this directory and
the engine sidecar will register every one of them at startup
(see `exporter.ts → registerBundledFonts`). Once registered, the family
name embedded in the file metadata becomes available to `ctx.font` —
match it with the value picked in the Text panel's **Font Family**
selector.

## Currently expected fonts

- `Trajan Pro 3 Regular.otf` → family name **`Trajan Pro 3`**
- `Cinzel-Variable.ttf` → **`Cinzel`** (OFL — Google Fonts)
- `BebasNeue-Regular.ttf` → **`Bebas Neue`** (OFL)
- `Anton-Regular.ttf` → **`Anton`** (OFL)
- `Oswald-Variable.ttf` → **`Oswald`** (OFL)
- `PlayfairDisplay-Variable.ttf` → **`Playfair Display`** (OFL)
- `Montserrat-Variable.ttf` → **`Montserrat`** (OFL)
- `RobotoSlab-Variable.ttf` → **`Roboto Slab`** (Apache 2.0)
- `Lato-Regular.ttf`, `Lato-Bold.ttf` → **`Lato`** (OFL)
- `Inter-Variable.ttf` → **`Inter`** (OFL)

These are the starter pack for the Thumbnail editor's font picker. To
re-fetch them on a fresh checkout, run the `download-fonts` script (or
just drop your own .ttf/.otf files in — both the engine and the
`GET /api/fonts` endpoint scan this directory at startup).

## Notes

- These files are intentionally **gitignored** — most paid fonts
  (Adobe, Monotype, etc.) are licensed per-machine and shouldn't sit
  in version control. OFL fonts are safe to commit, but we keep them
  out so the rule stays simple ("never commit fonts").
- Missing fonts are not a fatal error: the renderer falls back to
  `sans-serif` (see `fontStack()` in `frame-renderer.ts`).
- If you change a font file at runtime you'll need to restart the
  backend — registration runs once at module load.
