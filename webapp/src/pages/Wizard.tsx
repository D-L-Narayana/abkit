import { ArrowLeft, ArrowRight, Check, FlaskConical, RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Field, NumberField, Page } from "../components/ui";
import { findScenario, SCENARIOS, type Scenario } from "../lib/scenarios";
import { store } from "../lib/storage";
import { simulate, type Experiment, type MetricType, type SimOptions } from "../model";
import { fmtNum, fmtPct, powerMean, powerProportion, sampleSizeMean, sampleSizeProportion } from "../stats";
import { useTitle } from "../theme";

const num = (v: string, d: number): number => { const n = Number(v); return v.trim() !== "" && Number.isFinite(n) ? n : d; };
const STEPS = ["Hypothesis", "Metric & power", "Scenario & launch"];
/** sessionStorage key of the in-progress form — per tab, cleared on launch or "Start over". */
const DRAFT_KEY = "abkit-wizard-draft";
const CUSTOM = "custom";

interface Form {
  name: string; hypothesis: string; notes: string; owner: string; metric: string; metricType: MetricType;
  baseline: string; std: string; mdeRel: string; alpha: string; power: string; dailyTraffic: string; split: string;
  scenario: string; trueLift: string; days: string; srmSkew: string; noveltyDecay: boolean; preCorrelation: string;
}
type TextKey = { [K in keyof Form]: Form[K] extends string ? K : never }[keyof Form];
const BASE: Form = { name: "", hypothesis: "", notes: "", owner: "You", metric: "Booking conversion", metricType: "conversion", baseline: "0.10", std: "1", mdeRel: "0.05", alpha: "0.05", power: "0.8", dailyTraffic: "40000", split: "0.5", scenario: CUSTOM, trueLift: "0.05", days: "14", srmSkew: "0", noveltyDecay: false, preCorrelation: "0.6" };

/** Fill the simulation fields from a preset; the preset stays selected until one of them is edited by hand. */
function applyScenario(f: Form, s: Scenario): Form {
  const o = s.options;
  return { ...f, scenario: s.id, trueLift: String(o.trueLiftRel), days: String(o.days), srmSkew: String(o.srmSkew ?? 0), noveltyDecay: !!o.noveltyDecay, preCorrelation: String(o.preCorrelation ?? 0.6) };
}
const DEFAULTS: Form = (() => { const s = findScenario("real-effect"); return s ? applyScenario(BASE, s) : BASE; })();

interface Draft { step: number; f: Form; from?: string }
function readDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const d = parsed as Record<string, unknown>;
    if (!d.f || typeof d.f !== "object") return null;
    const src = d.f as Record<string, unknown>;
    const f: Record<string, string | boolean> = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) { const v = src[k]; if (typeof v === typeof f[k]) f[k] = v as string | boolean; }
    const form = f as unknown as Form;
    form.metricType = form.metricType === "continuous" ? "continuous" : "conversion";
    if (form.scenario !== CUSTOM && !findScenario(form.scenario)) form.scenario = CUSTOM;
    const step = typeof d.step === "number" && d.step >= 0 && d.step <= 2 ? Math.floor(d.step) : 0;
    return { step, f: form, ...(typeof d.from === "string" ? { from: d.from } : {}) };
  } catch { return null; }
}
function writeDraft(d: Draft): void { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* storage unavailable */ } }
function clearDraft(): void { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }

/** Prefill for `/new?from=<id>`: copy the definition, re-apply the scenario preset it was generated from (if any). */
function fromExperiment(e: Experiment): Form {
  const base: Form = {
    ...DEFAULTS,
    name: `${e.name.replace(/ \(copy\)$/, "")} (copy)`,
    hypothesis: e.hypothesis, notes: e.notes ?? "", owner: e.owner, metric: e.metric, metricType: e.metricType,
    baseline: String(e.baseline), std: String(e.std ?? (e.metricType === "continuous" ? e.baseline * 0.8 : 1)),
    mdeRel: String(e.mdeRel), alpha: String(e.alpha), power: String(e.power), dailyTraffic: String(e.dailyTraffic), split: String(e.split),
    scenario: CUSTOM, days: String(Math.max(1, Math.min(60, e.days.length || 14))),
  };
  const s = findScenario(e.scenario);
  return s && (!s.metricType || s.metricType === e.metricType) ? applyScenario(base, s) : base;
}

