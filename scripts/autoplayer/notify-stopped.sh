#!/bin/sh
# OnFailure= handler for glizzy-autoplayer.service (install-service.sh): push
# the Autoplayer's last log line, which is the reason it stopped.
[ -n "$NTFY_URL" ] || exit 0
msg="$(journalctl --user -u glizzy-autoplayer SYSLOG_IDENTIFIER=node -n 1 -o cat --no-pager | sed 's/^[0-9:]*  //')"
[ -n "$msg" ] || msg="glizzy-autoplayer.service failed"
set -- -fsS -m 20 -H "Title: Glizzy Autoplayer stopped" -H "Priority: urgent" -H "Tags: rotating_light"
[ -n "$NTFY_TOKEN" ] && set -- "$@" -H "Authorization: Bearer $NTFY_TOKEN"
curl "$@" -d "$msg" "$NTFY_URL" >/dev/null
