#!/usr/bin/env bash
#
# Start the Server Sneeker Discord bot in the background.
#
# Stops any bot instance that's already running first, so there is never more
# than one — two bots on the same token would both answer every slash command
# and could issue overlapping start/stop operations against the Ark server.
#
# The Ark server itself is left alone: it runs detached and survives bot
# restarts by design.
#
# Usage: ./start-bot.sh      (then: tail -f bot.log)

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here" || exit 1

logfile="$here/bot.log"
pidfile="$here/bot.pid"

# Reuse the process discovery / kill logic rather than duplicating it.
# shellcheck source=stop-bot.sh
. "$here/stop-bot.sh"

# --- preflight -------------------------------------------------------------
# Fail here with a clear message instead of letting the bot exit into bot.log.
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node.js 18+ and reopen the terminal." >&2
  exit 1
fi
for required in config.json .env; do
  if [ ! -f "$here/$required" ]; then
    echo "ERROR: $required not found in $here — copy the matching .example file and fill it in." >&2
    exit 1
  fi
done

# --- ensure a single instance ---------------------------------------------
stop_bot || exit 1

# --- launch ----------------------------------------------------------------
# Append rather than truncate so the previous run's log survives a restart;
# the banner marks where this run begins.
{
  echo
  echo "=== bot started $(date '+%Y-%m-%d %H:%M:%S') ==="
} >> "$logfile"

# nohup so it survives closing the terminal; absolute script path so the
# command line is unambiguous when stop-bot.sh goes looking for it.
nohup node "$here/src/index.js" >> "$logfile" 2>&1 &
disown 2>/dev/null || true

# Bash's $! is an MSYS pid, which taskkill/tasklist don't recognise, so resolve
# the real Windows PID from the process list instead.
pid=""
waited=0
while [ "$waited" -lt 15 ]; do
  pid="$(bot_pids | head -n 1)"
  [ -n "$pid" ] && break
  sleep 1
  waited=$((waited + 1))
done

if [ -z "$pid" ]; then
  echo "ERROR: bot failed to start — last 20 lines of $logfile:" >&2
  tail -n 20 "$logfile" >&2
  exit 1
fi

echo "$pid" > "$pidfile"
echo "Bot started (PID $pid). Logging to $logfile"

# Give Discord login a moment so a bad token / config shows up now, not later.
sleep 4
if ! pid_alive "$pid"; then
  echo "ERROR: bot exited right after starting — last 20 lines of $logfile:" >&2
  tail -n 20 "$logfile" >&2
  rm -f "$pidfile"
  exit 1
fi

echo "--- $logfile (tail) ---"
tail -n 5 "$logfile"
echo "Follow it with: tail -f $logfile"
