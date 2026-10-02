#!/usr/bin/env bash
# Auto-retry TestNet funding until the Algorand Foundation dispenser refills.
#
# Background: Lora / AlgoKit CLI / most "Fund" buttons all hit the same Foundation
# dispenser (api.dispenser.algorandfoundation.tools). When it's "out of funds",
# every route fails at once until it refills (usually within the hour). Your
# dispenser login is already cached, so funding is a single command — this just
# repeats it until it works.
#
# Usage:
#   scripts/fund_testnet_retry.sh                       # 2 ALGO, retry every 20 min
#   scripts/fund_testnet_retry.sh <ADDRESS> <ALGO> <SECONDS>
#
# Leave it running in a terminal; it exits 0 the moment funding succeeds.
set -u

PROJECT_DIR="/home/sergo/Documents/D Drive/New Projects/DipBuyer AI 3.0"
ADDR="${1:-ZU55X7W52EB747SO2T2BZD2IWPKZRLLWO3V6PPDOEQJ2DNSEUVFIOAFNVQ}"
ALGO="${2:-2}"
INTERVAL="${3:-1200}"   # seconds between attempts (default 20 min)
ALGOKIT="$PROJECT_DIR/.venv-algokit/bin/algokit"

cd "$PROJECT_DIR" || { echo "project dir not found"; exit 1; }
[ -x "$ALGOKIT" ] || { echo "algokit not found at $ALGOKIT — run setup first"; exit 1; }

echo "Auto-retry funding $ALGO ALGO -> $ADDR every ${INTERVAL}s. Ctrl+C to stop."
while true; do
  echo "----- $(date) : attempting fund -----"
  OUT="$("$ALGOKIT" dispenser fund -r "$ADDR" -a "$ALGO" --whole-units 2>&1)"
  echo "$OUT"
  if echo "$OUT" | grep -qi "out of funds"; then
    echo "Dispenser still empty; retrying in ${INTERVAL}s..."
    sleep "$INTERVAL"
    continue
  fi
  # Anything other than "out of funds" — success or a new error. Stop and show it.
  echo "----- $(date) : stopped (no longer 'out of funds') -----"
  echo "If this shows a transaction id, you're funded. Check Lora:"
  echo "  https://lora.algokit.io/testnet/account/$ADDR"
  break
done
