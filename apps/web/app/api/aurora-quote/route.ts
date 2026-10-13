import { NextResponse } from "next/server";

/**
 * DRY-RUN quote from Aurora Intents to Monad. `dry: true` returns a quote without a deposit address, so nothing
 * can be sent or lost through this route. The app key (public by design, but kept server-side) comes from the
 * AURORA_APP_KEY secret.
 */
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const MONAD = {
  usdc: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
  mon: "nep245:v2_1.omni.hot.tg:143_11111111111111111111",
} as const;
const ZERO = "0x0000000000000000000000000000000000000001";

export async function GET(request: Request) {
  const key = process.env.AURORA_APP_KEY;
  if (!key) return NextResponse.json({ error: "Aurora is not configured" }, { status: 503 });
  const { searchParams } = new URL(request.url);
  const to = searchParams.get("to") === "mon" ? "mon" : "usdc";
  const usd = Math.min(Math.max(Number(searchParams.get("usd")) || 2, 1), 100);
  const res = await fetch(`https://intents-api.aurora.dev/api/quote/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      amount: String(Math.round(usd * 1_000_000)),
      originAsset: BASE_USDC,
      destinationAsset: MONAD[to],
      slippageTolerance: 100,
      refundTo: ZERO,
      refundType: "ORIGIN_CHAIN",
      recipient: ZERO,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { quote?: Record<string, string>; message?: string };
  if (!res.ok || !body.quote) {
    return NextResponse.json({ error: body.message ?? `Aurora returned ${res.status}` }, { status: 502 });
  }
  const q = body.quote;
  return NextResponse.json(
    { to, amountIn: q.amountInFormatted, amountInUsd: q.amountInUsd, amountOut: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, seconds: q.timeEstimate },
    { headers: { "cache-control": "no-store" } },
  );
}
