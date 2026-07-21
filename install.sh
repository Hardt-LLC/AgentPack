#!/bin/sh
# AgentPack installer — downloads a standalone binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/Hardt-LLC/AgentPack/main/install.sh | sh
#
# Options (environment variables):
#   AGENTPACK_VERSION   release tag to install (default: latest)
#   AGENTPACK_BIN_DIR   install directory (default: ~/.local/bin, or /usr/local/bin when writable)
set -eu

REPO="Hardt-LLC/AgentPack"
VERSION="${AGENTPACK_VERSION:-latest}"

die() { echo "agentpack-install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
need curl
need uname

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *) die "unsupported OS: $OS (use Windows? download agentpack-windows-x64.exe from https://github.com/$REPO/releases)" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac
TARGET="$OS-$ARCH"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/agentpack-$TARGET"
  SUMS_URL="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/agentpack-$TARGET"
  SUMS_URL="https://github.com/$REPO/releases/download/$VERSION/SHA256SUMS"
fi

if [ -n "${AGENTPACK_BIN_DIR:-}" ]; then
  BIN_DIR="$AGENTPACK_BIN_DIR"
elif [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR" || die "cannot create $BIN_DIR"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "agentpack-install: downloading agentpack ($TARGET, $VERSION)"
curl -fsSL "$URL" -o "$TMP/agentpack" || die "download failed: $URL"

# Verify checksum when the sums file is available (never abort just because
# it is missing — older releases may not have one).
if curl -fsSL "$SUMS_URL" -o "$TMP/SHA256SUMS" 2>/dev/null; then
  EXPECTED=$(grep "agentpack-$TARGET\$" "$TMP/SHA256SUMS" | awk '{print $1}')
  if [ -n "$EXPECTED" ]; then
    if command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "$TMP/agentpack" | awk '{print $1}')
    else
      ACTUAL=$(sha256sum "$TMP/agentpack" | awk '{print $1}')
    fi
    [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch (expected $EXPECTED, got $ACTUAL)"
    echo "agentpack-install: checksum ok"
  fi
fi

mv "$TMP/agentpack" "$BIN_DIR/agentpack"
chmod +x "$BIN_DIR/agentpack"

echo "agentpack-install: installed to $BIN_DIR/agentpack"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "agentpack-install: note — $BIN_DIR is not on your PATH" ;;
esac
echo "agentpack-install: run 'agentpack setup' to configure your agents"
