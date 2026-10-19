#!/bin/sh
# Tether installer: an interactive wizard for the machine (or LXC container)
# where Claude Code and its background daemon run.
#
#   wget -qO- https://raw.githubusercontent.com/dllfpp/tether/main/get.sh | sh
#
#   sh install.sh               install or update (asks a few questions)
#   sh install.sh --yes         same, accepting every default / saved answer
#   sh install.sh --uninstall   remove the service (data and config are kept)
#
# Tether links to a Claude Code you already use; it never installs a new one.
# Run it as root from a checkout of this repository, either
#   - on the Proxmox VE host: it lists the running containers that have
#     Claude Code, you pick one, and Tether is installed inside it; or
#   - inside the machine or container where Claude Code runs.
# Supported guests: Alpine (OpenRC) and Debian/Ubuntu (systemd). Re-running it
# updates an existing install and reuses the answers in /etc/tether/install.conf.
set -eu

SRC=$(cd "$(dirname "$0")" && pwd)
CONF_DIR=/etc/tether
CONF="$CONF_DIR/install.conf"
TOKEN_FILE="$CONF_DIR/oauth-token"
SERVICE=tether
ASSUME_YES=0
UNINSTALL=0

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ask VAR "Question" default — keeps the saved/default value on empty input.
ask() {
    eval "cur=\${$1:-$3}"
    if [ "$ASSUME_YES" = 1 ]; then eval "$1=\$cur"; return; fi
    printf '%s [%s]: ' "$2" "$cur"
    read -r ans || ans=
    eval "$1=\${ans:-\$cur}"
}

# confirm "Question" y|n — returns 0 for yes.
confirm() {
    if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
    hint='y/N'; [ "$2" = y ] && hint='Y/n'
    printf '%s [%s]: ' "$1" "$hint"
    read -r ans || ans=
    case "${ans:-$2}" in [yY]*) return 0 ;; *) return 1 ;; esac
}

detect_init() {
    if command -v openrc-run >/dev/null 2>&1; then INIT=openrc
    elif command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then INIT=systemd
    else die "Neither OpenRC nor systemd found."
    fi
    if command -v apk >/dev/null 2>&1; then PKG=apk
    elif command -v apt-get >/dev/null 2>&1; then PKG=apt
    else PKG=none
    fi
}

service_stop() {
    if [ "$INIT" = openrc ]; then rc-service "$SERVICE" stop >/dev/null 2>&1 || true
    else systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    fi
}

uninstall() {
    detect_init
    service_stop
    if [ "$INIT" = openrc ]; then
        rc-update del "$SERVICE" default >/dev/null 2>&1 || true
        rm -f "/etc/init.d/$SERVICE"
    else
        systemctl disable "$SERVICE" >/dev/null 2>&1 || true
        rm -f "/etc/systemd/system/$SERVICE.service"
        systemctl daemon-reload
    fi
    say "Service removed. Kept: the install directory (with its data/) and $CONF_DIR."
    exit 0
}

case "${1:-}" in
    --yes|-y) ASSUME_YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    '') ;;
    *) die "Unknown option: $1 (use --yes or --uninstall)" ;;
esac

[ "$(id -u)" = 0 ] || die "Run as root (the service is installed system-wide)."
[ -f "$SRC/package.json" ] || die "Run this script from the Tether checkout."

# Prints "user (N projects)" for every account in this machine that has used
# Claude Code: a ~/.claude folder and the claude CLI. Runs inside a container.
PROBE='for h in /root /home/*; do
    [ -d "$h/.claude" ] || continue
    [ -x "$h/.local/bin/claude" ] || command -v claude >/dev/null 2>&1 || continue
    n=$(ls "$h/.claude/projects" 2>/dev/null | wc -l)
    printf "%s (%s projects) " "$(stat -c %U "$h")" "$n"
done'

# On the Proxmox host: pick the container whose Claude Code Tether links to,
# copy this checkout into it and run the wizard there.
if [ -d /etc/pve ] && command -v pct >/dev/null 2>&1; then
    say "Proxmox host: looking for running containers that use Claude Code..."
    choices=
    i=0
    for id in $(pct list | awk 'NR > 1 && $2 == "running" { print $1 }'); do
        found=$(pct exec "$id" -- sh -c "$PROBE" 2>/dev/null) || continue
        [ -n "$found" ] || continue
        i=$((i + 1))
        name=$(pct config "$id" | sed -n 's/^hostname: //p')
        choices="$choices$i:$id
