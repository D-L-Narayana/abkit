import { AlertTriangle, Check, Copy, Download } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { IntervalBar, Legend, axisTick, gridProps, tooltipProps } from "../components/charts";
import { EmptyState, Page, Section, Stat, toneChip, useCopy } from "../components/ui";
import { P_PLOT_FLOOR, analyse, verdict } from "../lib/analysis";
import { decodeShare, encodeShare, loadExperiments, type Experiment } from "../model";
import { fmtNum, fmtP, fmtPct, holm } from "../stats";
import { useTitle } from "../theme";

function exportCsv(e: Experiment) {
  const conv = e.metricType === "conversion";
  const rows = [["day", "nA", "nB", conv ? "convA" : "sumA", conv ? "convB" : "sumB"], ...e.days.map((d) => [d.day, d.nA, d.nB, conv ? d.convA : d.sumsA.sy.toFixed(2), conv ? d.convB : d.sumsB.sy.toFixed(2)])];
  const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${e.id}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Results({ shared }: { shared?: boolean }) {
  const { id = "" } = useParams();
  const [copied, copy] = useCopy();
  const e = useMemo(() => (shared ? decodeShare(id) : loadExperiments().find((x) => x.id === id) ?? null), [id, shared]);
  useTitle(e ? `${e.name} — abkit` : "Experiment not found — abkit");
  if (!e) {
    return (
      <Page eyebrow="Results" title="Experiment not found">
        <EmptyState title="This link doesn't match an experiment in this browser" body="Experiments live in local storage. Ask for a share link instead — it carries the full result in the URL." action={<Link className="btn btn-primary btn-sm" to="/">Back to experiments</Link>} />
      </Page>
    );
  }
  const an = analyse(e);
  if (!an) return null;
  const v = verdict(e, an);
  const shareUrl = `${location.origin}/share/${encodeShare(e)}`;
  const holmRes = an.kind === "conversion" ? holm([an.z.p, an.srm.p]) : holm([an.raw.p, an.adj.p]);
  const ciPct = Math.round((1 - e.alpha) * 100);
  const pTicks = [1, 0.1, 0.01, 0.001, P_PLOT_FLOOR];
  const pointLabel = (val: unknown, name: unknown) => (typeof val === "number" ? [`${val.toFixed(2)}%`, String(name)] : Array.isArray(val) ? [`${val.map((x: number) => x.toFixed(2)).join("% … ")}%`, String(name)] : [String(val), String(name)]);

  return (
    <Page
      eyebrow={shared ? "Shared result · read-only" : "Results"}
      title={e.name}
      lede={e.hypothesis || undefined}
      right={
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(shareUrl)} aria-live="polite">
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied ? "Link copied" : "Share link"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => exportCsv(e)}><Download size={14} aria-hidden="true" /> CSV</button>
        </>
      }
    >
      {an.srm.mismatch && (
        <div role="alert" className="card p-4 mb-4 flex gap-3 items-start border-bad/40 bg-bad-soft text-bad-ink">
          <AlertTriangle className="shrink-0 mt-0.5" size={18} aria-hidden="true" />
          <div className="text-sm">
            <strong>Sample-ratio mismatch.</strong> Expected a {fmtPct(e.split, 0)} / {fmtPct(1 - e.split, 0)} split but observed {an.last.nA.toLocaleString()} / {an.last.nB.toLocaleString()} (χ² = {an.srm.chi2.toFixed(1)}, p = {fmtP(an.srm.p)}). Assignment or logging is broken — do not act on any metric below until it is fixed.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 rise">
        <Stat label="Verdict" value={v.label} tone={v.tone} hint={`α = ${e.alpha} · ${e.days.length} days · ${(an.last.nA + an.last.nB).toLocaleString()} users`} />
        <Stat label="Relative lift" value={`${v.lift > 0 ? "+" : ""}${fmtPct(v.lift)}`} tone={v.lift > 0 ? "ok" : v.lift < 0 ? "bad" : "neutral"} hint={an.kind === "conversion" ? `${fmtPct(an.z.rateA)} → ${fmtPct(an.z.rateB)}` : `${fmtNum(an.a.mean)} → ${fmtNum(an.b.mean)} · CUPED-adjusted`} />
        <Stat label="p-value" value={fmtP(v.p)} hint={an.kind === "conversion" ? `z = ${an.z.z.toFixed(2)} · two-sided` : `Welch t · CUPED-adjusted · raw p = ${fmtP(an.raw.p)}`} />
        <Stat label="Sample progress" value={`${Math.round(an.progress * 100)}%`} hint={`${Math.min(an.last.nA, an.last.nB).toLocaleString()} / ${e.plannedPerArm.toLocaleString()} per arm planned`} tone={an.progress >= 1 ? "ok" : "neutral"} />
      </div>
      <p className="text-sm muted mt-3">{v.reason}</p>

      <div className="grid lg:grid-cols-3 gap-4 mt-5">
        <Section className="lg:col-span-2 rise rise-d1" title={`Relative lift over time · ${ciPct}% confidence interval`} sub={`Cumulative estimate by day. Early days swing widely — decide at the planned sample size, not when the band first clears zero.${an.kind === "continuous" ? " The dashed band is the CUPED-adjusted interval." : ""}`}>
          <Legend items={[{ color: "var(--accent)", label: "Relative lift" }, { color: "var(--accent)", label: `${ciPct}% CI`, area: true }, ...(an.kind === "continuous" ? [{ color: "var(--teal)", label: "CUPED-adjusted CI", dashed: true, area: true }] : []), { color: "var(--warn)", label: "MDE", dashed: true }]} />
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={an.series} margin={{ left: -6, right: 12, top: 8 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="day" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} label={{ value: "day", position: "insideBottomRight", fontSize: 11, fill: "var(--ink-3)", dy: 10 }} />
              <YAxis unit="%" tick={axisTick} tickLine={false} axisLine={false} width={52} />
              <Tooltip {...tooltipProps} formatter={pointLabel} labelFormatter={(d) => `Day ${d}`} />
              <ReferenceLine y={0} stroke="var(--ink-3)" />
              <ReferenceLine y={100 * e.mdeRel} stroke="var(--warn)" strokeDasharray="4 4" label={{ value: "MDE", fontSize: 10, fill: "var(--warn)", position: "insideTopLeft" }} />
              <Area dataKey="band" stroke="none" fill="var(--accent)" fillOpacity={0.14} name={`${ciPct}% CI`} isAnimationActive={false} />
              {an.kind === "continuous" && <Area dataKey="cband" stroke="var(--teal)" strokeDasharray="4 3" fill="var(--teal)" fillOpacity={0.08} name="CUPED CI" isAnimationActive={false} />}
              <Line dataKey="lift" stroke="var(--accent)" strokeWidth={2.2} dot={false} name="lift" isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Section>
        <Section className="rise rise-d2" title="Sequential p-value" sub="Peeking every day and stopping at the first p < α inflates false positives to ~19% (see Docs). Log scale; the line is for monitoring, not decisions.">
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={an.series} margin={{ left: -6, right: 12, top: 14 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="day" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} />
              <YAxis scale="log" domain={[P_PLOT_FLOOR, 1]} ticks={pTicks} tick={axisTick} tickLine={false} axisLine={false} width={52} tickFormatter={(t: number) => (t < 0.001 ? t.toExponential(0) : String(t))} />
              <Tooltip {...tooltipProps} formatter={(_: unknown, __: unknown, item: { payload?: { p: number; pc?: number } }) => [fmtP(item.payload?.pc ?? item.payload?.p ?? NaN), "p-value"]} labelFormatter={(d) => `Day ${d}`} />
              <ReferenceLine y={e.alpha} stroke="var(--bad)" strokeDasharray="4 4" label={{ value: `α = ${e.alpha}`, fontSize: 10, fill: "var(--bad)", position: "insideTopRight" }} />
              <Area dataKey="pPlot" stroke="var(--bad)" strokeWidth={2} fill="var(--bad)" fillOpacity={0.1} name="p" isAnimationActive={false} baseValue={P_PLOT_FLOOR} dot={{ r: 2, fill: "var(--bad)", stroke: "none" }} activeDot={{ r: 4 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Section className="rise rise-d2" title={`Daily ${e.metricType === "conversion" ? "conversion rate" : "mean"} by arm`}>
          <Legend items={[{ color: "var(--chart-a)", label: "A · control" }, { color: "var(--accent)", label: "B · treatment" }]} />
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={an.daily} margin={{ left: -6, right: 12, top: 4 }} barGap={2}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="day" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} unit={e.metricType === "conversion" ? "%" : ""} width={52} />
              <Tooltip {...tooltipProps} formatter={(val: unknown) => (typeof val === "number" ? val.toFixed(2) : String(val))} labelFormatter={(d) => `Day ${d}`} />
              <Bar dataKey="A" fill="var(--chart-a)" radius={[3, 3, 0, 0]} name="A (control)" isAnimationActive={false} />
              <Bar dataKey="B" fill="var(--accent)" radius={[3, 3, 0, 0]} name="B (treatment)" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Section>
        <Section className="rise rise-d3" title="Arms & guardrails">
          <div className="overflow-x-auto -mx-2">
            <table className="data mt-1">
              <thead><tr><th scope="col">Arm</th><th scope="col" className="text-right">Users</th><th scope="col" className="text-right">{e.metricType === "conversion" ? "Conversions" : "Mean"}</th><th scope="col" className="text-right">{e.metricType === "conversion" ? "Rate" : "Std"}</th></tr></thead>
              <tbody>
                <tr><td>A · control</td><td className="text-right mono">{an.last.nA.toLocaleString()}</td><td className="text-right mono">{an.kind === "conversion" ? an.last.convA.toLocaleString() : fmtNum(an.a.mean)}</td><td className="text-right mono">{an.kind === "conversion" ? fmtPct(an.z.rateA) : fmtNum(Math.sqrt(an.a.var))}</td></tr>
                <tr><td>B · treatment</td><td className="text-right mono">{an.last.nB.toLocaleString()}</td><td className="text-right mono">{an.kind === "conversion" ? an.last.convB.toLocaleString() : fmtNum(an.b.mean)}</td><td className="text-right mono">{an.kind === "conversion" ? fmtPct(an.z.rateB) : fmtNum(Math.sqrt(an.b.var))}</td></tr>
              </tbody>
            </table>
          </div>
          <dl className="grid gap-2 text-sm mt-4">
            <Row k="Sample-ratio check" v={<span className={an.srm.mismatch ? "text-bad font-semibold" : "text-ok"}>χ² {an.srm.chi2.toFixed(2)} · p {fmtP(an.srm.p)}</span>} />
            <Row k={`Absolute difference · ${ciPct}% CI`} v={an.kind === "conversion" ? `${(100 * an.z.liftAbs).toFixed(2)} pt [${(100 * an.z.ciLow).toFixed(2)}, ${(100 * an.z.ciHigh).toFixed(2)}]` : `${fmtNum(an.adj.diff)} [${fmtNum(an.adj.ciLow)}, ${fmtNum(an.adj.ciHigh)}]`} />
            <Row k="Holm correction (2 tests)" v={holmRes.map((h) => (h ? "reject" : "keep")).join(" · ")} />
            {an.kind === "continuous" && (
              <>
                <Row k="CUPED θ · variance removed" v={<span className="text-teal">{an.cuped.theta.toFixed(3)} · {fmtPct(an.cuped.varianceReduction, 1)}</span>} />
                <Row k="CI width raw → CUPED" v={`${fmtNum(an.raw.ciHigh - an.raw.ciLow)} → ${fmtNum(an.adj.ciHigh - an.adj.ciLow)}`} />
              </>
            )}
          </dl>
        </Section>
      </div>

      {an.kind === "continuous" && (
        <Section className="mt-4 rise rise-d3" title="CUPED — before and after" sub="The pre-period covariate (last month's spend) is correlated with the metric, so subtracting θ·(x − x̄) removes variance the treatment could not have caused. The estimate stays unbiased; the interval shrinks. Both intervals below share one axis.">
          {(() => {
            const lo = Math.min(0, an.raw.ciLow, an.adj.ciLow), hi = Math.max(0, an.raw.ciHigh, an.adj.ciHigh);
            const pad = (hi - lo) * 0.08;
            const domain: [number, number] = [lo - pad, hi + pad];
            return (
              <div className="grid sm:grid-cols-2 gap-4">
                {[{ t: "Raw", r: an.raw, c: "var(--chart-a)" }, { t: "CUPED-adjusted", r: an.adj, c: "var(--teal)" }].map(({ t, r, c }) => (
                  <div key={t} className="rounded-xl border border-line p-4 grid gap-3">
                    <div className="flex justify-between items-baseline gap-2">
                      <span className="font-medium">{t}</span>
                      <span className={`chip ${r.significant ? toneChip.ok : toneChip.warn}`}>{r.significant ? "significant" : "not significant"}</span>
                    </div>
                    <div className="mono text-2xl leading-none">{r.diff > 0 ? "+" : ""}{fmtNum(r.diff)} <span className="text-sm faint">({r.liftRel > 0 ? "+" : ""}{fmtPct(r.liftRel)})</span></div>
                    <IntervalBar lo={r.ciLow} hi={r.ciHigh} est={r.diff} domain={domain} color={c} />
                    <div className="mono text-xs faint">CI [{fmtNum(r.ciLow)}, {fmtNum(r.ciHigh)}] · p {fmtP(r.p)} · df {r.df.toFixed(0)}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>
      )}
    </Page>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
      <dt className="faint">{k}</dt>
      <dd className="mono text-right">{v}</dd>
    </div>
  );
}
