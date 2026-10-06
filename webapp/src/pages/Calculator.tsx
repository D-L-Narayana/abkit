import { Check, Link2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisTick, gridProps, tooltipProps } from "../components/charts";
import { Field, NumberField, Page, Section, useCopy } from "../components/ui";
import { fmtNum, fmtP, fmtPct, mdeAtN, mdeAtNMean, powerMean, powerProportion, relativeLiftProportions, sampleSizeMean, sampleSizeProportion, srm, twoProportionZ } from "../stats";
import { useTitle } from "../theme";

const num = (v: string, d: number) => { const n = Number(v); return v.trim() !== "" && Number.isFinite(n) ? n : d; };
const fmtK = (t: number): string => (t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : String(Math.round(t)));
const sign = (x: number): string => (x > 0 ? "+" : "");

/*
 * Every input lives in the URL query string (defaults are omitted), so a calculator can be shared or bookmarked.
 * Typing updates the fields immediately and the address bar shortly after (one history entry per pause, not per key).
 */
const DEFAULTS = {
  metric: "conversion", base: "0.10", std: "1", mde: "0.05", alpha: "0.05", power: "0.8", daily: "20000", // sample size + power at n
  n: "20000", // users per arm available (power at n / MDE at n)
  ca: "1000", na: "10000", cb: "1100", nb: "10000", zalpha: "0.05", // two-proportion z-test
  ua: "100000", ub: "101200", share: "0.5", // sample-ratio mismatch
} as const;
type Key = keyof typeof DEFAULTS;
type Values = Record<Key, string>;
const KEYS = Object.keys(DEFAULTS) as Key[];

function fromParams(p: URLSearchParams): Values {
  const out: Values = { ...DEFAULTS };
  for (const k of KEYS) { const v = p.get(k); if (v !== null) out[k] = v; }
  return out;
}
function toQuery(v: Values): string {
  const p = new URLSearchParams();
  for (const k of KEYS) if (v[k] !== DEFAULTS[k]) p.set(k, v[k]);
  return p.toString();
}

/** Form state mirrored into the URL query (debounced push); back/forward and pasted links flow back into the form. */
function useUrlState(): [Values, (patch: Partial<Values>) => void] {
  const [params, setParams] = useSearchParams();
  const [vals, setVals] = useState<Values>(() => fromParams(params));
  const latest = useRef(vals);
  const pushed = useRef(toQuery(fromParams(params)));
  const pending = useRef<number | null>(null);
  const setParamsRef = useRef(setParams);
  useEffect(() => { setParamsRef.current = setParams; }, [setParams]);
  useEffect(() => {
    const now = toQuery(fromParams(params));
    if (now === pushed.current) return; // our own push coming back round
    if (pending.current !== null) { window.clearTimeout(pending.current); pending.current = null; }
    pushed.current = now;
    latest.current = fromParams(params);
    setVals(latest.current);
  }, [params]);
  useEffect(() => () => { if (pending.current !== null) window.clearTimeout(pending.current); }, []);
  const update = useCallback((patch: Partial<Values>) => {
    const next: Values = { ...latest.current, ...patch };
    latest.current = next;
    setVals(next);
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      const q = toQuery(next);
      if (q === pushed.current) return;
      pushed.current = q;
      setParamsRef.current(new URLSearchParams(q));
    }, 250);
  }, []);
  return [vals, update];
}

const MDE_GRID = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15, 0.2];

