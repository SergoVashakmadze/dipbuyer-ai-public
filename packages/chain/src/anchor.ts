import algosdk from "algosdk";
import type { Anchorer } from "./index.js";

/**
 * Anchors a decision/backtest hash on Algorand by writing it into the 1 kB note field of a
 * 0-amount self-payment. Cheap (0.001 ALGO), ~3s final, append-only, tamper-evident.
 * NEVER pass anything but a hash here — no PII/MNPI on a public chain (the engineering design notes).
 */
export interface AlgodAnchorerOptions {
  /** 25-word account mnemonic for the hot anchoring wallet (keep in a vault). */
  mnemonic: string;
  algodUrl: string;
  algodToken?: string;
  algodPort?: number;
}

export function encodeNote(hash: string): Uint8Array {
  return new TextEncoder().encode(hash);
}

export class AlgodAnchorer implements Anchorer {
  private readonly account: algosdk.Account;
  private readonly client: algosdk.Algodv2;

  constructor(opts: AlgodAnchorerOptions) {
    this.account = algosdk.mnemonicToSecretKey(opts.mnemonic);
    this.client = new algosdk.Algodv2(opts.algodToken ?? "", opts.algodUrl, opts.algodPort ?? "");
  }

  get address(): string {
    return this.account.addr.toString();
  }

  async anchor(hash: string): Promise<string> {
    const suggestedParams = await this.client.getTransactionParams().do();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: this.account.addr,
      receiver: this.account.addr, // self-payment carries the note
      amount: 0,
      note: encodeNote(hash),
      suggestedParams,
    });
    const signed = txn.signTxn(this.account.sk);
    const { txid } = await this.client.sendRawTransaction(signed).do();
    await algosdk.waitForConfirmation(this.client, txid, 4);
    return txid;
  }
}
