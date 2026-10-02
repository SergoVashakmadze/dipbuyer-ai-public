"use client";

import { useAuth0 } from "@auth0/auth0-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { auth0Configured, useOnboarding, type Onboarding, type StepState } from "../../lib/onboarding";

const COUNTRY_CODES =
  "GB US IE FR DE NL BE LU ES PT IT CH AT DK SE NO FI PL CZ GR CY MT EE LV LT SK SI HR RO BG HU IS LI MC CA AU NZ SG HK JP KR IN AE SA QA IL ZA NG KE BR MX AR CL CO GE AM AZ UA TR".split(" ");

type StepId = "account" | "profile" | "identity" | "suitability" | "done";

const QUESTIONS: Array<{ key: "objectives" | "investmentHorizon" | "riskTolerance" | "capacityForLoss" | "knowledgeExperience"; title: string; help: string; options: Array<[string, string, string]> }> = [
  {
    key: "objectives",
    title: "What do you want this money to do?",
    help: "Your main goal for the money you would invest here.",
    options: [
      ["Long-term capital growth", "Grow it over the long term", "Accepting ups and downs along the way"],
      ["Growth with some income", "Grow it, with some dividends", "A balance of growth and income"],
      ["Preserve capital", "Keep it safe", "Avoiding losses matters most"],
    ],
  },
  {
    key: "investmentHorizon",
    title: "When might you need this money?",
    help: "Shares can take years to recover from a fall.",
    options: [
      ["lt3", "Within 3 years", ""],
      ["3to5", "In 3 to 5 years", ""],
      ["5to10", "In 5 to 10 years", ""],
      ["gt10", "Not for 10 years or more", ""],
    ],
  },
  {
    key: "riskTolerance",
    title: "If your investments fell 20% in a few months, what would you do?",
    help: "The strategy's worst fall in its hypothetical 2016-2025 backtest was 22%.",
    options: [
      ["low", "Sell to stop further losses", "I would find it very hard to watch"],
      ["medium", "Wait for a recovery", "Uncomfortable, but I would hold"],
      ["high", "Consider buying more", "Falls are part of investing"],
    ],
  },
  {
    key: "capacityForLoss",
    title: "How would losing part of this money affect you?",
    help: "Think about your income, savings and commitments.",
    options: [
      ["low", "It would seriously affect my finances", "I rely on this money"],
      ["medium", "It would hurt, but I would cope", "I have other savings"],
      ["high", "It would not change my life", "This is money I can afford to put at risk"],
    ],
  },
  {
    key: "knowledgeExperience",
    title: "How much do you know about investing in shares?",
    help: "Be honest; this protects you.",
    options: [
      ["none", "Nothing yet", "I have never invested"],
      ["basic", "The basics", "I have a pension or a fund"],
      ["informed", "Quite a lot", "I have bought individual shares"],
      ["expert", "A great deal", "I work in finance or invest actively"],
    ],
  },
];

function stepLabel(s: StepState) {
  return s === "done" ? "Done" : s === "in_review" ? "In review" : s === "rejected" ? "Not verified" : s === "unsuitable" ? "Not suitable" : "To do";
}