/** Expected eligible users over `days` days under the simulator's traffic pattern (weekend days at 75%; the ±15% daily noise averages out). */
function expectedUsers(daily: number, days: number): number { let t = 0; for (let d = 0; d < days; d++) t += daily * (d % 7 >= 5 ? 0.75 : 1); return t; }
/** First day on which an arm receiving `share` of traffic reaches `perArm` users; Infinity beyond ten years. */
function daysToReach(perArm: number, daily: number, share: number): number {
  if (!Number.isFinite(perArm) || perArm <= 0 || daily <= 0 || share <= 0) return NaN;
  let users = 0;
  for (let d = 0; d < 3650; d++) { users += daily * (d % 7 >= 5 ? 0.75 : 1) * share; if (users >= perArm) return d + 1; }
  return Infinity;
}

interface Init { step: number; f: Form; notice: string | null }
/** A fresh form: prefilled from `/new?from=<id>` when that experiment exists, otherwise the defaults. */
function freshForm(from: string | undefined): Init {
  if (from) {
    const e = store.load().find((x) => x.id === from);
    if (e) return { step: 0, f: fromExperiment(e), notice: `Prefilled from “${e.name}”. Change anything, then launch to create the copy.` };
    return { step: 0, f: DEFAULTS, notice: "That experiment could not be found in this browser — starting from a blank form." };
  }
  return { step: 0, f: DEFAULTS, notice: null };
}
function initialState(from: string | undefined): Init {
  const draft = readDraft();
  if (from) {
    if (draft && draft.from === from) return { step: draft.step, f: draft.f, notice: "Draft restored — you were editing a copy." };
    return freshForm(from);
  }
  if (draft) {
    const untouched = draft.step === 0 && JSON.stringify(draft.f) === JSON.stringify(DEFAULTS);
    return { step: draft.step, f: draft.f, notice: untouched ? null : "Draft restored from this tab." };
  }
  return freshForm(undefined);
}

