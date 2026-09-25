import { useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisTick, tooltipProps } from "../components/charts";
import { NumberField, Page, Section } from "../components/ui";
import { fmtP, fmtPct, sampleSizeProportion, srm, twoProportionZ } from "../stats";
import { useTitle } from "../theme";

const num = (v: string, d: number) => { const n = Number(v); return v.trim() !== "" && Number.isFinite(n) ? n : d; };

export function CalculatorPage() {
  useTitle("Calculators — abkit");
  const [s, setS] = useState({ base: "0.10", mde: "0.05", alpha: "0.05", power: "0.8", daily: "20000" });
  const [z, setZ] = useState({ ca: "1000", na: "10000", cb: "1100", nb: "10000", alpha: "0.05" });
  const [r, setR] = useState({ a: "100000", b: "101200", share: "0.5" });

  const base = num(s.base, 0.1), mde = num(s.mde, 0.05), alpha = num(s.alpha, 0.05), power = num(s.power, 0.8), daily = num(s.daily, 1);
  const okS = base > 0 && base < 1 && base * (1 + mde) > 0 && base * (1 + mde) < 1 && mde !== 0 && alpha > 0 && alpha < 1 && power > 0.5 && power < 1;
  const n = okS ? sampleSizeProportion(base, mde, alpha, power) : NaN;
  const curve = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15, 0.2].map((m) => ({ mde: `${Math.round(m * 100)}%`, perArm: okS ? sampleSizeProportion(base, m, alpha, power) : 0 }));
  const active = `${Math.round(mde * 100)}%`;

  const ca = num(z.ca, 0), na = num(z.na, 0), cb = num(z.cb, 0), nb = num(z.nb, 0), za = num(z.alpha, 0.05);
  const okZ = na > 0 && nb > 0 && ca >= 0 && cb >= 0 && ca <= na && cb <= nb && za > 0 && za < 1;
  const zr = okZ ? twoProportionZ(ca, na, cb, nb, za) : null;

  const ra = num(r.a, 0), rb = num(r.b, 0), share = num(r.share, 0.5);
  const okR = ra >= 0 && rb >= 0 && ra + rb > 0 && share > 0 && share < 1;
  const sr = okR ? srm([ra, rb], [share, 1 - share]) : null;

  return (
    <Page eyebrow="Tools" title="Calculators" lede="Plan a test, read a result, and check the bucketing — the same formulas the Python package and the results pages use.">
      <div className="grid lg:grid-cols-3 gap-4">
        <Section className="rise" title="Sample size" sub="Users per arm for a conversion-rate test (two-sided).">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Baseline rate" value={s.base} onChange={(v) => setS({ ...s, base: v })} min={0.0001} max={0.9999} />
            <NumberField label="MDE (relative)" value={s.mde} onChange={(v) => setS({ ...s, mde: v })} min={-0.99} max={10} />
            <NumberField label="Alpha" value={s.alpha} onChange={(v) => setS({ ...s, alpha: v })} min={0.0001} max={0.5} />
            <NumberField label="Power" value={s.power} onChange={(v) => setS({ ...s, power: v })} min={0.5} max={0.999} />
          </div>
          <div className="mt-3"><NumberField label="Daily users (for duration)" value={s.daily} onChange={(v) => setS({ ...s, daily: v })} min={1} integer /></div>
          <div className="mt-4 rounded-xl bg-bg2 border border-line p-4">
            <div className="mono text-3xl font-semibold leading-none" aria-live="polite">{Number.isFinite(n) ? n.toLocaleString() : "–"}</div>
            <div className="text-sm muted mt-1">per arm · {Number.isFinite(n) ? (2 * n).toLocaleString() : "–"} total · ≈ {Number.isFinite(n) ? Math.ceil((2 * n) / Math.max(1, daily)) : "–"} days</div>
            {okS && <div className="text-xs faint mt-1">detects {fmtPct(base, 1)} → {fmtPct(base * (1 + mde), 2)}</div>}
          </div>
          <div className="mt-4">
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={curve} margin={{ left: -4, right: 4, top: 4 }}>
                <XAxis dataKey="mde" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} scale="log" domain={["auto", "auto"]} width={56} tickFormatter={(t: number) => (t >= 1000 ? `${Math.round(t / 1000)}k` : String(t))} allowDataOverflow />
                <Tooltip {...tooltipProps} formatter={(val: unknown) => [typeof val === "number" ? val.toLocaleString() : String(val), "per arm"]} labelFormatter={(l) => `MDE ${l}`} />
                <Bar dataKey="perArm" radius={3} isAnimationActive={false}>
                  {curve.map((c) => <Cell key={c.mde} fill={c.mde === active ? "var(--accent)" : "var(--chart-a)"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs faint mt-1">Per-arm sample size vs MDE (log scale) — halving the MDE quadruples the sample.</p>
          </div>
        </Section>

        <Section className="rise rise-d1" title="Two-proportion z-test" sub="Control A vs treatment B, pooled SE for the statistic and a Wald interval for the difference.">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="A conversions" value={z.ca} onChange={(v) => setZ({ ...z, ca: v })} min={0} integer />
            <NumberField label="A visitors" value={z.na} onChange={(v) => setZ({ ...z, na: v })} min={1} integer />
            <NumberField label="B conversions" value={z.cb} onChange={(v) => setZ({ ...z, cb: v })} min={0} integer />
            <NumberField label="B visitors" value={z.nb} onChange={(v) => setZ({ ...z, nb: v })} min={1} integer />
          </div>
          <div className="mt-3"><NumberField label="Alpha" value={z.alpha} onChange={(v) => setZ({ ...z, alpha: v })} min={0.0001} max={0.5} /></div>
          <div className="mt-4 rounded-xl bg-bg2 border border-line p-4 text-sm grid gap-1.5 mono" aria-live="polite">
            {zr ? (
              <>
                <div>{fmtPct(zr.rateA)} → {fmtPct(zr.rateB)} · lift <b>{zr.liftRel > 0 ? "+" : ""}{fmtPct(zr.liftRel)}</b></div>
                <div>z = {zr.z.toFixed(3)} · p = <b>{fmtP(zr.p)}</b></div>
                <div>{Math.round((1 - za) * 100)}% CI (abs): [{fmtPct(zr.ciLow)}, {fmtPct(zr.ciHigh)}]</div>
                <div className={zr.significant ? "text-ok font-semibold" : "text-warn font-semibold"}>{zr.significant ? "Significant" : "Not significant"} at α = {za}</div>
              </>
            ) : (
              <div className="text-bad">Conversions must be between 0 and visitors; visitors &gt; 0.</div>
            )}
          </div>
        </Section>

        <Section className="rise rise-d2" title="Sample-ratio mismatch" sub="Chi-square test of arm sizes vs the intended split. p < 0.001 means the bucketing is broken.">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Users in A" value={r.a} onChange={(v) => setR({ ...r, a: v })} min={0} integer />
            <NumberField label="Users in B" value={r.b} onChange={(v) => setR({ ...r, b: v })} min={0} integer />
          </div>
          <div className="mt-3"><NumberField label="Intended share of A" value={r.share} onChange={(v) => setR({ ...r, share: v })} min={0.01} max={0.99} /></div>
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
