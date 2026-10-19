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

# The environment this installer was tested on. Anything else gets a warning
# and a chance to stop before a single change is made.
TESTED_OS="alpine 3.24"
TESTED_VIRT=lxc
TESTED_INIT=openrc
TESTED_ARCH=x86_64
TESTED_CLAUDE=2.1.303
TESTED_PVE=9.0.10
LOG=/var/log/tether-install.log

# ------------------------------------------------------------------- look
# Same look as the Proxmox VE community scripts: a banner, then one line per
# step with a spinner while it runs and a check mark when it is done.
if [ -t 1 ]; then
    YW=$(printf '\033[33m'); GN=$(printf '\033[1;92m'); RD=$(printf '\033[01;31m')
    BL=$(printf '\033[36m'); BGN=$(printf '\033[4;92m'); DGN=$(printf '\033[32m')
    CL=$(printf '\033[m'); BOLD=$(printf '\033[1m')
else
    YW= GN= RD= BL= BGN= DGN= CL= BOLD=
fi
CM="${GN}✔️ ${CL}"; CROSS="${RD}✖️ ${CL}"; INFO="${BL}💡${CL}"; WARN="${YW}⚠️ ${CL}"
SPIN_PID=

header() {
    clear 2>/dev/null || true
    cat <<EOF
${BL}  ______     __  __
 /_  __/__  / /_/ /_  ___  _____
  / / / _ \/ __/ __ \/ _ \/ ___/
 / / /  __/ /_/ / / /  __/ /
/_/  \___/\__/_/ /_/\___/_/${CL}

  ${BOLD}A web UI over every Claude Code chat, background jobs included${CL}
  ${DGN}github.com/dllfpp/tether${CL}

EOF
}

spin_stop() {
    [ -n "$SPIN_PID" ] && kill "$SPIN_PID" 2>/dev/null && wait "$SPIN_PID" 2>/dev/null
    SPIN_PID=
    return 0
}
trap spin_stop EXIT INT TERM

msg_info() {
    spin_stop
    if [ -t 1 ]; then
        ( while :; do for c in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do
            printf '\r   %s %s%s...%s ' "$c" "$YW" "$1" "$CL"; sleep 0.1
          done; done ) &
        SPIN_PID=$!
    else
        printf '   ⏳ %s...\n' "$1"
    fi
}
msg_ok()    { spin_stop; printf '\r\033[K   %s %s%s%s\n' "$CM" "$GN" "$1" "$CL"; }
msg_warn()  { spin_stop; printf '\r\033[K   %s %s%s%s\n' "$WARN" "$YW" "$1" "$CL"; }
msg_error() { spin_stop; printf '\r\033[K   %s %s%s%s\n' "$CROSS" "$RD" "$1" "$CL" >&2; }
die()       { msg_error "$1"; exit 1; }
# Kept for the few plain notes between steps.
say()       { spin_stop; printf '   %s %s\n' "$INFO" "$1"; }

# run "Label" command... : spinner while it runs, output only in $LOG, and
# the last lines of the log if it fails.
run() {
    label=$1; shift
    msg_info "$label"
    if "$@" >>"$LOG" 2>&1; then msg_ok "$label"
    else
        msg_error "$label failed. Last lines of $LOG:"
        tail -15 "$LOG" | sed 's/^/      /' >&2
        exit 1
    fi
}

# compat: "Name|tested|found" lines; prints a warning box for the differences
# and asks before going on. Nothing has been changed when this runs.
check_compat() {
    diffs=$(printf '%s\n' "$@" | awk -F'|' '$2 != $3')
    if [ -z "$diffs" ]; then
        msg_ok "Environment matches the tested one"
        return 0
    fi
    printf '\n   %s%s╭─ Untested environment ─────────────────────────────────╮%s\n' "$YW" "$BOLD" "$CL"
    printf '%s\n' "$diffs" | while IFS='|' read -r name tested found; do
        printf '   %s│%s %-14s tested: %-14s here: %s%s%s\n' "$YW" "$CL" "$name" "$tested" "$YW" "${found:-unknown}" "$CL"
    done
    printf '   %s╰────────────────────────────────────────────────────────╯%s\n' "$YW" "$CL"
    printf '   Tether may still work, but this combination was never tested.\n\n'
    if [ "$ASSUME_YES" = 1 ]; then
        msg_warn "Continuing on an untested environment (--yes)"
        return 0
    fi
    confirm "Continue anyway?" n || die "Stopped before changing anything."
}

