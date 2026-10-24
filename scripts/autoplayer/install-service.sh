#!/usr/bin/env bash
# Install the Autoplayer as a systemd user service on a Linux box, running
# headless from this checkout. See docs/autoplayer.md, "As a service".
#
# Log the profile in first (`login` on a machine with a screen, then
# `export-session | ssh … import-session`). Idempotent; re-run after moving the
# checkout or changing Node.
#
# Pushes go to NTFY_URL (and NTFY_TOKEN, if the topic needs one) from
# ~/.glizzy-autoplayer/ntfy.env. Without that file it runs silently.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="$(command -v node)" || { echo "node isn't on PATH" >&2; exit 1; }
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/glizzy-autoplayer.service"
FAILED_UNIT="$UNIT_DIR/glizzy-autoplayer-failed.service"
ENV_FILE="$HOME/.glizzy-autoplayer/ntfy.env"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
# Managed by $REPO/scripts/autoplayer/install-service.sh
[Unit]
Description=GlizzyClicker Autoplayer (headless Chromium)
After=network-online.target
# Fires when it stops for good: an exit 3, or ten crashes inside an hour.
OnFailure=glizzy-autoplayer-failed.service
StartLimitIntervalSec=1h
StartLimitBurst=10

[Service]
EnvironmentFile=-$ENV_FILE
WorkingDirectory=$REPO
ExecStart=$NODE scripts/autoplayer.mjs run --plain
# Exit 3 is "a human has to act" (session expired, game hook not deployed):
# restarting can't fix it. Anything else — a Chromium crash, the OOM kill
# below — restarts.
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=3
# A page left clicking for weeks is the textbook place for a slow leak.
MemoryMax=2G
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

cat > "$FAILED_UNIT" <<EOF
# Managed by $REPO/scripts/autoplayer/install-service.sh
[Unit]
Description=Push a notification that the Autoplayer stopped

[Service]
Type=oneshot
EnvironmentFile=-$ENV_FILE
ExecStart=/bin/sh $REPO/scripts/autoplayer/notify-stopped.sh
EOF

systemctl --user daemon-reload
systemctl --user enable --now glizzy-autoplayer.service
# Without lingering the service only runs while you're logged in.
loginctl show-user "$USER" -p Linger | grep -q yes \
  || echo "note: run 'sudo loginctl enable-linger $USER' so it starts at boot with nobody logged in"
[ -f "$ENV_FILE" ] || echo "note: no $ENV_FILE, so no push notifications"
systemctl --user --no-pager --lines=0 status glizzy-autoplayer.service
