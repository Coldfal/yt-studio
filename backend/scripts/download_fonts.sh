#!/usr/bin/env bash
# Download the OFL/Apache-licensed font starter pack for the thumbnail
# editor + visualizer engine into backend/visualizer_engine/fonts/.
#
# These files are gitignored (see fonts/README.md for the reasoning) so
# a fresh checkout needs to re-fetch them. Idempotent: skips files that
# already exist and are non-trivial in size.
#
# Usage from repo root:
#   ./backend/scripts/download_fonts.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/visualizer_engine/fonts"
mkdir -p "$DIR"
cd "$DIR"

declare -A FONTS=(
  ["Cinzel-Variable.ttf"]="https://github.com/google/fonts/raw/main/ofl/cinzel/Cinzel%5Bwght%5D.ttf"
  ["Inter-Variable.ttf"]="https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf"
  ["PlayfairDisplay-Variable.ttf"]="https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"
  ["Oswald-Variable.ttf"]="https://github.com/google/fonts/raw/main/ofl/oswald/Oswald%5Bwght%5D.ttf"
  ["Montserrat-Variable.ttf"]="https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf"
  ["RobotoSlab-Variable.ttf"]="https://github.com/google/fonts/raw/main/apache/robotoslab/RobotoSlab%5Bwght%5D.ttf"
  ["BebasNeue-Regular.ttf"]="https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf"
  ["Anton-Regular.ttf"]="https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf"
  ["Lato-Regular.ttf"]="https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf"
  ["Lato-Bold.ttf"]="https://github.com/google/fonts/raw/main/ofl/lato/Lato-Bold.ttf"
)

ok=0; skip=0; fail=0
for name in "${!FONTS[@]}"; do
  if [[ -f "$name" && $(stat -c %s "$name" 2>/dev/null || stat -f %z "$name") -gt 10000 ]]; then
    skip=$((skip+1)); echo "  − $name (already present)"
    continue
  fi
  if curl -fsSL -o "$name" "${FONTS[$name]}"; then
    sz=$(stat -c %s "$name" 2>/dev/null || stat -f %z "$name")
    if (( sz > 10000 )); then
      ok=$((ok+1)); echo "  ✓ $name ($sz bytes)"
    else
      rm -f "$name"; fail=$((fail+1)); echo "  ✗ $name (truncated, $sz bytes)"
    fi
  else
    fail=$((fail+1)); echo "  ✗ $name (HTTP error)"
  fi
done

echo
echo "Done. downloaded=$ok skipped=$skip failed=$fail"
echo "Restart the backend to pick up newly-downloaded fonts."
