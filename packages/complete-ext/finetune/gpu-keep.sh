#!/usr/bin/env bash
# Keeps the live models' GPU booking (r_9e07e06d2fab: bariton GPU 3, 10 GB) from running out (Ümit #13481), run every
# 12 h by agent-bus-gpu-keep.timer. A booking may reach at most 48 h past now (resources.ts, maxHoldMs), so it is
# extended by 24 h, or by less when that would pass 48 h, or not at all when it already ends almost 48 h from now; it
# so always ends 36–48 h ahead. The bus refuses when nothing of message-bus's ran on the GPU lately (the live servers
# down); that is logged, as is every result. Log: ~/.agent-bus/gpu-keep.log.
set -euo pipefail

BOOKING=${1:-r_9e07e06d2fab}
BUS=http://127.0.0.1:7800
TOKEN=$(cat "$HOME/.agent-bus/agent-token")
# Each line goes to the log file directly (and to systemd's journal): a `tee` behind `exec` died with the script under
# systemd before writing, so the 00:00 extension reached the journal but not the file.
log() { echo "$(date '+%F %T') gpu-keep $BOOKING: $*" | tee -a "$HOME/.agent-bus/gpu-keep.log"; }
when() { date -d "@$(($1 / 1000))" '+%a %F %H:%M %Z'; }

listing=$(curl -sf "$BUS/api/resources?as=message-bus" -H "X-Agent-Token: $TOKEN") || { log "the bus did not answer"; exit 1; }
read -r now end state < <(jq -r --arg id "$BOOKING" '.now as $now | [.. | objects | select(.id? == $id)][0] // {} |
  [$now, (.end // 0), (.state // "missing")] | @tsv' <<<"$listing")
if [[ $state != active ]]; then
  log "not active ($state); nothing extended"
  exit 1
fi
# Hours up to 24 that keep the end within 48 h of now (a few minutes short of it, for the clock between the two calls).
hours=$(awk -v now="$now" -v end="$end" 'BEGIN { h = 48 - (end - now) / 3600000 - 0.1; if (h > 24) h = 24; printf "%.2f", h }')
if awk -v h="$hours" 'BEGIN { exit !(h < 0.5) }'; then
  log "ends $(when "$end"), already near the 48 h cap; nothing to extend"
  exit 0
fi
answer=$(jq -n --argjson hours "$hours" '{from: "message-bus", hours: $hours}' |
  curl -s -X POST "$BUS/api/reservations/$BOOKING/extend?as=message-bus" -H "Content-Type: application/json" \
    -H "X-Agent-Token: $TOKEN" --data-binary @- -w '\n%{http_code}')
code=${answer##*$'\n'}
body=${answer%$'\n'*}
if [[ $code != 200 ]]; then
  log "extending by $hours h refused (HTTP $code): $(jq -r '.error // .' <<<"$body" 2>/dev/null || echo "$body")"
  exit 1
fi
log "extended by $hours h: ended $(when "$end"), now ends $(when "$(jq -r .reservation.end <<<"$body")")"
