#!/bin/sh
# One-line installer for Tether:
#
#   wget -qO- https://raw.githubusercontent.com/dllfpp/tether/main/get.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/dllfpp/tether/main/get.sh | sh
#
# Fetches (or updates) the repository in /opt/tether-src and starts the
# interactive wizard (install.sh). Run it as root, on the Proxmox VE host or
# inside the machine where Claude Code runs. Extra arguments go to the wizard:
#   ... | sh -s -- --yes
set -eu

REPO=${TETHER_REPO:-https://github.com/dllfpp/tether.git}
DIR=${TETHER_SRC:-/opt/tether-src}

[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }

if ! command -v git >/dev/null 2>&1; then
    if command -v apk >/dev/null 2>&1; then apk add -q --no-cache git
    elif command -v apt-get >/dev/null 2>&1; then apt-get update -q && apt-get install -yq git
    else echo "Install git first." >&2; exit 1
    fi
fi

if [ -d "$DIR/.git" ]; then
    git -C "$DIR" pull -q --ff-only
else
    rm -rf "$DIR"
    git clone -q --depth 1 "$REPO" "$DIR"
fi

# The script itself arrives on stdin: the wizard reads its answers from the terminal.
if [ -e /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
    exec sh "$DIR/install.sh" "$@" </dev/tty
fi
exec sh "$DIR/install.sh" "$@"