# ask VAR "Question" default — keeps the saved/default value on empty input.
ask() {
    eval "cur=\${$1:-$3}"
    if [ "$ASSUME_YES" = 1 ]; then eval "$1=\$cur"; return; fi
    printf '   %s❓%s %s %s[%s]%s: ' "$BL" "$CL" "$2" "$DGN" "$cur" "$CL"
    read -r ans || ans=
    eval "$1=\${ans:-\$cur}"
}

# confirm "Question" y|n — returns 0 for yes.
confirm() {
    if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
    hint='y/N'; [ "$2" = y ] && hint='Y/n'
    printf '   %s❓%s %s %s[%s]%s: ' "$BL" "$CL" "$1" "$DGN" "$hint" "$CL"
    read -r ans || ans=
    case "${ans:-$2}" in [yY]*) return 0 ;; *) return 1 ;; esac
}

detect_env() {
    OS_FOUND=$(. /etc/os-release 2>/dev/null; echo "${ID:-unknown} ${VERSION_ID:-}" | cut -d. -f1-2)
    if grep -qa 'container=lxc' /proc/1/environ 2>/dev/null; then VIRT_FOUND=lxc
    elif grep -qa 'container=' /proc/1/environ 2>/dev/null || [ -f /.dockerenv ]; then VIRT_FOUND=container
    elif grep -qiE 'qemu|kvm|vmware|virtualbox' /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null; then VIRT_FOUND=vm
    else VIRT_FOUND=bare-metal
    fi
    ARCH_FOUND=$(uname -m)
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
    msg_ok "Service removed. Kept: the install directory (with its data/) and $CONF_DIR"
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
    header
    PVE_FOUND=$(pveversion 2>/dev/null | sed -n 's|^pve-manager/\([0-9.]*\).*|\1|p')
    msg_ok "Proxmox VE ${PVE_FOUND:-?} host detected"
    check_compat "Proxmox VE|$TESTED_PVE|$PVE_FOUND"
    msg_info "Looking for running containers that use Claude Code"
    choices=
    i=0
    for id in $(pct list | awk 'NR > 1 && $2 == "running" { print $1 }'); do
        found=$(pct exec "$id" -- sh -c "$PROBE" 2>/dev/null) || continue
        [ -n "$found" ] || continue
        i=$((i + 1))
        name=$(pct config "$id" | sed -n 's/^hostname: //p')
        choices="$choices$i:$id
"
        [ "$i" = 1 ] && { spin_stop; printf '\r\033[K'; }
        printf '   %s%s)%s CT %s%s%s  %s  %susers: %s%s\n' "$GN" "$i" "$CL" "$BOLD" "$id" "$CL" "$name" "$DGN" "$found" "$CL"
    done
    [ "$i" -gt 0 ] || die "No running container has Claude Code. Install and log in to Claude Code in one first."
    echo
    pick=1
    if [ "$i" -gt 1 ] || [ "$ASSUME_YES" = 0 ]; then
        printf 'Link Tether to which Claude Code? [1-%s]: ' "$i"
        read -r pick || pick=
    fi
    CTID=$(printf '%s' "$choices" | sed -n "s/^${pick:-x}:\(.*\)$/\1/p")
    [ -n "$CTID" ] || die "Invalid choice."

    msg_info "Copying Tether into CT $CTID (/opt/tether-src)"
    tgz=$(mktemp)
    tar -C "$SRC" --exclude=./node_modules --exclude=./.git --exclude=./dist \
        --exclude=./dist-server --exclude=./.claude -czf "$tgz" .
    pct exec "$CTID" -- sh -c 'rm -rf /opt/tether-src && mkdir -p /opt/tether-src'
    pct push "$CTID" "$tgz" /opt/tether-src.tgz
    rm -f "$tgz"
    pct exec "$CTID" -- sh -c 'tar -xzf /opt/tether-src.tgz -C /opt/tether-src && rm /opt/tether-src.tgz'
    msg_ok "Copied Tether into CT $CTID"
    exec pct exec "$CTID" -- sh /opt/tether-src/install.sh "$@"
fi

[ "$UNINSTALL" = 1 ] && uninstall
detect_init
detect_env
header
: >>"$LOG"

# ---------------------------------------------------------------- answers
[ -f "$CONF" ] && . "$CONF" && msg_ok "Reusing the answers saved in $CONF"

# Default: the account that already uses Claude Code, the one with most projects.
found=$(sh -c "$PROBE")
[ -n "$found" ] || die "No Claude Code here: no ~/.claude with the claude CLI. Tether links to an existing Claude Code; install and log in to it first (or run this wizard on the Proxmox host to pick a container)."
msg_ok "Claude Code found for: $found"
best=$(printf '%s' "$found" | sed 's/) /)\n/g' | sed -n 's/^\([^ ]*\) (\([0-9]*\) projects)$/\2 \1/p' | sort -rn | head -1 | cut -d' ' -f2)
ask RUN_USER   "User whose Claude Code Tether links to" "${best:-$(id -un)}"
RUN_HOME=$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6 || true)
[ -n "$RUN_HOME" ] || die "User $RUN_USER does not exist."
ask INSTALL_DIR "Install directory" /opt/tether
ask PORT        "Port" 3010
ask BIND_HOST   "Listen address (0.0.0.0 = whole network, 127.0.0.1 = this machine only)" 0.0.0.0
ask TRUST_PROXY "IP of your reverse proxy, if any (empty = none)" ""

