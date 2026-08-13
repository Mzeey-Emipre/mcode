#!/usr/bin/env bash
set -euo pipefail

RELEASE_DIR="${1:-apps/desktop/release}"

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

docker run --rm \
  --volume "$abs_release_dir:/release:ro" \
  ubuntu:22.04 \
  bash -lc '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive

    apt-get update
    apt-get install -y --no-install-recommends \
      ca-certificates \
      file \
      fuse \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnss3 \
      libx11-xcb1 \
      libxcb-dri3-0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxshmfence1 \
      xvfb

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

    apt-get install -y --no-install-recommends "$deb"
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
