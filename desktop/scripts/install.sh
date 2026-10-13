#!/bin/sh
# Downloads Sieve Desktop and opens the installer window, without the
# Gatekeeper "can't verify" prompt: curl (and gh) do not set the quarantine
# flag, so the DMG and the app dragged out of it open normally.
#
# Default: the newest desktop release (tag desktop-v*) of the public repo.
# Saves the DMG to ~/Downloads and opens it; you drag Sieve to Applications.
#   curl -fsSL https://raw.githubusercontent.com/trilitech/Sieve/desktop-app/desktop/scripts/install.sh | sh
#
# Options (after `sh -s --` when piping):
#   --install         copy Sieve to /Applications and open it (no drag window)
#   --url <dmg url>   use a direct link (S3/GCS/R2 signed link, internal server)
#   --gh <owner/repo> use a private GitHub release via `gh` (needs gh auth login)
#   --tag <tag>       with --gh: a specific release instead of the latest
#   --sha256 <hex>    refuse to continue unless the download matches
# Environment: SIEVE_REPO (default trilitech/Sieve) picks the public repo.
#
# Internal test builds only. Public releases should be Developer-ID signed
# and notarized instead.
set -eu

URL="" REPO="" TAG="" SHA256="" AUTO=0
DEST="${SIEVE_INSTALL_DIR:-/Applications}"
DOWNLOADS="${SIEVE_DOWNLOAD_DIR:-$HOME/Downloads}"

while [ $# -gt 0 ]; do
  case "$1" in
    --install) AUTO=1; shift ;;
    --url) URL="$2"; shift 2 ;;
    --gh) REPO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --sha256) SHA256="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "sieve install: $*" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || die "macOS only"
[ "$(uname -m)" = "arm64" ] || die "this build is for Apple Silicon Macs only"
PUBLIC_REPO="${SIEVE_REPO:-trilitech/Sieve}"

TMP="$(mktemp -d)"
MNT=""
cleanup() { [ -n "$MNT" ] && hdiutil detach "$MNT" -quiet 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# --- Find and download the DMG ---------------------------------------------
if [ -n "$REPO" ]; then
  command -v gh >/dev/null || die "GitHub CLI not found (brew install gh, then gh auth login)"
  echo "Downloading Sieve…"
  if [ -n "$TAG" ]; then
    gh release download "$TAG" -R "$REPO" -p 'Sieve-*-arm64.dmg' -D "$TMP"
  else
    gh release download -R "$REPO" -p 'Sieve-*-arm64.dmg' -D "$TMP"
  fi
  SRC="$(ls "$TMP"/Sieve-*-arm64.dmg | head -1)"
else
  if [ -z "$URL" ]; then
    # Newest release whose tag starts with desktop-v (pre-releases included),
    # via the public GitHub API: no login needed.
    echo "Finding the latest Sieve Desktop release…"
    URL="$(curl -fsSL "https://api.github.com/repos/${PUBLIC_REPO}/releases?per_page=30" \
      | grep -o '"browser_download_url": *"[^"]*/download/desktop-v[^"]*/Sieve-[^"]*-arm64\.dmg"' \
      | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/')" || true
    [ -n "$URL" ] || die "no desktop release found in ${PUBLIC_REPO}"
  fi
  echo "Downloading Sieve…"
  SRC="$TMP/$(basename "$URL" | sed 's/[?#].*//')"
  case "$SRC" in *.dmg) ;; *) SRC="$TMP/Sieve.dmg" ;; esac
  curl -fL --progress-bar "$URL" -o "$SRC"
fi
[ -s "$SRC" ] || die "download failed"

if [ -n "$SHA256" ]; then
  echo "$SHA256  $SRC" | shasum -a 256 -c - >/dev/null || die "checksum mismatch: refusing to continue"
fi

# --- Default: open the installer window, the user drags Sieve over ---------
if [ "$AUTO" -eq 0 ]; then
  mkdir -p "$DOWNLOADS"
  DMG="${DOWNLOADS}/$(basename "$SRC")"
  mv -f "$SRC" "$DMG"
  echo "Saved ${DMG}"
  if [ "${SIEVE_INSTALL_NO_OPEN:-}" != "1" ]; then
    open "$DMG"
    echo "Drag Sieve to Applications, then open it from Applications."
  fi
  exit 0
fi

# --- --install: copy to Applications and open --------------------------------
echo "Installing to ${DEST}…"
MNT="$(hdiutil attach -nobrowse -readonly "$SRC" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
[ -d "$MNT/Sieve.app" ] || die "Sieve.app not found in the disk image"

# Quit only the copy being replaced, never another Sieve elsewhere.
BIN="${DEST}/Sieve.app/Contents/MacOS/Sieve"
if pgrep -qf "^${BIN}" 2>/dev/null; then
  echo "Quitting the running Sieve…"
  osascript -e "tell application \"${DEST}/Sieve.app\" to quit" >/dev/null 2>&1 || true
  i=0; while pgrep -qf "^${BIN}" && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
fi

mkdir -p "$DEST"
rm -rf "$DEST/Sieve.app"
ditto "$MNT/Sieve.app" "$DEST/Sieve.app"
# Belt and braces: in case the DMG itself arrived quarantined some other way.
xattr -dr com.apple.quarantine "$DEST/Sieve.app" 2>/dev/null || true

echo "Installed to ${DEST}/Sieve.app"
if [ "${SIEVE_INSTALL_NO_OPEN:-}" != "1" ]; then
  open "$DEST/Sieve.app"
fi
