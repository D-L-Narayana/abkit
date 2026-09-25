import { ArrowLeft, ArrowRight, Check, FlaskConical } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Field, NumberField, Page } from "../components/ui";
import { simulate, upsert, type Experiment } from "../model";
import { fmtNum, fmtPct, sampleSizeMean, sampleSizeProportion } from "../stats";
import { useTitle } from "../theme";

const num = (v: string, d: number) => { const n = Number(v); return v.trim() !== "" && Number.isFinite(n) ? n : d; };
const STEPS = ["Hypothesis", "Metric & power", "Simulate & launch"];

export function Wizard() {
  useTitle("New experiment — abkit");
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: "", hypothesis: "", owner: "You", metric: "Booking conversion", metricType: "conversion" as "conversion" | "continuous", baseline: "0.10", std: "1", mdeRel: "0.05", alpha: "0.05", power: "0.8", dailyTraffic: "40000", split: "0.5", trueLift: "0.05", days: "14" });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const baseline = num(f.baseline, 0.1), mde = num(f.mdeRel, 0.05), alpha = num(f.alpha, 0.05), power = num(f.power, 0.8), daily = num(f.dailyTraffic, 40000), split = num(f.split, 0.5), std = num(f.std, 1);
  const conv = f.metricType === "conversion";
  const perArm = conv ? (baseline > 0 && baseline * (1 + mde) < 1 ? sampleSizeProportion(baseline, mde, alpha, power) : NaN) : sampleSizeMean(std, baseline * mde, alpha, power);
  const daysNeeded = Math.ceil((2 * perArm) / Math.max(1, daily));
  const valid0 = f.name.trim().length > 2;
  const valid1 = Number.isFinite(perArm) && perArm > 0 && alpha > 0 && alpha < 1 && power > 0.5 && power < 1 && split > 0 && split < 1 && daily >= 1 && (!conv || (baseline > 0 && baseline < 1)) && mde !== 0;
  const valid2 = Number.isFinite(num(f.days, NaN)) && num(f.days, 0) >= 1 && num(f.days, 0) <= 60;

  function create() {
    const id = `exp-${f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36).slice(-4)}`;
    const def: Omit<Experiment, "days"> = { id, name: f.name.trim(), hypothesis: f.hypothesis.trim(), owner: f.owner.trim() || "You", metric: f.metric.trim() || "Primary metric", metricType: f.metricType, baseline, ...(conv ? {} : { std }), mdeRel: mde, alpha, power, dailyTraffic: daily, split, startDate: new Date().toISOString().slice(0, 10), status: "running", plannedPerArm: perArm, source: "simulated", tags: ["new"] };
    const e: Experiment = { ...def, days: simulate(def, { trueLiftRel: num(f.trueLift, 0), days: Math.max(1, Math.min(60, Math.round(num(f.days, 14)))) }) };
    upsert(e);
    nav(`/exp/${e.id}`);
  }
  const canContinue = step === 0 ? valid0 : step === 1 ? valid1 : valid2;

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
              <div className="grid sm:grid-cols-2 gap-3">
                <NumberField label="True relative effect to simulate" value={f.trueLift} onChange={set("trueLift")} min={-0.99} max={10} hint="0 = A/A test" />
                <NumberField label="Days of data" value={f.days} onChange={set("days")} min={1} max={60} integer />
              </div>
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
        </form>
        <aside className="card p-5 rise rise-d1 self-start lg:sticky lg:top-20" aria-label="Power analysis">
          <span className="label">Power analysis</span>
          <div className="mono text-3xl font-semibold leading-none">{Number.isFinite(perArm) ? perArm.toLocaleString() : "–"}</div>
          <div className="text-sm muted mt-1">users per arm · {Number.isFinite(perArm) ? (2 * perArm).toLocaleString() : "–"} total</div>
          <div className="mt-3 text-sm flex flex-wrap items-center gap-2">
            <span className="chip chip-accent">≈ {Number.isFinite(daysNeeded) ? daysNeeded : "–"} days</span>
            <span className="faint">at {daily.toLocaleString()} users/day</span>
          </div>
          <p className="text-xs faint mt-4">
            Detects {conv ? `${fmtPct(baseline, 1)} → ${fmtPct(baseline * (1 + mde), 2)}` : `${fmtNum(baseline)} → ${fmtNum(baseline * (1 + mde))}`} with {fmtPct(power, 0)} power at α = {alpha} (two-sided). Fix this before launch and do not stop early on a significant peek.
          </p>
        </aside>
      </div>
    </Page>
  );
}