export function CalculatorPage() {
  useTitle("Calculators — abkit");
  const [v, set] = useUrlState();
  const [copied, copy] = useCopy();
  const field = (k: Key) => (x: string) => { const patch: Partial<Values> = {}; patch[k] = x; set(patch); };

  // ---- plan (shared by the sample-size and power cards)
  const conv = v.metric !== "mean";
  const base = num(v.base, NaN), std = num(v.std, NaN), mde = num(v.mde, NaN), alpha = num(v.alpha, NaN), power = num(v.power, NaN), daily = num(v.daily, 1);
  const okCommon = Number.isFinite(mde) && mde !== 0 && alpha > 0 && alpha < 1 && power > 0.5 && power < 1;
  const okS = okCommon && (conv ? base > 0 && base < 1 && base * (1 + mde) > 0 && base * (1 + mde) < 1 : Number.isFinite(base) && base !== 0 && std > 0);
  const mdeAbs = base * mde;
  const sizeAt = (m: number): number => (conv ? sampleSizeProportion(base, m, alpha, power) : sampleSizeMean(std, base * m, alpha, power));
  const n = okS ? sizeAt(mde) : NaN;
  const curve = MDE_GRID.map((m) => ({ mde: `${Math.round(m * 100)}%`, perArm: okS && (!conv || base * (1 + m) < 1) ? sizeAt(m) : 0 }));
  const active = `${Math.round(mde * 100)}%`;

  // ---- power at n / MDE at n
  const nHave = num(v.n, NaN);
  const okP = okS && Number.isInteger(nHave) && nHave >= 1;
  const powerAt = (k: number): number => (conv ? powerProportion(base, mde, k, alpha) : powerMean(std, mdeAbs, k, alpha));
  const pAt = okP ? powerAt(nHave) : NaN;
  const mdeRelRaw = okP ? (conv ? mdeAtN(base, nHave, alpha, power) : mdeAtNMean(std, nHave, alpha, power) / Math.abs(base)) : NaN;
  // for a conversion metric the bisection tops out at a 100% treatment rate; report "unreachable" when even that falls short of the target power
  const mdeReachable = Number.isFinite(mdeRelRaw) && (!conv || powerProportion(base, mdeRelRaw, nHave, alpha) >= power - 1e-9);
  const mdeRelAt = mdeReachable ? mdeRelRaw : NaN;
  const powerCurve: { n: number; power: number }[] = [];
  if (okP) {
    const nMax = Math.ceil(Math.max(nHave * 1.25, Number.isFinite(n) ? n * 1.1 : 0, 50));
    for (let i = 1; i <= 48; i++) { const k = Math.max(1, Math.round((nMax * i) / 48)); powerCurve.push({ n: k, power: 100 * powerAt(k) }); }
  }

  // ---- two-proportion z-test
  const ca = num(v.ca, NaN), na = num(v.na, NaN), cb = num(v.cb, NaN), nb = num(v.nb, NaN), za = num(v.zalpha, NaN);
  const okZ = na > 0 && nb > 0 && ca >= 0 && cb >= 0 && ca <= na && cb <= nb && za > 0 && za < 1;
  const zr = okZ ? twoProportionZ(ca, na, cb, nb, za) : null;
  const rel = okZ ? relativeLiftProportions(ca, na, cb, nb, za) : null;

  // ---- sample-ratio mismatch
  const ua = num(v.ua, NaN), ub = num(v.ub, NaN), share = num(v.share, NaN);
  const okR = ua >= 0 && ub >= 0 && ua + ub > 0 && share > 0 && share < 1;
  const sr = okR ? srm([ua, ub], [share, 1 - share]) : null;

  const query = toQuery(v);
  const shareUrl = () => `${location.origin}${location.pathname}${query ? `?${query}` : ""}`;
  const ciPct = (a: number) => Math.round((1 - a) * 100);

  return (
    <Page
      eyebrow="Tools"
      title="Calculators"
      lede="Plan a test, check what a sample can detect, read a result, and verify the bucketing — the same formulas the Python package and the results pages use. Every input is kept in the address bar, so a calculator can be shared as a link."
      right={
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(shareUrl())} aria-live="polite">
          {copied ? <Check size={14} aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />} {copied ? "Link copied" : "Copy link to these inputs"}
        </button>
      }
    >
      <div className="grid md:grid-cols-2 gap-4">
        <Section className="rise" title="Sample size" sub={conv ? "Users per arm for a conversion-rate test (two-sided)." : "Users per arm to detect a relative change in a mean with known standard deviation (two-sided)."}>
          <Field label="Metric type">
            <select className="input" value={conv ? "conversion" : "mean"} onChange={(e) => set({ metric: e.target.value === "mean" ? "mean" : "conversion" })}>
              <option value="conversion">Conversion rate (binary per user)</option>
              <option value="mean">Mean (revenue, nights, …)</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <NumberField label={conv ? "Baseline rate" : "Baseline mean"} value={v.base} onChange={field("base")} min={conv ? 0.0001 : undefined} max={conv ? 0.9999 : undefined} hint={conv ? "0.10 means 10%" : "e.g. 412"} />
            {!conv && <NumberField label="Standard deviation" value={v.std} onChange={field("std")} min={0.000001} />}
            <NumberField label="MDE (relative)" value={v.mde} onChange={field("mde")} min={-0.99} max={10} hint="0.05 = +5% relative lift" />
            <NumberField label="Alpha" value={v.alpha} onChange={field("alpha")} min={0.0001} max={0.5} />
            <NumberField label="Power" value={v.power} onChange={field("power")} min={0.5} max={0.999} />
            <NumberField label="Daily users (for duration)" value={v.daily} onChange={field("daily")} min={1} integer />
          </div>
          <div className="mt-4 rounded-xl bg-bg2 border border-line p-4">
            <div className="mono text-3xl font-semibold leading-none" aria-live="polite">{Number.isFinite(n) ? n.toLocaleString() : "–"}</div>
            <div className="text-sm muted mt-1">per arm · {Number.isFinite(n) ? (2 * n).toLocaleString() : "–"} total · ≈ {Number.isFinite(n) ? Math.ceil((2 * n) / Math.max(1, daily)) : "–"} days</div>
            {okS ? (
              <div className="text-xs faint mt-1">detects {conv ? `${fmtPct(base, 1)} → ${fmtPct(base * (1 + mde), 2)}` : `${fmtNum(base)} → ${fmtNum(base * (1 + mde))} (${sign(mdeAbs)}${fmtNum(mdeAbs)} absolute)`} with {fmtPct(power, 0)} power at α = {alpha}</div>
            ) : (
              <div className="text-xs text-bad mt-1">{conv ? "Baseline and baseline × (1 + MDE) must stay between 0 and 1; MDE non-zero; α in (0, 1); power in (0.5, 1)." : "Baseline must be non-zero, standard deviation > 0, MDE non-zero; α in (0, 1); power in (0.5, 1)."}</div>
            )}
          </div>
          <div className="mt-4">
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={curve} margin={{ left: -4, right: 4, top: 4 }}>
                <XAxis dataKey="mde" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} scale="log" domain={["auto", "auto"]} width={56} tickFormatter={fmtK} allowDataOverflow />
                <Tooltip {...tooltipProps} formatter={(val: unknown) => [typeof val === "number" ? val.toLocaleString() : String(val), "per arm"]} labelFormatter={(l) => `MDE ${l}`} />
                <Bar dataKey="perArm" radius={3} isAnimationActive={false}>
                  {curve.map((c) => <Cell key={c.mde} fill={c.mde === active ? "var(--accent)" : "var(--chart-a)"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs faint mt-1">Per-arm sample size vs MDE (log scale) — halving the MDE quadruples the sample.</p>
          </div>
        </Section>

        <Section className="rise rise-d1" title="Power at n · MDE at n" sub="Uses the plan from the sample-size card. How much power does the sample you can actually get give you, and what is the smallest effect it can detect?">
          <NumberField label="Users per arm available" value={v.n} onChange={field("n")} min={1} integer hint="e.g. daily users × days ÷ 2" />
          <div className="mt-4 rounded-xl bg-bg2 border border-line p-4 grid sm:grid-cols-2 gap-3" aria-live="polite">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider faint">Power at n</div>
              <div className={`mono text-3xl font-semibold leading-none mt-1 ${Number.isFinite(pAt) ? (pAt >= power ? "text-ok" : "text-warn") : ""}`}>{Number.isFinite(pAt) ? fmtPct(pAt, 1) : "–"}</div>
              <div className="text-xs faint mt-1">{okP ? `to detect ${sign(mde)}${fmtPct(mde, 1)} relative${Number.isFinite(pAt) && pAt < power ? ` — below the ${fmtPct(power, 0)} target` : ""}` : "enter a valid plan and sample"}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider faint">MDE at n</div>
              <div className="mono text-3xl font-semibold leading-none mt-1">{Number.isFinite(mdeRelAt) ? `${fmtPct(mdeRelAt, 1)}` : "–"}</div>
              <div className="text-xs faint mt-1">{okP ? (Number.isFinite(mdeRelAt) ? `relative lift detectable with ${fmtPct(power, 0)} power${conv ? ` (${fmtPct(base, 1)} → ${fmtPct(base * (1 + mdeRelAt), 2)})` : ` (${fmtNum(Math.abs(base) * mdeRelAt)} absolute)`}` : `no effect reaches ${fmtPct(power, 0)} power at this sample`) : "enter a valid plan and sample"}</div>
            </div>
          </div>
          <div className="mt-4">
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={powerCurve} margin={{ left: -4, right: 12, top: 8 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="n" type="number" domain={["dataMin", "dataMax"]} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} tickFormatter={fmtK} />
                <YAxis domain={[0, 100]} unit="%" tick={axisTick} tickLine={false} axisLine={false} width={48} />
                <Tooltip {...tooltipProps} formatter={(val: unknown) => [typeof val === "number" ? `${val.toFixed(1)}%` : String(val), "power"]} labelFormatter={(l) => `${Number(l).toLocaleString()} per arm`} />
                {okP && <ReferenceLine y={100 * power} stroke="var(--warn)" strokeDasharray="4 4" label={{ value: `target ${fmtPct(power, 0)}`, fontSize: 10, fill: "var(--warn)", position: "insideBottomRight" }} />}
                {okP && <ReferenceLine x={nHave} stroke="var(--ink-3)" strokeDasharray="2 4" label={{ value: "your n", fontSize: 10, fill: "var(--ink-3)", position: "insideTopLeft" }} />}
                {okP && Number.isFinite(n) && <ReferenceLine x={n} stroke="var(--teal)" strokeDasharray="2 4" label={{ value: "planned", fontSize: 10, fill: "var(--teal)", position: "insideTopRight" }} />}
                <Line dataKey="power" stroke="var(--accent)" strokeWidth={2.2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <p className="text-xs faint mt-1">Power vs users per arm for the planned effect. Below the planned n, a “significant” result is more likely to overstate the true effect.</p>
          </div>
        </Section>

        <Section className="rise rise-d2" title="Two-proportion z-test" sub="Control A vs treatment B: pooled SE for the statistic, Wald interval for the absolute difference and a delta-method interval for the relative lift.">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="A conversions" value={v.ca} onChange={field("ca")} min={0} integer />
            <NumberField label="A visitors" value={v.na} onChange={field("na")} min={1} integer />
            <NumberField label="B conversions" value={v.cb} onChange={field("cb")} min={0} integer />
            <NumberField label="B visitors" value={v.nb} onChange={field("nb")} min={1} integer />
          </div>
          <div className="mt-3"><NumberField label="Alpha" value={v.zalpha} onChange={field("zalpha")} min={0.0001} max={0.5} /></div>
          <div className="mt-4 rounded-xl bg-bg2 border border-line p-4 text-sm grid gap-1.5 mono" aria-live="polite">
            {zr && rel ? (
              <>
                <div>{fmtPct(zr.rateA)} → {fmtPct(zr.rateB)} · lift <b>{sign(rel.lift)}{fmtPct(rel.lift)}</b></div>
                <div>z = {zr.z.toFixed(3)} · p = <b>{fmtP(zr.p)}</b></div>
                <div>{ciPct(za)}% CI, absolute: [{fmtPct(zr.ciLow)}, {fmtPct(zr.ciHigh)}]</div>
                <div>{ciPct(za)}% CI, relative (delta method): [{fmtPct(rel.lo)}, {fmtPct(rel.hi)}]</div>
                <div className={zr.significant ? "text-ok font-semibold" : "text-warn font-semibold"}>{zr.significant ? "Significant" : "Not significant"} at α = {za}</div>
              </>
            ) : (
              <div className="text-bad">Conversions must be between 0 and visitors; visitors &gt; 0; α in (0, 1).</div>
            )}
          </div>
        </Section>

        <Section className="rise rise-d3" title="Sample-ratio mismatch" sub="Chi-square test of arm sizes vs the intended split. p < 0.001 means the bucketing is broken.">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Users in A" value={v.ua} onChange={field("ua")} min={0} integer />
            <NumberField label="Users in B" value={v.ub} onChange={field("ub")} min={0} integer />
          </div>
          <div className="mt-3"><NumberField label="Intended share of A" value={v.share} onChange={field("share")} min={0.01} max={0.99} /></div>
          <div className="mt-4 rounded-xl bg-bg2 border border-line p-4 text-sm grid gap-1.5 mono" aria-live="polite">
            {sr ? (
              <>
                <div>expected {sr.expected.map((x) => Math.round(x).toLocaleString()).join(" / ")}</div>
                <div>χ² = {sr.chi2.toFixed(2)} · p = <b>{fmtP(sr.p)}</b></div>
                <div className={sr.mismatch ? "text-bad font-semibold" : "text-ok font-semibold"}>{sr.mismatch ? "Mismatch — investigate bucketing" : "No SRM at p < 0.001"}</div>
              </>
            ) : (
              <div className="text-bad">Counts must be non-negative and the share between 0 and 1.</div>
            )}
          </div>
        </Section>
      </div>
    </Page>
  );
}