function OnboardingPage() {
  const { user, loginWithRedirect, isLoading } = useAuth0();
  const { data, error, ready, signedOut, call, refresh, setError } = useOnboarding();
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<StepId | null>(null);
  const [profile, setProfile] = useState({ fullName: "", countryOfResidence: "GB" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [link, setLink] = useState<string | null>(null);
  const next = useMemo(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("next")), []);
  const regionName = useMemo(() => {
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      return (c: string) => dn.of(c) ?? c;
    } catch {
      return (c: string) => c;
    }
  }, []);

  // The first unfinished step, unless the investor clicked a finished one to review it.
  const current: StepId = useMemo(() => {
    if (!data) return "account";
    if (active) return active;
    if (data.steps.profile !== "done") return "profile";
    if (data.steps.identity !== "done") return "identity";
    if (data.steps.suitability !== "done") return "suitability";
    return "done";
  }, [data, active]);

  useEffect(() => {
    if (data?.profile) setProfile(data.profile);
    if (data?.suitability) {
      const s = data.suitability;
      setAnswers({ objectives: s.objectives, investmentHorizon: s.investmentHorizon, riskTolerance: s.riskTolerance, capacityForLoss: s.capacityForLoss, knowledgeExperience: s.knowledgeExperience });
    }
  }, [data?.profile, data?.suitability]);

  // While Persona reviews, check every 5 seconds for up to 10 minutes.
  const polls = useRef(0);
  useEffect(() => {
    if (data?.steps.identity !== "in_review") return;
    polls.current = 0;
    const id = window.setInterval(() => {
      if (++polls.current > 120) return window.clearInterval(id);
      void call("/identity/refresh", { method: "POST" }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, [data?.steps.identity, call]);

  async function act(fn: () => Promise<Onboarding>) {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      setActive(null);
      return out;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (signedOut) {
    return (
      <div className="onboarding-wrap">
        <div className="card onboarding-signin">
          <span className="eyebrow">Onboarding</span>
          <h1>Demonstration onboarding</h1>
          <p className="muted">Sign in to see how the demonstration identity check and suitability questions work.</p>
          <button className="btn btn-brand" onClick={() => loginWithRedirect({ appState: { returnTo: "/onboarding" } })}>
            Sign in
          </button>
        </div>
      </div>
    );
  }
  if (!ready || !data) return <p className="muted" style={{ marginTop: 40 }}>{error ?? (isLoading ? "Checking your session…" : "Loading your onboarding…")}</p>;

  const steps: Array<[StepId, string, string, StepState]> = [
    ["account", "Account", auth0Configured ? user?.email ?? "Signed in" : "Local dev (no Auth0)", "done"],
    ["profile", "Your details", "Name and country", data.steps.profile],
    ["identity", "Identity check", data.identityProvider.demo ? "Demo verification" : "Verified by Persona", data.steps.identity],
    ["suitability", "Suitability", "Goals and attitude to risk", data.steps.suitability],
    ["done", "Ready to invest", "Start with the agent", data.complete ? "done" : "todo"],
  ];

  return (
    <div className="onboarding-wrap">
      <div className="page-head">
        <span className="eyebrow">Onboarding</span>
        <h1>
          {data.complete ? "You're all set" : <>Set up your <span className="grad-text">investor account</span></>}
        </h1>
        <p>We are required to confirm who you are and check that our service suits you before any trade is placed for you.</p>
      </div>

      <div className="onboarding">
        <ol className="onboarding-steps">
          {steps.map(([id, title, sub, state], i) => (
            <li key={id} className={`${current === id ? "current" : ""} ${state}`}>
              <button type="button" onClick={() => setActive(id === "account" ? null : id)} disabled={id === "done" && !data.complete}>
                <span className="dot">{state === "done" ? "✓" : state === "rejected" || state === "unsuitable" ? "!" : i + 1}</span>
                <span>
                  <b>{title}</b>
                  <small>{sub}</small>
                </span>
                <span className={`step-state ${state}`}>{stepLabel(state)}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="card onboarding-panel">
          {error && (
            <div className="demo-banner" role="alert" style={{ borderColor: "var(--danger)", background: "var(--danger-soft)", marginTop: 0 }}>
              {error}
            </div>
          )}

          {current === "profile" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => call("/profile", { method: "PUT", body: JSON.stringify(profile) }));
              }}
            >
              <h2>Your details</h2>
              <p className="muted">Use your legal name as it appears on your passport or driving licence, so the identity check can match it.</p>
              <label className="field">
                <span>Full legal name</span>
                <input value={profile.fullName} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} autoComplete="name" required minLength={2} />
              </label>
              <label className="field">
                <span>Country of residence</span>
                <select value={profile.countryOfResidence} onChange={(e) => setProfile({ ...profile, countryOfResidence: e.target.value })} autoComplete="country">
                  {COUNTRY_CODES.map((c) => (
                    <option key={c} value={c}>
                      {regionName(c)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-brand" disabled={busy}>
                {busy ? "Saving…" : "Save and continue"}
              </button>
            </form>
          )}

          {current === "identity" && (
            <div>
              <h2>Verify your identity</h2>
              {data.identityProvider.demo ? (
                <div className="demo-banner">
                  <strong>Demo verification.</strong> Persona is not configured on this server (PERSONA_API_KEY, PERSONA_TEMPLATE_ID), so this step approves
                  instantly and checks no documents. Never use it with real clients.
                </div>
              ) : (
                <p className="muted">
                  Our verification partner Persona will ask for a photo of your passport or driving licence and a quick selfie. It opens in a new tab and
                  usually takes two or three minutes.
                </p>
              )}
              {data.steps.identity === "rejected" ? (
                <div className="notice bad">
                  <b>We could not verify your identity.</b> {data.kyc.detail}. Contact support; we cannot offer investment services without a successful check.
                </div>
              ) : data.steps.identity === "in_review" ? (
                <div className="notice">
                  <b>Verification in progress.</b> {data.kyc.detail}. This page checks automatically; approval usually takes a few minutes.
                  <div className="chip-row" style={{ marginTop: 12, marginBottom: 0 }}>
                    <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act(() => call("/identity/refresh", { method: "POST" }))}>
                      Check now
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      disabled={busy}
                      onClick={async () => {
                        const out = await act(() => call("/identity/start", { method: "POST" }));
                        if (out?.hostedUrl) {
                          setLink(out.hostedUrl);
                          window.open(out.hostedUrl, "_blank", "noopener");
                        }
                      }}
                    >
                      Reopen Persona
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-brand"
                  disabled={busy}
                  onClick={async () => {
                    const out = await act(() => call("/identity/start", { method: "POST" }));
                    if (out?.hostedUrl) {
                      setLink(out.hostedUrl);
                      window.open(out.hostedUrl, "_blank", "noopener");
                    }
                  }}
                >
                  {busy ? "Starting…" : data.identityProvider.demo ? "Run demo verification" : "Verify with Persona"}
                </button>
              )}
              {link && (
                <p className="faint small" style={{ marginTop: 12 }}>
                  If the verification tab did not open,{" "}
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    open it here
                  </a>
                  .
                </p>
              )}
            </div>
          )}

          {current === "suitability" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => call("/suitability", { method: "POST", body: JSON.stringify({ ...answers, riskAcknowledged: answers.riskAcknowledged === "yes" }) }));
              }}
            >
              <h2>Your goals and attitude to risk</h2>
              <p className="muted">Five questions. We use your answers to decide whether our service is suitable for you, and keep them as a record.</p>
              {data.steps.suitability === "unsuitable" && data.suitability && (
                <div className="notice bad">
                  <b>Our investment service is not suitable for you right now.</b>
                  <ul>
                    {data.suitability.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  You can still use our research. If your circumstances change, you can answer again.
                </div>
              )}
              {QUESTIONS.map((q) => (
                <fieldset key={q.key} className="question">
                  <legend>{q.title}</legend>
                  <p className="faint small">{q.help}</p>
                  <div className="choice-grid">
                    {q.options.map(([value, label, hint]) => (
                      <label key={value} className={`choice ${answers[q.key] === value ? "selected" : ""}`}>
                        <input type="radio" name={q.key} value={value} checked={answers[q.key] === value} onChange={() => setAnswers({ ...answers, [q.key]: value })} required />
                        <b>{label}</b>
                        {hint && <small>{hint}</small>}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              {answers.riskTolerance === "low" && (
                <div className="notice">
                  <b>Please read before you continue.</b> You said you would sell after a 20% fall. This strategy&apos;s value fell 22% at its worst in
                  the hypothetical 2016-2025 backtest, and selling after a fall locks in the loss.
                  <label className="ack">
                    <input type="checkbox" checked={answers.riskAcknowledged === "yes"} onChange={(e) => setAnswers({ ...answers, riskAcknowledged: e.target.checked ? "yes" : "" })} />
                    I understand that my investments can fall by a fifth or more, and I still want to continue.
                  </label>
                </div>
              )}
              <p className="faint small">
                Capital at risk. The value of investments can fall as well as rise and you may get back less than you invest. Past performance, including
                backtests, is not a guide to future returns.
              </p>
              <button className="btn btn-brand" disabled={busy || QUESTIONS.some((q) => !answers[q.key]) || (answers.riskTolerance === "low" && answers.riskAcknowledged !== "yes")}>
                {busy ? "Assessing…" : "Submit answers"}
              </button>
            </form>
          )}

          {current === "done" && (
            <div>
              <h2>Welcome, {data.profile?.fullName.split(" ")[0]}</h2>
              <p className="muted">Your identity check and suitability assessment are complete. In this demonstration you can now see how approving the trades the agent proposes would work.</p>
              <dl className="metric-list" style={{ margin: "16px 0 24px" }}>
                <div>
                  <dt>Name</dt>
                  <dd>{data.profile?.fullName}</dd>
                </div>
                <div>
                  <dt>Country</dt>
                  <dd>{data.profile ? regionName(data.profile.countryOfResidence) : "—"}</dd>
                </div>
                <div>
                  <dt>Identity</dt>
                  <dd>{data.kyc.demo ? "Demo verification (no documents checked)" : "Verified by Persona"}</dd>
                </div>
                <div>
                  <dt>Suitability</dt>
                  <dd>Assessed {data.suitability ? new Date(data.suitability.assessedAt).toLocaleDateString() : ""}</dd>
                </div>
              </dl>
              <div className="chip-row">
                <a className="btn btn-brand" href={next && next.startsWith("/") ? next : "/agent"}>
                  {next && next.startsWith("/") && next !== "/agent" ? "Continue" : "Open the investing agent"}
                </a>
                <button className="btn btn-outline" onClick={() => setActive("suitability")}>
                  Review my answers
                </button>
              </div>
            </div>
          )}

          {current === "account" && (
            <div>
              <h2>Your account</h2>
              <p className="muted">{auth0Configured ? `Signed in as ${user?.email ?? user?.name ?? data.userId}.` : "Auth0 is not configured, so this local session uses the demo-user account."}</p>
              <button className="btn btn-outline" onClick={() => void refresh()}>
                Continue
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default OnboardingPage;
