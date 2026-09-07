#!/usr/bin/env bash
#
# Stop the Server Sneeker Discord bot.
#
# This stops the BOT ONLY. The Ark server is launched detached on purpose and
# keeps running across bot restarts (/status and /stop rediscover it by scanning
# the process list), so nothing here touches ArkAscendedServer.exe.
#
# Usage: ./stop-bot.sh
# Safe to run when the bot isn't running — it reports that and exits 0.
#
# Also sourceable: `source stop-bot.sh` exposes bot_pids/stop_bot without
# stopping anything, which is how start-bot.sh reuses this logic.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pidfile="$here/bot.pid"

# Emit "PID|CommandLine" for every running node.exe.
#
# Win32_Process is the only place the command line is visible. `ps -W` shows the
# executable name but not the `src/index.js` argument, which is why the README's
# fallback had to kill *every* node.exe — matching on the command line instead
# means unrelated node processes (other projects, tooling) are never touched.
list_node_procs() {
  MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"\$(\$_.ProcessId)|\$(\$_.CommandLine)\" }" \
    2>/dev/null | tr -d '\r'
}

# Windows PIDs of every running bot instance, newline separated (empty if none).
# Matches both `node src/index.js` and an absolute path to the same file.
bot_pids() {
  list_node_procs \
    | grep -Ei 'src[\\/]index\.js' \
    | cut -d'|' -f1 \
    | grep -E '^[0-9]+$' \
    || true
}

# True if the given Windows PID is a live node.exe.
pid_alive() {
  tasklist //FI "PID eq $1" //NH 2>/dev/null | grep -qi 'node\.exe'
}

stop_bot() {
  if ! command -v powershell.exe >/dev/null 2>&1; then
    echo "ERROR: powershell.exe not found on PATH — can't identify the bot process safely." >&2
    echo "       Fall back to the manual taskkill in README.md > Running it in the background." >&2
    return 1
  fi

  local pids=()
  while IFS= read -r p; do [ -n "$p" ] && pids+=("$p"); done < <(bot_pids)

  # A stale pidfile PID that's still alive but didn't match the scan (e.g. it was
  # launched some other way) still counts — "only one running" has to mean it.
  if [ -f "$pidfile" ]; then
    local saved
    saved="$(tr -dc '0-9' < "$pidfile")"
    if [ -n "$saved" ] && pid_alive "$saved"; then
      local known=0 p
      for p in ${pids[@]+"${pids[@]}"}; do [ "$p" = "$saved" ] && known=1; done
      [ "$known" -eq 0 ] && pids+=("$saved")
    fi
  fi

  if [ ${#pids[@]} -eq 0 ]; then
    echo "Bot is not running."
    rm -f "$pidfile"
    return 0
  fi

  echo "Stopping bot (PID: ${pids[*]})..."
  local p
  for p in "${pids[@]}"; do
    # //F //PID — the doubled slashes stop MSYS rewriting the flags as paths.
    taskkill //F //PID "$p" >/dev/null 2>&1 \
      || echo "  warning: taskkill failed for PID $p (already gone?)" >&2
  done

  # Confirm they're actually gone rather than assuming taskkill won the race.
  local waited=0
  while [ "$waited" -lt 10 ]; do
    local remaining=0
    for p in "${pids[@]}"; do pid_alive "$p" && remaining=1; done
    if [ "$remaining" -eq 0 ]; then
      rm -f "$pidfile"
      echo "Bot stopped."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "ERROR: bot process still alive after 10s: ${pids[*]}" >&2
  return 1
}

# Only act when run directly; sourcing just loads the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  stop_bot
fi
