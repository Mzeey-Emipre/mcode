#!/usr/bin/env bash
set -euo pipefail

RELEASE_DIR="${1:-apps/desktop/release}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="mcode-linux-artifact-smoke:ubuntu22"
IMAGE_CACHE="${MCODE_LINUX_ARTIFACT_IMAGE_CACHE:-}"

if [ ! -d "$RELEASE_DIR" ]; then
  echo "[linux-artifact-smoke] ERROR: release directory not found: $RELEASE_DIR" >&2
  exit 1
fi

appimage="$(find "$RELEASE_DIR" -maxdepth 1 -type f -name "*.AppImage" | head -n 1)"
deb="$(find "$RELEASE_DIR" -maxdepth 1 -type f -name "*.deb" | head -n 1)"

if [ -z "$appimage" ] || [ -z "$deb" ]; then
  echo "[linux-artifact-smoke] ERROR: expected both AppImage and deb artifacts in $RELEASE_DIR" >&2
  find "$RELEASE_DIR" -maxdepth 1 -type f -print >&2
  exit 1
fi

abs_release_dir="$(cd "$RELEASE_DIR" && pwd)"

if [ -n "$IMAGE_CACHE" ] && [ -f "$IMAGE_CACHE" ]; then
  docker load --input "$IMAGE_CACHE"
else
  docker build --tag "$IMAGE" --file "$SCRIPT_DIR/Dockerfile.ubuntu22" "$SCRIPT_DIR"
  if [ -n "$IMAGE_CACHE" ]; then
    mkdir -p "$(dirname "$IMAGE_CACHE")"
    docker save --output "$IMAGE_CACHE" "$IMAGE"
  fi
fi

docker run --rm \
  --volume "$abs_release_dir:/release:ro" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail

    appimage="$(find /release -maxdepth 1 -type f -name "*.AppImage" | head -n 1)"
    deb="$(find /release -maxdepth 1 -type f -name "*.deb" | head -n 1)"

    echo "[linux-artifact-smoke] Ubuntu: $(. /etc/os-release && echo "$PRETTY_NAME")"
    echo "[linux-artifact-smoke] AppImage: $appimage"
    echo "[linux-artifact-smoke] deb: $deb"

    tmpdir="$(mktemp -d)"
    dpkg-deb -x "$deb" "$tmpdir/deb-root"
    echo "[linux-artifact-smoke] deb GLIBC requirements:"
    find "$tmpdir/deb-root" -type f -perm /111 -print0 \
      | xargs -0 -r strings \
      | grep -o "GLIBC_[0-9.]*" \
      | sort -Vu \
      | tail -n 10 || true

    tmp_appimage="$tmpdir/$(basename "$appimage")"
    cp "$appimage" "$tmp_appimage"
    chmod +x "$tmp_appimage"
    "$tmp_appimage" --appimage-extract >/dev/null
    echo "[linux-artifact-smoke] AppImage GLIBC requirements:"
    find squashfs-root -type f -perm /111 -print0 \
      | xargs -0 -r strings \
      | grep -o "GLIBC_[0-9.]*" \
      | sort -Vu \
      | tail -n 10 || true

    timeout 3m apt-get install -y --no-install-recommends "$deb"
    installed_bin="$(command -v mcode-desktop || command -v mcode || true)"
    if [ -z "$installed_bin" ]; then
      echo "[linux-artifact-smoke] ERROR: installed desktop binary not found on PATH" >&2
      exit 1
    fi

    echo "[linux-artifact-smoke] Launching installed deb binary: $installed_bin"
    timeout 20s xvfb-run -a "$installed_bin" --no-sandbox --disable-gpu --version

    echo "[linux-artifact-smoke] Launching AppImage"
    timeout 20s env APPIMAGE_EXTRACT_AND_RUN=1 xvfb-run -a "$tmp_appimage" --no-sandbox --disable-gpu --version

    echo "[linux-artifact-smoke] PASS: AppImage and deb launch on Ubuntu 22.04."
  '
