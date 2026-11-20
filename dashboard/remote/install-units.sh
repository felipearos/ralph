#!/usr/bin/env bash
# Install the dashboard and bridge as systemd user units (felipearos/ralph#170).
#
# Copies the unit files beside this script into the user's unit directory
# (`${XDG_CONFIG_HOME:-~/.config}/systemd/user`), reloads the user manager, and
# prints the commands that enable them. It never enables, starts or lingers
# anything itself: that is the operator's step, once, at go-live.
#
# Copies rather than symlinks: a symlink into the checkout this ran from would
# tie the live units to a worktree that may later be removed. Rerun it after a
# pull that changes a unit file; a rerun with nothing changed changes nothing.
#
# Usage: dashboard/remote/install-units.sh [--dashboard-only]
#   --dashboard-only   install ralph-dashboard.service alone (before the bridge exists)
set -euo pipefail

usage() { sed -n '13,14s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

units=(ralph-dashboard.service ralph-bridge.service)
for arg in "$@"; do
  case "$arg" in
    --dashboard-only) units=(ralph-dashboard.service) ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-units: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/systemd" && pwd -P)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$DEST"
for unit in "${units[@]}"; do
  if cmp -s "$SRC/$unit" "$DEST/$unit"; then
    echo "install-units: $unit unchanged"
  else
    # Through a temp file in the same directory, so the manager never reads a
    # half-written unit.
    install -m 0644 "$SRC/$unit" "$DEST/.$unit.tmp"
    mv -f "$DEST/.$unit.tmp" "$DEST/$unit"
    echo "install-units: installed $DEST/$unit"
  fi
done

systemctl --user daemon-reload

cat <<EOF

Installed; nothing was enabled or started. To run them as services:

  # A hand-launched or \`systemd-run\` dashboard holds the name or the port; stop it first.
  systemctl --user stop ralph-dashboard.service
  systemctl --user enable --now ${units[*]}
  loginctl enable-linger ${USER:-$(id -un)}

Logs: journalctl --user -u ralph-dashboard -f$( [[ ${#units[@]} -gt 1 ]] && printf '   journalctl --user -u ralph-bridge -f' )
EOF
