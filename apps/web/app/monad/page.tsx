import type { Metadata } from "next";
import { monadTestnet } from "viem/chains";
import { IconArrow, IconChart, IconLink, IconShield } from "../../components/icons";

export const metadata: Metadata = {
  title: "Provable on Monad — every DipBuyer AI decision checkable on chain",
  description:
    "DipBuyer AI hashes every decision and anchors a whole run on Monad testnet as one Merkle root. Anyone can prove a single decision against that root in their browser, without trusting DipBuyer.",
};

const explorer = monadTestnet.blockExplorers?.default.url ?? "https://testnet.monadexplorer.com";

/** Addresses and ids as deployed (apps/web/public/monad-batches.json, agent-registration.json). */
const REGISTRY = "0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121";
const CRE_RECEIVER = "0x79cf4f8c9dcafe4cfe21c85c494acd5e4d0c9ab6";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const FIRST_BATCH_TX = "0xdb6f1f19d37f37428996492332f92eab12aec7982ac9abf8ba4bdaf1d799443f";
const LIVE_RUN_TX = "0x6a3d20b7365dde8851936e778da60b570a9843d0a7ec026feb7f33d7541fa919";

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

const STEPS = [
  {
    hue: "hue-violet",
    title: "Hash each decision",
    body: "Every verdict (symbol, date, company type, each checklist criterion with its value, and the rules version) is reduced to a keccak-256 hash. Change one number and the hash changes.",
  },
  {
    hue: "hue-sky",
    title: "Anchor one root per run",
    body: "The hashes of a whole run go into a Merkle tree. Only its root is written to the DecisionRegistry contract on Monad, so 50,000 decisions cost one transaction.",
  },
  {
    hue: "hue-emerald",
    title: "Prove any single decision",
    body: "A short inclusion proof links one decision to the root. Your browser recomputes the hash, replays the proof and asks the contract directly. DipBuyer's servers are not contacted.",
  },
];

const FACTS: Array<{ label: string; value: React.ReactNode }> = [
  {
    label: "Decision registry",
    value: (
      <a href={`${explorer}/address/${REGISTRY}`} target="_blank" rel="noreferrer">
        {short(REGISTRY)}
      </a>
    ),
  },
  { label: "Network", value: "Monad testnet (chain 10143)" },
  {
    label: "Largest batch",
    value: (
      <>
        53,384 decisions of the 2016-2025 backtest in{" "}
        <a href={`${explorer}/tx/${FIRST_BATCH_TX}`} target="_blank" rel="noreferrer">
          one transaction
        </a>
      </>
    ),
  },
  {
    label: "Latest live run",
    value: (
      <>
        The live 36-stock screen of 4 Oct 2026 under strategy v0.4.2,{" "}
        <a href={`${explorer}/tx/${LIVE_RUN_TX}`} target="_blank" rel="noreferrer">
          anchored gaslessly
        </a>
        ; every decision in it is listed on the <a href="/verify/monad">verifier</a>
      </>
    ),
  },
  { label: "Contract source", value: "Verified on Sourcify; 23 Foundry tests" },
  { label: "Gas", value: "Batches can be sent gasless as ERC-4337 operations; the anchoring account holds no MON" },
  {
    label: "Agent identity",
    value: (
      <>
        ERC-8004 agentId 1978 in the{" "}
        <a href={`${explorer}/address/${IDENTITY_REGISTRY}`} target="_blank" rel="noreferrer">
          Identity Registry
        </a>{" "}
        (<a href="/agent-registration.json">registration file</a>)
      </>
    ),
  },
  {
    label: "Automated anchoring",
    value: (
      <>
        A Chainlink CRE workflow builds the root from the public API and anchors it through a{" "}
        <a href={`${explorer}/address/${CRE_RECEIVER}`} target="_blank" rel="noreferrer">
          receiver contract
        </a>
        . Simulated and broadcast; not yet deployed as a live workflow.
      </>
    ),
  },
  { label: "Batch list", value: "Read from an Envio HyperIndex indexer of the registry's events" },
];

export default function MonadPage() {
  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Provable on Monad</span>
        <h1>
          Every decision, <span className="grad-text">checkable by anyone</span>
        </h1>
        <p>
          A backtest or a track record is only worth something if nobody could have edited it afterwards. DipBuyer AI writes a
          fingerprint of every decision to the Monad blockchain, so you can check that a verdict existed, unchanged, under a named
          version of the rules, without taking our word for it.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
          <a className="btn btn-brand" href="/verify/monad">
            Verify a decision now <IconArrow width={14} height={14} />
          </a>
          <a className="btn btn-outline" href="/audit">
            Browse the decision audit
          </a>
        </div>
      </div>

      <div className="section-head">
        <h2>
          How it <span className="grad-text">works</span>
        </h2>
        <p>Three steps, all reproducible from public code.</p>
      </div>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div className={`card step ${s.hue}`} key={s.title}>
            <div className="n">{i + 1}</div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        ))}
      </div>

      <div className="section-head">
        <h2>
          What it proves, <span className="grad-text">and what it does not</span>
        </h2>
      </div>
      <div className="two-col">
        <div className="card feature hue-emerald">
          <span className="icon">
            <IconShield />
          </span>
          <h3>It proves</h3>
          <p>
            That a specific decision was part of a run anchored at a known time, and that neither the decision nor the rules version
            it records has changed since. Nobody, including DipBuyer, can quietly drop a losing trade from an anchored backtest.
          </p>
        </div>
        <div className="card feature hue-amber">
          <span className="icon">
            <IconChart />
          </span>
          <h3>It does not prove</h3>
          <p>
            That the decision was any good, or that the data behind it was correct. It is an audit trail, not an endorsement. The
            backtest&apos;s own limits are set out in the <a href="/methodology">methodology</a>.
          </p>
        </div>
      </div>

      <div className="section-head">
        <h2>
          On chain <span className="grad-text">today</span>
        </h2>
        <p>Everything here runs on Monad testnet. Real trading is switched off.</p>
      </div>
      <div className="card" style={{ padding: "8px 20px 16px" }}>
        {FACTS.map((f) => (
          <div className="kv" key={f.label} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
            <b style={{ minWidth: 170, flexShrink: 0 }}>{f.label}</b>
            <span>{f.value}</span>
          </div>
        ))}
        <p className="footnote" style={{ marginTop: 12 }}>
          Earlier decisions were anchored individually on Algorand; those can still be checked on the{" "}
          <a href="/verify">record verifier</a>.
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "24px 0" }}>
        <a className="btn btn-brand" href="/verify/monad">
          <IconLink width={14} height={14} /> Open the Monad verifier
        </a>
      </div>
    </div>
  );
}