export function Wizard() {
  useTitle("New experiment — abkit");
  const nav = useNavigate();
  const [params] = useSearchParams();
  const from = params.get("from") ?? undefined;
  const [init] = useState(() => initialState(from));
  const [step, setStep] = useState(init.step);
  const [f, setF] = useState<Form>(init.f);
  const [notice, setNotice] = useState<string | null>(init.notice);
  const idBase = useId();
  useEffect(() => { writeDraft(from ? { step, f, from } : { step, f }); }, [step, f, from]);

  const set = (k: TextKey) => (v: string) => setF((s) => ({ ...s, [k]: v } as Form));
  const setSim = (k: "trueLift" | "days" | "srmSkew" | "preCorrelation") => (v: string) => setF((s) => ({ ...s, [k]: v, scenario: CUSTOM } as Form));
  const pick = (s: Scenario) => setF((cur) => applyScenario(cur, s));
  function startOver() { clearDraft(); const fresh = freshForm(from); setF(fresh.f); setStep(0); setNotice(fresh.notice); }

  const baseline = num(f.baseline, 0.1), mde = num(f.mdeRel, 0.05), alpha = num(f.alpha, 0.05), power = num(f.power, 0.8), daily = num(f.dailyTraffic, 40000), split = num(f.split, 0.5), std = num(f.std, 1);
  const conv = f.metricType === "conversion";
  const trueLift = num(f.trueLift, 0), days = Math.round(num(f.days, 14)), skew = num(f.srmSkew, 0), rho = num(f.preCorrelation, 0.6);
  const perArm = conv ? (baseline > 0 && baseline * (1 + mde) < 1 ? sampleSizeProportion(baseline, mde, alpha, power) : NaN) : sampleSizeMean(std, baseline * mde, alpha, power);
  const daysNeeded = daysToReach(perArm, daily, Math.min(split, 1 - split));
  // Power the planned run really has: expected users per arm after `days` days (including any allocation skew), equal-arm equivalent n (harmonic mean).
  const expected = expectedUsers(daily, Math.max(1, Math.min(60, days)));
  const nA = expected * (split - skew), nB = expected * (1 - split + skew);
  const nEq = nA > 0 && nB > 0 ? 2 / (1 / nA + 1 / nB) : NaN;
  const powerAt = (effectRel: number): number => (!Number.isFinite(nEq) || !Number.isFinite(perArm) ? NaN : conv ? powerProportion(baseline, effectRel, nEq, alpha) : powerMean(std, baseline * effectRel, nEq, alpha));
  const powerPlanned = powerAt(mde);
  const powerTrue = trueLift !== 0 ? powerAt(trueLift) : NaN;
  const powerTone = !Number.isFinite(powerPlanned) ? "chip" : powerPlanned >= power - 1e-9 ? "chip chip-ok" : powerPlanned >= 0.5 ? "chip chip-warn" : "chip chip-bad";

  // largest relative lift that keeps the treatment rate below 100%
  const liftMax = conv && baseline > 0 ? Math.max(0, Math.min(10, Math.floor((1 / baseline - 1) * 1000 - 1) / 1000)) : 10;
  const valid0 = f.name.trim().length > 2;
  const valid1 = Number.isFinite(perArm) && perArm > 0 && alpha > 0 && alpha < 1 && power > 0.5 && power < 1 && split > 0 && split < 1 && daily >= 1 && (!conv || (baseline > 0 && baseline < 1)) && mde !== 0;
  const daysOk = Number.isInteger(num(f.days, NaN)) && days >= 1 && days <= 60;
  const liftOk = Number.isFinite(num(f.trueLift, NaN)) && trueLift >= -0.99 && trueLift <= liftMax;
  const skewOk = Number.isFinite(num(f.srmSkew, NaN)) && Math.abs(skew) <= 0.2 && split - skew > 0 && split - skew < 1;
  const rhoOk = conv || (Number.isFinite(num(f.preCorrelation, NaN)) && Math.abs(rho) <= 0.99);
  const valid2 = daysOk && liftOk && skewOk && rhoOk;
  const canContinue = step === 0 ? valid0 : step === 1 ? valid1 : valid2;

  function create() {
    const id = `exp-${f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36).slice(-4)}`;
    const scenario = f.scenario !== CUSTOM ? findScenario(f.scenario) : undefined;
    const notes = f.notes.trim();
    const def: Omit<Experiment, "days"> = { id, name: f.name.trim(), hypothesis: f.hypothesis.trim(), owner: f.owner.trim() || "You", metric: f.metric.trim() || "Primary metric", metricType: f.metricType, baseline, ...(conv ? {} : { std }), mdeRel: mde, alpha, power, dailyTraffic: daily, split, startDate: new Date().toISOString().slice(0, 10), status: "running", plannedPerArm: perArm, source: "simulated", tags: ["new"], ...(scenario ? { scenario: scenario.id } : {}), ...(notes ? { notes } : {}) };
    const opts: SimOptions = { trueLiftRel: trueLift, days: Math.max(1, Math.min(60, days)), srmSkew: skew, noveltyDecay: f.noveltyDecay, ...(conv ? {} : { preCorrelation: rho }) };
    const e: Experiment = { ...def, days: simulate(def, opts) };
    store.upsert(e);
    clearDraft();
    nav(`/exp/${e.id}`);
  }

  return (
    <Page eyebrow="Create experiment" title="New experiment">
      <ol className="flex items-center gap-2 mb-6 text-sm overflow-x-auto" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={`flex items-center gap-2 shrink-0 ${i === step ? "text-ink font-semibold" : "faint"}`} aria-current={i === step ? "step" : undefined}>
            <span className={`step-dot ${i < step ? "is-done" : i === step ? "is-active" : ""}`}>{i < step ? <Check size={12} aria-hidden="true" /> : i + 1}</span>
            <span className={i === step ? "" : "hidden sm:inline"}>{s}</span>
            {i < STEPS.length - 1 && <span className="w-6 sm:w-8 h-px bg-line-strong" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      <div className="grid lg:grid-cols-[1fr_340px] gap-5">
        <form className="card p-5 grid gap-4 rise" onSubmit={(ev) => { ev.preventDefault(); if (!canContinue) return; if (step < 2) setStep(step + 1); else create(); }} noValidate>
          {notice && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm rounded-xl border border-line bg-bg2 px-3 py-2" role="status">
              <span className="muted">{notice}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={startOver}><RotateCcw size={14} aria-hidden="true" /> Start over</button>
            </div>
          )}
          {step === 0 && (
            <>
              <Field label="Experiment name" error={f.name.length > 0 && !valid0 ? "Give it at least 3 characters." : null}>
                <input className="input" value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder="e.g. Map view as default on mobile" autoFocus aria-invalid={f.name.length > 0 && !valid0} />
              </Field>
              <Field label="Hypothesis" hint="If we [change], then [metric] will [move] because [reason].">
                <textarea className="input" value={f.hypothesis} onChange={(e) => set("hypothesis")(e.target.value)} rows={3} />
              </Field>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Owner"><input className="input" value={f.owner} onChange={(e) => set("owner")(e.target.value)} /></Field>
                <Field label="Primary metric"><input className="input" value={f.metric} onChange={(e) => set("metric")(e.target.value)} /></Field>
              </div>
              <Field label="Notes (optional)" hint="Context for whoever reads the results: segments, known caveats, links.">
                <textarea className="input" value={f.notes} onChange={(e) => set("notes")(e.target.value)} rows={2} />
              </Field>
            </>
          )}
          {step === 1 && (
            <>
              <Field label="Metric type">
                <select className="input" value={f.metricType} onChange={(e) => set("metricType")(e.target.value)}>
                  <option value="conversion">Conversion rate (binary per user)</option>
                  <option value="continuous">Continuous (revenue, nights, …)</option>
                </select>
              </Field>
              <div className="grid sm:grid-cols-2 gap-3">
                <NumberField label={conv ? "Baseline rate" : "Baseline mean"} value={f.baseline} onChange={set("baseline")} min={conv ? 0.0001 : 0} max={conv ? 0.9999 : undefined} hint={conv ? "0.10 means 10%" : "e.g. 412"} />
                {conv ? null : <NumberField label="Standard deviation" value={f.std} onChange={set("std")} min={0.000001} />}
                <NumberField label="Minimum detectable effect (relative)" value={f.mdeRel} onChange={set("mdeRel")} min={-0.99} max={10} hint="0.05 = +5% relative lift" />
                <NumberField label="Alpha (two-sided)" value={f.alpha} onChange={set("alpha")} min={0.0001} max={0.5} />
                <NumberField label="Power" value={f.power} onChange={set("power")} min={0.5} max={0.999} />
                <NumberField label="Daily eligible users" value={f.dailyTraffic} onChange={set("dailyTraffic")} min={1} integer />
                <NumberField label="Share of traffic to control" value={f.split} onChange={set("split")} min={0.01} max={0.99} hint="0.5 = 50/50 split" />
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <p className="muted text-sm">This app has no production traffic, so the experiment is simulated with a true effect you choose. The analysis pipeline is exactly what real data goes through — the same one <Link className="link" to="/upload">CSV upload</Link> feeds.</p>
              <fieldset className="grid gap-2 min-w-0 border-0 p-0 m-0">
                <legend className="label">Scenario</legend>
                <div className="grid sm:grid-cols-2 gap-2">
                  {[...SCENARIOS, null].map((s) => {
                    const id = s ? s.id : CUSTOM;
                    const disabled = !!s?.metricType && s.metricType !== f.metricType;
                    const selected = f.scenario === id;
                    const card = `flex items-start gap-3 p-3 rounded-xl border transition-colors ${selected ? "border-accent-text bg-accent-soft" : "border-line"} ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:border-line-strong"}`;
                    return (
                      <label key={id} className={card}>
                        <input type="radio" name="scenario" value={id} checked={selected} disabled={disabled} onChange={() => (s ? pick(s) : setF((cur) => ({ ...cur, scenario: CUSTOM })))} aria-labelledby={`${idBase}-${id}-name`} aria-describedby={`${idBase}-${id}-desc`} className="mt-1 shrink-0 accent-accent" />
                        <span className="min-w-0">
                          <span id={`${idBase}-${id}-name`} className="block text-sm font-medium">{s ? s.name : "Custom"}</span>
                          <span id={`${idBase}-${id}-desc`} className="block text-xs muted mt-0.5">
                            {s ? s.description : "Set the true effect, duration, allocation skew and novelty decay yourself. Editing any of them switches to Custom automatically."}
                            {disabled && <span className="block text-warn mt-1">Needs a continuous metric — change the metric type in step 2.</span>}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <div className="grid sm:grid-cols-2 gap-3">
                <NumberField label="True relative effect to simulate" value={f.trueLift} onChange={setSim("trueLift")} min={-0.99} max={liftMax} hint="0 = A/A test" />
                <NumberField label="Days of data" value={f.days} onChange={setSim("days")} min={1} max={60} integer />
                <NumberField label="Allocation skew (bucketing bug)" value={f.srmSkew} onChange={setSim("srmSkew")} min={-0.2} max={0.2} hint="Share of traffic leaking from control to treatment: 0.012 = 1.2 points, 0 = none" />
                {conv ? null : <NumberField label="Pre-period correlation (CUPED covariate)" value={f.preCorrelation} onChange={setSim("preCorrelation")} min={-0.99} max={0.99} hint="ρ between the pre-period covariate and the metric — higher removes more variance" />}
              </div>
              {!skewOk && Number.isFinite(num(f.srmSkew, NaN)) && Math.abs(skew) <= 0.2 && <p className="text-xs text-bad" role="alert">The skew would leave control with no traffic — keep it smaller than the control share.</p>}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={f.noveltyDecay} onChange={(e) => setF((cur) => ({ ...cur, noveltyDecay: e.target.checked, scenario: CUSTOM }))} className="mt-1 shrink-0 accent-accent" />
                <span>Novelty decay — the effect fades linearly from day 1 to a fifth of its size by the last day.</span>
              </label>
            </>
          )}
          <div className="flex justify-between items-center pt-2 gap-2">
            {step > 0 ? (
              <button type="button" className="btn btn-ghost" onClick={() => setStep(step - 1)}><ArrowLeft size={15} aria-hidden="true" /> Back</button>
            ) : (
              <Link to="/" className="btn btn-ghost">Cancel</Link>
            )}
            {step < 2 ? (
              <button type="submit" className="btn btn-primary" disabled={!canContinue}>Continue <ArrowRight size={15} aria-hidden="true" /></button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={!canContinue}><FlaskConical size={15} aria-hidden="true" /> Launch experiment</button>
            )}
          </div>
          <p className="text-xs faint">Your draft is kept in this browser tab until you launch.</p>
        </form>
        <aside className="card p-5 rise rise-d1 self-start lg:sticky lg:top-20" aria-label="Power analysis">
          <span className="label">Power analysis</span>
          <div className="mono text-3xl font-semibold leading-none">{Number.isFinite(perArm) ? perArm.toLocaleString() : "–"}</div>
          <div className="text-sm muted mt-1">users per arm · {Number.isFinite(perArm) ? (2 * perArm).toLocaleString() : "–"} total</div>
          <div className="mt-3 text-sm flex flex-wrap items-center gap-2">
            <span className="chip chip-accent">≈ {Number.isNaN(daysNeeded) ? "–" : Number.isFinite(daysNeeded) ? daysNeeded : "3650+"} days</span>
            <span className="faint">at {daily.toLocaleString()} users/day, weekends at 75%</span>
          </div>
          <div className="mt-4 pt-4 border-t border-line grid gap-1" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="muted">Power at your planned {days} {days === 1 ? "day" : "days"}</span>
              <span className={powerTone}>{fmtPct(powerPlanned, 0)}</span>
            </div>
            <p className="text-xs faint">
              ≈ {fmtNum(nA, 0)} control vs {fmtNum(nB, 0)} treatment users expected{skew !== 0 ? " after the allocation skew" : ""}.
              {Number.isFinite(powerPlanned) ? (powerPlanned < power ? ` Below the ${fmtPct(power, 0)} you planned — add days or accept a larger MDE.` : " Meets the power you planned.") : ""}
            </p>
            {Number.isFinite(powerTrue) && <p className="text-xs faint">The simulated {trueLift > 0 ? "+" : ""}{fmtPct(trueLift, 1)} true effect would be detected with {fmtPct(powerTrue, 0)} power{f.noveltyDecay ? " if it did not fade" : ""}.</p>}
          </div>
          <p className="text-xs faint mt-4">
            Detects {conv ? `${fmtPct(baseline, 1)} → ${fmtPct(baseline * (1 + mde), 2)}` : `${fmtNum(baseline)} → ${fmtNum(baseline * (1 + mde))}`} with {fmtPct(power, 0)} power at α = {alpha} (two-sided). Fix this before launch and do not stop early on a significant peek.
          </p>
        </aside>
      </div>
    </Page>
  );
}