# Claude Code: the native installer puts it in ~/.local/bin.
CLAUDE_BIN=${CLAUDE_BIN:-}
for c in "$CLAUDE_BIN" "$RUN_HOME/.local/bin/claude" "$(command -v claude 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { CLAUDE_BIN=$c; break; }
done
[ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || die "The claude CLI of $RUN_USER was not found. Tether does not install Claude Code: it links to the one you use."
[ -d "$RUN_HOME/.claude" ] || die "$RUN_USER has never used Claude Code ($RUN_HOME/.claude is missing)."
ask CLAUDE_BIN "Path of the claude CLI" "$CLAUDE_BIN"
CLAUDE_FOUND=$("$CLAUDE_BIN" --version 2>/dev/null | head -1 | cut -d' ' -f1)
check_compat \
    "System|$TESTED_OS|$OS_FOUND" \
    "Runs in|$TESTED_VIRT|$VIRT_FOUND" \
    "Init|$TESTED_INIT|$INIT" \
    "Architecture|$TESTED_ARCH|$ARCH_FOUND" \
    "Claude Code|$TESTED_CLAUDE|$CLAUDE_FOUND"

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
        apk) run "Installing dependencies" apk add --no-cache nodejs npm git python3 make g++ linux-headers bash curl ;;
        apt) run "Updating package lists" apt-get update -q
             run "Installing dependencies" apt-get install -yq git python3 make g++ curl ca-certificates
             if ! command -v node >/dev/null 2>&1; then
                 run "Adding the Node.js 22 repository" sh -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
                 run "Installing Node.js" apt-get install -yq nodejs
             fi ;;
        *) die "No supported package manager: install the dependencies by hand." ;;
    esac
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))."
msg_ok "Node.js $(node -v)"


# ------------------------------------------------------------ login token
# Tether starts its own claude processes. A long-lived token of their own
# keeps them from racing your terminal sessions over the shared login.
mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
if [ -s "$TOKEN_FILE" ]; then
    msg_ok "Claude token already saved in $TOKEN_FILE"
elif [ "$ASSUME_YES" = 0 ] && confirm "Save a dedicated Claude login token? (recommended; create it with 'claude setup-token')" y; then
    say "Run 'claude setup-token' in another terminal as $RUN_USER, then paste the token here."
    printf '   %s🔑%s Token %s(hidden, empty to skip)%s: ' "$BL" "$CL" "$DGN" "$CL"
    stty -echo 2>/dev/null || true
    read -r token || token=
    stty echo 2>/dev/null || true
    echo
    if [ -n "$token" ]; then
        umask 077 && printf '%s\n' "$token" > "$TOKEN_FILE"
        chown "$RUN_USER" "$TOKEN_FILE"
        msg_ok "Token saved in $TOKEN_FILE (mode 600)"
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
        msg_ok "Claude Code daemon already kept up by $own: left as it is"
    else
        confirm "Run the Claude Code daemon as a service, so background jobs survive a reboot?" y && MANAGE_DAEMON=y
    fi
fi

