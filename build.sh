#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-dev}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

info() { echo "[INFO] $*"; }
error() { echo "[ERROR] $*" >&2; exit 1; }

command -v node >/dev/null || error "Node.js is required"
command -v npm >/dev/null || error "npm is required"
command -v cargo >/dev/null || error "Rust/Cargo is required"

cd "$PROJECT_DIR"
if [[ ! -d node_modules ]]; then
  info "Installing npm dependencies"
  npm ci
fi

case "$MODE" in
  dev)
    info "Building AfterTerm (debug)"
    if [[ "$(uname -s)" == "Darwin" ]]; then
      npm run tauri build -- --debug --bundles app
    else
      npm run tauri build -- --debug --no-bundle
    fi
    ;;
  release|bundle)
    info "Building AfterTerm (release)"
    npm run tauri build -- --bundles app
    ;;
  *)
    error "Unknown mode: $MODE (use dev, release, or bundle)"
    ;;
esac
