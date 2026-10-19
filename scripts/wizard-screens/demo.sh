#!/bin/sh
# Prints the wizard screens used in the README, with invented demo data,
# through the real helpers of install.sh. Usage: sh demo.sh host|done|warn
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# The look of install.sh, colors forced on (the output is not a terminal).
eval "$(awk '/^# -+ look/{on=1} on{print} on && /^check_compat\(\) \{/{c=1} c && /^}/{exit}' "$HERE/../../install.sh" \
    | sed 's/^if \[ -t 1 \]; then/if true; then/; s/^    clear .*//')"
ASSUME_YES=0
SPIN_PID=
msg_info() { :; }
confirm() { printf '   %s❓%s %s %s[%s]%s: %s\n' "$BL" "$CL" "$1" "$DGN" "y/N" "$CL" "${ANSWER:-}"; [ "${ANSWER:-n}" = y ]; }
q() { printf '   %s❓%s %s %s[%s]%s: %s\n' "$BL" "$CL" "$1" "$DGN" "$2" "$CL" "${3:-}"; }

case "${1:-}" in
host)
    header
    msg_ok "Proxmox VE 9.2.21 host detected"
    check_compat "Proxmox VE|9.2.21|9.2.21"
    printf '   %s1)%s CT %s201%s  claude   %susers: root (24 projects)%s\n' "$GN" "$CL" "$BOLD" "$CL" "$DGN" "$CL"
    printf '   %s2)%s CT %s202%s  dev-box  %susers: dev (3 projects)%s\n' "$GN" "$CL" "$BOLD" "$CL" "$DGN" "$CL"
    echo
    q "Link Tether to which Claude Code?" "1-2" 1
    msg_ok "Copied Tether into CT 201"
    ;;
done)
    echo
    msg_ok "Claude Code found for: root (24 projects)"
    check_compat "System|alpine 3.24|alpine 3.24"
    q "User whose Claude Code Tether links to" root
    q "Install directory" /opt/tether
    q "Port" 3010
    q "Listen address (0.0.0.0 = whole network, 127.0.0.1 = this machine only)" 0.0.0.0
    q "IP of your reverse proxy, if any (empty = none)" ""
    q "Path of the claude CLI" /root/.local/bin/claude
    q "Save a dedicated Claude login token? (recommended; create it with 'claude setup-token')" "Y/n" n
    q "Run the Claude Code daemon as a service, so background jobs survive a reboot?" "Y/n"
    msg_ok "Node.js v24.18.1"
    printf '\n   %sSettings%s\n' "$BOLD" "$CL"
    printf '   🖥️  %-16s %s%s%s\n' "System" "$BGN" "alpine 3.24 (lxc, openrc)" "$CL"
    printf '   🤖 %-16s %s%s%s\n' "Claude Code" "$BGN" "2.1.303 (/root/.local/bin/claude)" "$CL"
    printf '   👤 %-16s %s%s%s\n' "User" "$BGN" "root" "$CL"
    printf '   📁 %-16s %s%s%s\n' "Install dir" "$BGN" "/opt/tether" "$CL"
    printf '   🔌 %-16s %s%s%s\n' "Port" "$BGN" "3010" "$CL"
    printf '   🌐 %-16s %s%s%s\n' "Listen" "$BGN" "0.0.0.0" "$CL"
    printf '   ⚙️  %-16s %s%s%s\n\n' "Daemon service" "$BGN" "installed by Tether" "$CL"
    for step in "Installing npm packages" "Building Tether (a few minutes)" "Building node-pty for musl" \
        "Copying Tether to /opt/tether" "Installed and started the tether service" "Tether answers on port 3010"; do
        msg_ok "$step"
    done
    cat <<EOT

   ${CM} ${GN}Completed successfully!${CL}

   ${INFO} ${YW}Tether is reachable at:${CL}
      ${BGN}http://192.168.1.50:3010${CL}

   Open it and create the admin account (first visit only).
EOT
    ;;
warn)
    header
    msg_ok "Claude Code found for: dev (3 projects)"
    ANSWER=n
    check_compat \
        "System|alpine 3.24|debian 12" \
        "Runs in|lxc|vm" \
        "Init|openrc|systemd" \
        "Architecture|x86_64|x86_64" \
        "Claude Code|2.1.303|2.1.310" || true
    ;;
*) echo "usage: sh demo.sh host|done|warn" >&2; exit 1 ;;
esac