"
        printf '  %s) CT %s  %s  users: %s\n' "$i" "$id" "$name" "$found"
    done
    [ "$i" -gt 0 ] || die "No running container has Claude Code. Install and log in to Claude Code in one first."
    pick=1
    if [ "$i" -gt 1 ] || [ "$ASSUME_YES" = 0 ]; then
        printf 'Link Tether to which Claude Code? [1-%s]: ' "$i"
        read -r pick || pick=
    fi
    CTID=$(printf '%s' "$choices" | sed -n "s/^${pick:-x}:\(.*\)$/\1/p")
    [ -n "$CTID" ] || die "Invalid choice."

    say "Copying Tether into CT $CTID (/opt/tether-src)..."
    tgz=$(mktemp)
    tar -C "$SRC" --exclude=./node_modules --exclude=./.git --exclude=./dist \
        --exclude=./dist-server --exclude=./.claude -czf "$tgz" .
    pct exec "$CTID" -- sh -c 'rm -rf /opt/tether-src && mkdir -p /opt/tether-src'
    pct push "$CTID" "$tgz" /opt/tether-src.tgz
    rm -f "$tgz"
    pct exec "$CTID" -- sh -c 'tar -xzf /opt/tether-src.tgz -C /opt/tether-src && rm /opt/tether-src.tgz'
    say "Running the wizard inside CT $CTID..."
    exec pct exec "$CTID" -- sh /opt/tether-src/install.sh "$@"
fi

[ "$UNINSTALL" = 1 ] && uninstall
detect_init

cat <<'EOF'

  Tether: a web UI over every Claude Code chat on this machine,
  background jobs included. This wizard installs it as a service.

EOF

# ---------------------------------------------------------------- answers
[ -f "$CONF" ] && . "$CONF" && say "Reusing the answers saved in $CONF"

# Default: the account that already uses Claude Code, the one with most projects.
found=$(sh -c "$PROBE")
[ -n "$found" ] || die "No Claude Code here: no ~/.claude with the claude CLI. Tether links to an existing Claude Code; install and log in to it first (or run this wizard on the Proxmox host to pick a container)."
say "Claude Code found for: $found"
best=$(printf '%s' "$found" | sed 's/) /)\n/g' | sed -n 's/^\([^ ]*\) (\([0-9]*\) projects)$/\2 \1/p' | sort -rn | head -1 | cut -d' ' -f2)
ask RUN_USER   "User whose Claude Code Tether links to" "${best:-$(id -un)}"
RUN_HOME=$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6 || true)
[ -n "$RUN_HOME" ] || die "User $RUN_USER does not exist."
ask INSTALL_DIR "Install directory" /opt/tether
ask PORT        "Port" 3010
ask BIND_HOST   "Listen address (0.0.0.0 = whole network, 127.0.0.1 = this machine only)" 0.0.0.0
ask TRUST_PROXY "IP of your reverse proxy, if any (empty = none)" ""

# ---------------------------------------------------------- dependencies
need_pkgs=
command -v node >/dev/null 2>&1 || need_pkgs="$need_pkgs node"
command -v git  >/dev/null 2>&1 || need_pkgs="$need_pkgs git"
command -v make >/dev/null 2>&1 || need_pkgs="$need_pkgs build"
command -v python3 >/dev/null 2>&1 || need_pkgs="$need_pkgs python3"
if [ -n "$need_pkgs" ]; then
    say "Missing:$need_pkgs"
    confirm "Install them with $PKG?" y || die "Install Node.js 22+, npm, git, python3 and a C++ toolchain, then re-run."
    case "$PKG" in
        apk) apk add --no-cache nodejs npm git python3 make g++ linux-headers bash curl ;;
        apt) apt-get update -q && apt-get install -yq git python3 make g++ curl ca-certificates
             if ! command -v node >/dev/null 2>&1; then
                 curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -yq nodejs
             fi ;;
        *) die "No supported package manager: install the dependencies by hand." ;;
    esac
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))."

