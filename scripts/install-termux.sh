#!/data/data/com.termux/files/usr/bin/bash
# install-termux.sh — Install OpenClaw on Termux / Android
#
# Usage (in Termux):
#   curl -fsSL https://openclaw.ai/install-termux.sh | bash
#   - OR -
#   bash scripts/install-termux.sh
#
# What this script does:
#   1. Updates Termux packages
#   2. Installs Node.js, git, tmux, python (for pydroid3 compat)
#   3. Installs the openclaw npm package globally
#   4. Installs the @openclaw/termux extension
#   5. Writes a convenience launcher (~/.openclaw/mobile/start.sh)
#
# Supported environments:
#   - Termux (Android)       — primary target
#   - pydroid3 terminal      — supported via Python bridge section
#   - Any POSIX + Node ≥18   — fallback path
#
# For non-Termux systems (macOS/Linux) the standard install script is at:
#   https://openclaw.ai/install.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${CYAN}[openclaw]${RESET} %s\n" "$*"; }
success() { printf "${GREEN}[openclaw]${RESET} ${BOLD}%s${RESET}\n" "$*"; }
warn()    { printf "${YELLOW}[openclaw]${RESET} %s\n" "$*" >&2; }
die()     { printf "${RED}[openclaw] ERROR:${RESET} %s\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Detect environment
# ---------------------------------------------------------------------------
IS_TERMUX=false
if [ -d "/data/data/com.termux" ] || [ "${TERMUX_VERSION:-}" != "" ]; then
  IS_TERMUX=true
fi

IS_PYDROID=false
if [ "${ANDROID_ROOT:-}" != "" ] && ! $IS_TERMUX; then
  IS_PYDROID=true
fi

info "Detected environment: $(uname -s) $(uname -m)"
$IS_TERMUX  && info "  → Termux detected"
$IS_PYDROID && info "  → pydroid3/Android detected"

# ---------------------------------------------------------------------------
# Package manager helpers
# ---------------------------------------------------------------------------
pkg_install() {
  if $IS_TERMUX; then
    pkg install -y "$@"
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get install -y "$@"
  elif command -v brew >/dev/null 2>&1; then
    brew install "$@"
  else
    warn "Cannot install packages automatically. Please install: $*"
  fi
}

# ---------------------------------------------------------------------------
# 1. Update package index
# ---------------------------------------------------------------------------
info "Updating package index…"
if $IS_TERMUX; then
  pkg update -y || warn "pkg update failed — continuing anyway"
fi

# ---------------------------------------------------------------------------
# 2. System dependencies
# ---------------------------------------------------------------------------
info "Installing system dependencies…"

# Node.js
if ! command -v node >/dev/null 2>&1; then
  info "  Installing Node.js…"
  pkg_install nodejs
else
  NODE_VER=$(node --version 2>/dev/null || echo "unknown")
  info "  Node.js already installed: $NODE_VER"
fi

# git
if ! command -v git >/dev/null 2>&1; then
  info "  Installing git…"
  pkg_install git
fi

# tmux
if ! command -v tmux >/dev/null 2>&1; then
  info "  Installing tmux…"
  pkg_install tmux
else
  info "  tmux already installed: $(tmux -V)"
fi

# python3 (pydroid3 bridge compatibility)
if ! command -v python3 >/dev/null 2>&1; then
  info "  Installing python3…"
  pkg_install python
fi

# ---------------------------------------------------------------------------
# 3. npm / npx availability
# ---------------------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  die "npm not found after Node.js install. Please check your Termux Node package."
fi

info "npm version: $(npm --version)"

# ---------------------------------------------------------------------------
# 4. Install openclaw CLI
# ---------------------------------------------------------------------------
info "Installing openclaw CLI…"
npm install -g openclaw --prefer-offline 2>&1 | tail -5

if ! command -v openclaw >/dev/null 2>&1; then
  die "openclaw binary not found after install. Try: npm install -g openclaw"
fi

OPENCLAW_VER=$(openclaw --version 2>/dev/null || echo "unknown")
success "openclaw installed: $OPENCLAW_VER"

# ---------------------------------------------------------------------------
# 5. Install the @openclaw/termux extension
# ---------------------------------------------------------------------------
info "Installing @openclaw/termux extension…"

OPENCLAW_DIR="${HOME}/.openclaw"
PLUGIN_DIR="${OPENCLAW_DIR}/plugins/termux"

mkdir -p "$PLUGIN_DIR"

# Write a minimal package.json so npm install works in the plugin dir.
cat > "${PLUGIN_DIR}/package.json" <<'PKGJSON'
{
  "name": "openclaw-termux-install",
  "version": "1.0.0",
  "private": true,
  "description": "Termux plugin install helper"
}
PKGJSON

cd "$PLUGIN_DIR"
npm install --save @openclaw/termux 2>&1 | tail -5
cd -

success "@openclaw/termux extension installed at ${PLUGIN_DIR}"

# ---------------------------------------------------------------------------
# 6. tmux convenience layout script
# ---------------------------------------------------------------------------
MOBILE_DIR="${OPENCLAW_DIR}/mobile"
mkdir -p "$MOBILE_DIR"

cat > "${MOBILE_DIR}/start.sh" <<'LAUNCHER'
#!/bin/bash
# OpenClaw Mobile Launcher — starts a tmux session with three panes:
#   [0] openclaw gateway
#   [1] openclaw mobile web UI
#   [2] interactive shell
set -euo pipefail

SESSION="openclaw"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already running — attaching…"
  exec tmux attach-session -t "$SESSION"
fi

# Create session with the gateway window.
tmux new-session -d -s "$SESSION" -n gateway
tmux send-keys -t "${SESSION}:0" "openclaw gateway" Enter

# Open a second window for the mobile web UI.
tmux new-window -t "$SESSION" -n mobile-ui
tmux send-keys -t "${SESSION}:1" "openclaw agent --tool start_mobile_ui" Enter

# Open a third window as an interactive shell.
tmux new-window -t "$SESSION" -n shell

# Attach to the shell window.
tmux select-window -t "${SESSION}:2"
exec tmux attach-session -t "$SESSION"
LAUNCHER

chmod +x "${MOBILE_DIR}/start.sh"

# ---------------------------------------------------------------------------
# 7. pydroid3 Python bridge helper
# ---------------------------------------------------------------------------
cat > "${MOBILE_DIR}/pydroid_bridge.py" <<'PYBRIDGE'
#!/usr/bin/env python3
"""
pydroid3 / Termux Python bridge for OpenClaw.

Run this script inside pydroid3 or `python3 pydroid_bridge.py` in Termux
to open an interactive text chat with your local OpenClaw agent.

Requirements:
  pip install requests   (or urllib — see USE_URLLIB below)

Usage:
  python3 pydroid_bridge.py [--port 8899] [--key YOUR_API_KEY]
"""

import sys
import argparse
import json
import urllib.request as urlreq
import urllib.parse

def send_message(base_url, msg, api_key=""):
    params = f"msg={urllib.parse.quote(msg)}"
    if api_key:
        params += f"&key={urllib.parse.quote(api_key)}"
    url = f"{base_url}/chat?{params}"
    reply_parts = []
    try:
        with urlreq.urlopen(url, timeout=60) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n")
                if line.startswith("data:"):
                    reply_parts.append(line[5:].lstrip())
    except Exception as e:
        return f"[Error] {e}"
    return "".join(reply_parts)

def main():
    parser = argparse.ArgumentParser(description="OpenClaw pydroid3 bridge")
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--key", default="")
    args = parser.parse_args()

    base_url = f"http://127.0.0.1:{args.port}"
    print(f"OpenClaw pydroid3 bridge — connecting to {base_url}")
    print("Type your message and press Enter.  Ctrl+C to quit.\n")

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            sys.exit(0)

        if not user_input:
            continue
        reply = send_message(base_url, user_input, args.key)
        print(f"\nAgent: {reply}\n")

if __name__ == "__main__":
    main()
PYBRIDGE

chmod +x "${MOBILE_DIR}/pydroid_bridge.py"

# ---------------------------------------------------------------------------
# 8. Summary
# ---------------------------------------------------------------------------
cat <<SUMMARY

${GREEN}${BOLD}OpenClaw Termux installation complete!${RESET}

Files created:
  ${CYAN}${OPENCLAW_DIR}/mobile/start.sh${RESET}         — tmux launcher (3-pane layout)
  ${CYAN}${OPENCLAW_DIR}/mobile/pydroid_bridge.py${RESET} — pydroid3 / Python bridge
  ${CYAN}${OPENCLAW_DIR}/plugins/termux/${RESET}         — @openclaw/termux extension

Quick start:
  ${BOLD}bash ${MOBILE_DIR}/start.sh${RESET}

  This opens a tmux session with:
    • Window 0 — openclaw gateway
    • Window 1 — mobile web UI  (browse to http://localhost:8899/)
    • Window 2 — interactive shell

pydroid3 / Python usage:
  1. Start openclaw in Termux:  ${BOLD}bash ${MOBILE_DIR}/start.sh${RESET}
  2. In pydroid3:               ${BOLD}python3 ${MOBILE_DIR}/pydroid_bridge.py${RESET}

Documentation:
  https://docs.openclaw.ai/platforms/android

SUMMARY
