#!/usr/bin/env python3
"""Fund a TestNet account via the AlgoKit TestNet Dispenser API.

Docs: https://dev.algorand.co/algokit/utils/python/dispenser-client/

Auth: needs an access token. Get one (once) with the AlgoKit CLI:
    algokit dispenser login           # opens GitHub OAuth in a browser
then either export it or put it in .env:
    ALGOKIT_DISPENSER_ACCESS_TOKEN=...

Usage:
    python scripts/fund_testnet.py                 # fund default address, 10 ALGO
    python scripts/fund_testnet.py <ADDRESS>       # fund a specific address
    python scripts/fund_testnet.py <ADDRESS> 5     # fund 5 ALGO
"""
import os
import sys
from pathlib import Path

from algokit_utils import TestNetDispenserApiClient

# DipBuyer x402 anchoring account (TestNet). Override via arg or ALGORAND_ANCHOR_ADDRESS.
DEFAULT_ADDRESS = "ZU55X7W52EB747SO2T2BZD2IWPKZRLLWO3V6PPDOEQJ2DNSEUVFIOAFNVQ"
MICROALGOS_PER_ALGO = 1_000_000


def load_dotenv_token() -> None:
    """Populate env vars from ../.env if not already set (no extra deps)."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> int:
    load_dotenv_token()

    address = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
        "ALGORAND_ANCHOR_ADDRESS", DEFAULT_ADDRESS
    )
    algo = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
    micro = int(algo * MICROALGOS_PER_ALGO)

    token = os.environ.get("ALGOKIT_DISPENSER_ACCESS_TOKEN")
    if not token:
        print(
            "ERROR: ALGOKIT_DISPENSER_ACCESS_TOKEN not set.\n"
            "Run once:  algokit dispenser login\n"
            "then export the token or add it to .env.",
            file=sys.stderr,
        )
        return 1

    print(f"Funding {address} with {algo} ALGO ({micro} microAlgos)...")
    client = TestNetDispenserApiClient(auth_token=token)
    resp = client.fund(receiver=address, amount=micro)
    print(f"OK  tx_id={resp.tx_id}  amount={resp.amount}")
    print(f"Explorer: https://lora.algokit.io/testnet/tx/{resp.tx_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