printf '\n   %sSettings%s\n' "$BOLD" "$CL"
printf '   🖥️  %-16s %s%s%s\n' "System" "$BGN" "$OS_FOUND ($VIRT_FOUND, $INIT)" "$CL"
printf '   🤖 %-16s %s%s%s\n' "Claude Code" "$BGN" "$CLAUDE_FOUND ($CLAUDE_BIN)" "$CL"
printf '   👤 %-16s %s%s%s\n' "User" "$BGN" "$RUN_USER" "$CL"
printf '   📁 %-16s %s%s%s\n' "Install dir" "$BGN" "$INSTALL_DIR" "$CL"
printf '   🔌 %-16s %s%s%s\n' "Port" "$BGN" "$PORT" "$CL"
printf '   🌐 %-16s %s%s%s\n' "Listen" "$BGN" "$BIND_HOST" "$CL"
[ -n "$TRUST_PROXY" ] && printf '   🔀 %-16s %s%s%s\n' "Reverse proxy" "$BGN" "$TRUST_PROXY" "$CL"
printf '   ⚙️  %-16s %s%s%s\n\n' "Daemon service" "$BGN" "$([ "$MANAGE_DAEMON" = y ] && echo "installed by Tether" || echo "yours, left as it is")" "$CL"

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
cd "$SRC"
run "Installing npm packages" npm ci --no-audit --no-fund
# The production build needs more than Node's default heap.
run "Building Tether (a few minutes)" env NODE_OPTIONS=--max-old-space-size=3072 npm run build

# node-pty ships glibc prebuilds only: on musl (Alpine) they crash the server
# at the first terminal or job delivery, so build it locally there.
if ldd --version 2>&1 | grep -qi musl; then
    run "Building node-pty for musl" sh -c 'cd node_modules/node-pty && npx --yes node-gyp rebuild'
fi

# ---------------------------------------------------------------- install
service_stop
mkdir -p "$INSTALL_DIR/data"
run "Copying Tether to $INSTALL_DIR" sh -c "tar -C '$SRC' --exclude=./.git --exclude=./.claude --exclude=./data \
    --exclude=./database --exclude=./.env -cf - . | tar -C '$INSTALL_DIR' -xf -"

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
msg_info "Installing the $SERVICE service"

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
        rc-service claude-daemon restart >>"$LOG" 2>&1 || rc-service claude-daemon start >>"$LOG" 2>&1
    fi
    rc-update add "$SERVICE" default >/dev/null 2>&1 || true
    rc-service "$SERVICE" restart >>"$LOG" 2>&1 || rc-service "$SERVICE" start >>"$LOG" 2>&1
else
    for unit in tether claude-daemon; do
        [ "$unit" = claude-daemon ] && [ "$MANAGE_DAEMON" != y ] && continue
        sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" -e "s|@RUN_USER@|$RUN_USER|g" \
            -e "s|@RUN_HOME@|$RUN_HOME|g" -e "s|@PATH@|$PATH_LINE|g" \
            -e "s|@CLAUDE_BIN@|$CLAUDE_BIN|g" -e "s|@TOKEN_FILE@|$TOKEN_FILE|g" \
            "$SRC/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
    done
    systemctl daemon-reload
    if [ "$MANAGE_DAEMON" = y ]; then
        systemctl enable claude-daemon >>"$LOG" 2>&1 && systemctl restart claude-daemon
    fi
    systemctl enable "$SERVICE" >>"$LOG" 2>&1
    systemctl restart "$SERVICE"
fi
msg_ok "Installed and started the $SERVICE service"

# ------------------------------------------------------------------ check
msg_info "Waiting for Tether to answer on port $PORT"
i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null \
   || wget -q -O /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && die "No answer after 60 s. Check the log: /var/log/$SERVICE.log or journalctl -u $SERVICE"
    sleep 2
done
msg_ok "Tether answers on port $PORT"

# The address other machines reach, not the 127.0.1.1 of /etc/hosts.
ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
cat <<EOF

   ${CM} ${GN}Completed successfully!${CL}

   ${INFO} ${YW}Tether is reachable at:${CL}
      ${BGN}http://${ip:-<this-host>}:$PORT${CL}

   Open it and create the admin account (first visit only).

   🔄 Update:  sh /opt/tether-src/get.sh --yes
               (where you started the installer: Proxmox host or here)
   🗑️  Remove:  sh /opt/tether-src/install.sh --uninstall
   📄 Log:     $LOG

   ${WARN}${YW}Tether runs commands as '$RUN_USER'. Keep it on your LAN or VPN;
      never expose it to the Internet without HTTPS in front of it.${CL}

EOF
