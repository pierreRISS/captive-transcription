#!/usr/bin/env bash
# Lance le sous-titrage live comme une application de bureau :
#   1. démarre le serveur local (server.mjs) en tâche de fond s'il ne tourne pas
#      déjà — détaché, donc il reste chaud pour les prochains clics ;
#   2. attend qu'il réponde sur le port ;
#   3. ouvre une fenêtre Chrome dédiée (--app) sur la console de contrôle.
#
# La fenêtre de surtitres s'ouvre depuis le bouton de la régie : elle devient
# une fenêtre indépendante, à glisser sur l'écran de scène puis F11.
#
# Le chemin du projet est injecté par install.sh à la place de __PROJECT__.
# La variable SOUSTITRAGE_DIR permet de le surcharger.
set -euo pipefail

PROJECT="${SOUSTITRAGE_DIR:-__PROJECT__}"
SERVER="$PROJECT/server.mjs"
RUNDIR="${XDG_RUNTIME_DIR:-/tmp}"
LOG="$RUNDIR/captive-transcription.log"
PORT_FILE="$RUNDIR/captive-transcription.port"
URL=""

notify() {
  command -v notify-send >/dev/null 2>&1 && notify-send "Surtitres Live" "$1" || true
  echo "captive-transcription: $1" >&2
}

# Est-ce bien NOTRE serveur qui répond ? /api/health porte une signature.
ours_up() {
  [ -n "$URL" ] && curl -fsS --max-time 1 "${URL}/api/health" 2>/dev/null \
    | grep -q 'surtitres-live'
}

# Le serveur laissé chaud par un clic précédent est-il plus VIEUX que le code ?
# Sans ce contrôle, modifier le projet ne changerait rien tant que la machine
# n'a pas redémarré : l'icône rouvrirait l'ancienne version, indéfiniment.
server_stale() {
  local started newest
  started="$(curl -fsS --max-time 1 "${URL}/api/health" 2>/dev/null \
    | grep -o '"startedAt":[0-9]*' | cut -d: -f2)"
  # Pas de champ startedAt : serveur d'avant cette vérification, donc périmé.
  [ -n "$started" ] || return 0
  newest="$(find "$PROJECT" -name .git -prune -o -type f \
    \( -name '*.mjs' -o -name '*.js' -o -name '*.html' \) -printf '%T@\n' 2>/dev/null \
    | sort -n | tail -1)"
  [ -n "$newest" ] || return 1
  [ "${newest%%.*}" -gt "$((started / 1000))" ]
}

stop_server() {
  pkill -f "node ${SERVER}" 2>/dev/null || true
  for _ in $(seq 1 50); do ours_up || break; sleep 0.1; done
}
load_url() {
  [ -r "$PORT_FILE" ] || return 1
  local p; p="$(tr -dc '0-9' < "$PORT_FILE")"
  [ -n "$p" ] || return 1
  URL="http://127.0.0.1:${p}"
}

# 1. Serveur déjà lancé lors d'un clic précédent ? On réutilise son port —
#    sauf s'il fait tourner du code périmé, auquel cas on le remplace.
if load_url && ours_up && ! server_stale; then
  : # déjà chaud, et à jour
else
  if load_url && ours_up; then
    notify "nouvelle version du projet — redémarrage du serveur"
    stop_server
  fi
  if ! command -v node >/dev/null 2>&1; then
    notify "Node.js introuvable — installe-le (sudo apt install nodejs)"
    exit 1
  fi
  if [ ! -r "$SERVER" ]; then
    notify "server.mjs introuvable dans $PROJECT"
    exit 1
  fi
  if [ ! -r "$PROJECT/.env" ]; then
    notify "il manque le fichier .env avec GLADIA_API_KEY"
    exit 1
  fi
  # setsid : le serveur survit à la fermeture de la fenêtre. Il glisse tout seul
  # sur le port suivant si celui de .env est déjà pris.
  ( cd "$PROJECT" && setsid node "$SERVER" >"$LOG" 2>&1 & )
  for _ in $(seq 1 100); do
    load_url && ours_up && break
    sleep 0.1
  done
  if ! { load_url && ours_up; }; then
    notify "le serveur n'a pas démarré (voir $LOG)"
    exit 1
  fi
fi

# 2. Chrome, impérativement : la File System Access API et l'AudioWorklet ne
# sont pleinement supportés que là. Pas de repli sur le navigateur par défaut,
# qui serait peut-être Firefox et échouerait silencieusement le jour J.
BROWSER=""
for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done
if [ -z "$BROWSER" ]; then
  notify "Chrome/Chromium introuvable — obligatoire pour cette application"
  exit 1
fi

# Profil dédié : fenêtre indépendante du Chrome habituel. Deux bénéfices le
# jour J — l'autorisation micro reste accordée d'une fois sur l'autre, et
# aucune notification ni onglet personnel ne peut surgir devant le public.
PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/captive-transcription/chrome-profile"
mkdir -p "$PROFILE"

exec "$BROWSER" \
  --app="${URL}/operator" \
  --class="SurtitresLive" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check