# Claude Code: the native installer puts it in ~/.local/bin.
CLAUDE_BIN=${CLAUDE_BIN:-}
for c in "$CLAUDE_BIN" "$RUN_HOME/.local/bin/claude" "$(command -v claude 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { CLAUDE_BIN=$c; break; }
done
[ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || die "The claude CLI of $RUN_USER was not found. Tether does not install Claude Code: it links to the one you use."
[ -d "$RUN_HOME/.claude" ] || die "$RUN_USER has never used Claude Code ($RUN_HOME/.claude is missing)."
ask CLAUDE_BIN "Path of the claude CLI" "$CLAUDE_BIN"
say "Claude Code $("$CLAUDE_BIN" --version 2>/dev/null | head -1)"

# ------------------------------------------------------------ login token
# Tether starts its own claude processes. A long-lived token of their own
# keeps them from racing your terminal sessions over the shared login.
mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
if [ -s "$TOKEN_FILE" ]; then
    say "Claude token: already saved in $TOKEN_FILE"
elif [ "$ASSUME_YES" = 0 ] && confirm "Save a dedicated Claude login token? (recommended; create it with 'claude setup-token')" y; then
    echo "Run 'claude setup-token' in another terminal as $RUN_USER, then paste the token here."
    printf 'Token (hidden, empty to skip): '
    stty -echo 2>/dev/null || true
    read -r token || token=
    stty echo 2>/dev/null || true
    echo
    if [ -n "$token" ]; then
        umask 077 && printf '%s\n' "$token" > "$TOKEN_FILE"
        chown "$RUN_USER" "$TOKEN_FILE"
        say "Token saved in $TOKEN_FILE (mode 600)"
    fi
    unset token
fi

# ------------------------------------------------------------ claude daemon
# Background jobs (`claude --bg`, `claude agents`) live in the Claude Code
# daemon. Tether reads and drives them, so the daemon must stay up.
# A service of yours that already keeps it up is left alone: two would fight
# over the same socket.
if [ "${MANAGE_DAEMON:-}" = "" ]; then
    MANAGE_DAEMON=n
    own=
    for f in /etc/init.d/* /etc/systemd/system/*.service; do
        case "$f" in */claude-daemon|*/claude-daemon.service|*/tether|*/tether.service) continue ;; esac
        grep -qE 'daemon run|--bg|claude-daemon-run' "$f" 2>/dev/null && grep -q claude "$f" && { own=$f; break; }
    done
    if [ -n "$own" ]; then
        say "Claude Code daemon already kept up by $own: left as it is."
    else
        confirm "Run the Claude Code daemon as a service, so background jobs survive a reboot?" y && MANAGE_DAEMON=y
    fi
fi

umask 077
cat > "$CONF" <<EOF
RUN_USER='$RUN_USER'
INSTALL_DIR='$INSTALL_DIR'
PORT='$PORT'
BIND_HOST='$BIND_HOST'
TRUST_PROXY='$TRUST_PROXY'
CLAUDE_BIN='$CLAUDE_BIN'
MANAGE_DAEMON='$MANAGE_DAEMON'
EOF
umask 022

# ------------------------------------------------------------------ build
say "Installing npm packages and building (a few minutes)..."
cd "$SRC"
npm ci --no-audit --no-fund
# The production build needs more than Node's default heap.
NODE_OPTIONS=--max-old-space-size=3072 npm run build

# node-pty ships glibc prebuilds only: on musl (Alpine) they crash the server
# at the first terminal or job delivery, so build it locally there.
if ldd --version 2>&1 | grep -qi musl; then
    say "Building node-pty for musl..."
    (cd node_modules/node-pty && npx --yes node-gyp rebuild >/tmp/tether-node-pty.log 2>&1) \
        || { tail -20 /tmp/tether-node-pty.log >&2; die "node-pty build failed (log: /tmp/tether-node-pty.log)"; }
fi

# ---------------------------------------------------------------- install
service_stop
mkdir -p "$INSTALL_DIR/data"
tar -C "$SRC" --exclude=./.git --exclude=./.claude --exclude=./data \
    --exclude=./database --exclude=./.env -cf - . | tar -C "$INSTALL_DIR" -xf -

