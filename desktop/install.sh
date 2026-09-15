#!/usr/bin/env bash
# Installe le sous-titrage live comme application de bureau pour l'utilisateur
# courant : pose le lanceur, le .desktop et les icônes sous ~/.local (aucun sudo).
# Relancer ce script met à jour l'install.
#
#   ./desktop/install.sh            # installe / met à jour
#   ./desktop/install.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$HERE/.." && pwd)"

BINDIR="$HOME/.local/bin"
APPDIR="$HOME/.local/share/applications"
ICONROOT="$HOME/.local/share/icons/hicolor"
SCRIPT_DST="$BINDIR/captive-transcription-app"
DESKTOP_DST="$APPDIR/captive-transcription.desktop"
SLUG="captive-transcription"

uninstall() {
  rm -f "$SCRIPT_DST" "$DESKTOP_DST"
  rm -f "$ICONROOT/scalable/apps/$SLUG.svg"
  for s in 16 32 48 64 128 256; do rm -f "$ICONROOT/${s}x${s}/apps/$SLUG.png"; done
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPDIR" || true
  command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$ICONROOT" || true
  echo "Désinstallé (le projet et le profil Chrome sont conservés)."
}

if [ "${1:-}" = "--uninstall" ]; then uninstall; exit 0; fi

# 1. Prérequis. Aucun paquet à installer : le projet n'a aucune dépendance.
command -v node >/dev/null 2>&1 || { echo "node introuvable (sudo apt install nodejs)" >&2; exit 1; }
echo "Node.js : $(node --version)"

BROWSER_OK=""
for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser; do
  command -v "$b" >/dev/null 2>&1 && { BROWSER_OK="$b"; break; }
done
[ -n "$BROWSER_OK" ] && echo "Navigateur : $BROWSER_OK" \
  || echo "  (avertissement : Chrome/Chromium introuvable — il est OBLIGATOIRE au lancement)"

if [ ! -r "$PROJECT_DIR/.env" ]; then
  echo "  (avertissement : $PROJECT_DIR/.env absent — l'app en a besoin pour GLADIA_API_KEY)"
fi

mkdir -p "$BINDIR" "$APPDIR" "$ICONROOT/scalable/apps"

# 2. Lanceur (chemin du projet injecté).
sed "s#__PROJECT__#${PROJECT_DIR//#/\\#}#g" "$HERE/$SLUG-app.sh" > "$SCRIPT_DST"
chmod +x "$SCRIPT_DST"

# 3. Fichier .desktop (chemin du lanceur injecté).
sed "s#__SCRIPT__#${SCRIPT_DST//#/\\#}#g" "$HERE/$SLUG.desktop" > "$DESKTOP_DST"
chmod +x "$DESKTOP_DST"

# 4. Icônes : SVG scalable + PNG matriciels pour le dock.
cp "$HERE/$SLUG.svg" "$ICONROOT/scalable/apps/$SLUG.svg"
rasterize() {
  local size="$1" out="$2"
  if command -v inkscape >/dev/null 2>&1; then
    inkscape "$HERE/$SLUG.svg" --export-type=png -w "$size" -h "$size" -o "$out" >/dev/null 2>&1 && return 0
  fi
  if command -v convert >/dev/null 2>&1; then
    convert -background none -resize "${size}x${size}" "$HERE/$SLUG.svg" "$out" >/dev/null 2>&1 && return 0
  fi
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$HERE/$SLUG.svg" -o "$out" >/dev/null 2>&1 && return 0
  fi
  return 1
}
for s in 16 32 48 64 128 256; do
  dir="$ICONROOT/${s}x${s}/apps"; mkdir -p "$dir"
  rasterize "$s" "$dir/$SLUG.png" || echo "  (avertissement : icône ${s}px non générée — installe inkscape ou imagemagick)"
done

# 5. Rafraîchir les caches de bureau.
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPDIR" || true
command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$ICONROOT" || true
command -v desktop-file-validate  >/dev/null 2>&1 && desktop-file-validate "$DESKTOP_DST" || true

echo
echo "Installé ✓"
echo "  lanceur : $SCRIPT_DST"
echo "  desktop : $DESKTOP_DST"
echo "Cherche « Surtitres Live » dans tes applications (épingle-le au dock)."