ENV_FILE="$INSTALL_DIR/.env"
umask 077
{
    echo "# Written by install.sh; re-run it to change these values."
    echo "SERVER_PORT=$PORT"
    echo "HOST=$BIND_HOST"
    echo "DATABASE_PATH=$INSTALL_DIR/data/auth.db"
    echo "CLAUDE_CLI_PATH=$CLAUDE_BIN"
    [ -n "$TRUST_PROXY" ] && echo "TRUST_PROXY=$TRUST_PROXY"
    # Keep settings you added by hand.
    [ -f "$ENV_FILE" ] && grep -vE '^(#|SERVER_PORT=|HOST=|DATABASE_PATH=|CLAUDE_CLI_PATH=|TRUST_PROXY=)' "$ENV_FILE" || true
} > "$ENV_FILE.new"
mv "$ENV_FILE.new" "$ENV_FILE"
umask 022
chown -R "$RUN_USER" "$INSTALL_DIR/data" "$ENV_FILE"

PATH_LINE="$(dirname "$CLAUDE_BIN"):$RUN_HOME/.local/bin:/usr/local/bin"

if [ "$INIT" = openrc ]; then
    sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" -e "s|@RUN_USER@|$RUN_USER|g" \
        -e "s|@RUN_HOME@|$RUN_HOME|g" -e "s|@PATH@|$PATH_LINE|g" \
        -e "s|@TOKEN_FILE@|$TOKEN_FILE|g" "$SRC/deploy/tether.openrc" > "/etc/init.d/$SERVICE"
    chmod 755 "/etc/init.d/$SERVICE"
    if [ "$MANAGE_DAEMON" = y ]; then
        sed -e "s|@CLAUDE_BIN@|$CLAUDE_BIN|g" -e "s|@RUN_USER@|$RUN_USER|g" \
            -e "s|@RUN_HOME@|$RUN_HOME|g" -e "s|@TOKEN_FILE@|$TOKEN_FILE|g" \
            "$SRC/deploy/claude-daemon.openrc" > /etc/init.d/claude-daemon
        chmod 755 /etc/init.d/claude-daemon
        rc-update add claude-daemon default >/dev/null 2>&1 || true
        rc-service claude-daemon restart >/dev/null 2>&1 || rc-service claude-daemon start
    fi
    rc-update add "$SERVICE" default >/dev/null 2>&1 || true
    rc-service "$SERVICE" start
else
    for unit in tether claude-daemon; do
        [ "$unit" = claude-daemon ] && [ "$MANAGE_DAEMON" != y ] && continue
        sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" -e "s|@RUN_USER@|$RUN_USER|g" \
            -e "s|@RUN_HOME@|$RUN_HOME|g" -e "s|@PATH@|$PATH_LINE|g" \
            -e "s|@CLAUDE_BIN@|$CLAUDE_BIN|g" -e "s|@TOKEN_FILE@|$TOKEN_FILE|g" \
            "$SRC/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
    done
    systemctl daemon-reload
    [ "$MANAGE_DAEMON" = y ] && systemctl enable --now claude-daemon && systemctl restart claude-daemon
    systemctl enable "$SERVICE" >/dev/null
    systemctl restart "$SERVICE"
fi

# ------------------------------------------------------------------ check
say "Waiting for Tether to answer on port $PORT..."
i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null \
   || wget -q -O /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && die "No answer after 60 s. Check the log: /var/log/$SERVICE.log or journalctl -u $SERVICE"
    sleep 2
done

# The address other machines reach, not the 127.0.1.1 of /etc/hosts.
ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
cat <<EOF

  Tether is running: http://${ip:-<this-host>}:$PORT

  1. Open it and create the admin account (first visit only).
  2. Your Claude Code chats appear in the sidebar, background jobs included.

  Update later:  sh /opt/tether-src/get.sh --yes
                 (where you started the installer: Proxmox host or here)
  Remove:        sh /opt/tether-src/install.sh --uninstall

  Security: Tether runs commands as '$RUN_USER'. Keep it on your LAN or VPN;
  never expose it to the Internet without HTTPS in front of it.

EOF
