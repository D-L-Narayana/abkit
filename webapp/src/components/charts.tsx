import type { ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtP } from "../stats";

/** Shared Recharts styling that follows the current theme via CSS variables. */
export const axisTick = { fontSize: 11, fill: "var(--ink-3)" } as const;
export const gridProps = { stroke: "var(--chart-grid)", strokeDasharray: "3 3", vertical: false } as const;
export const tooltipProps = {
  contentStyle: { background: "var(--card)", border: "1px solid var(--line-strong)", borderRadius: 12, fontSize: 12, color: "var(--ink)", boxShadow: "var(--shadow)", padding: "8px 12px" },
  labelStyle: { color: "var(--ink-2)", fontWeight: 600, marginBottom: 4 },
  itemStyle: { color: "var(--ink)", padding: 0 },
  cursor: { stroke: "var(--line-strong)", fill: "var(--bg-2)", fillOpacity: 0.5 },
} as const;

export function Legend({ items }: { items: { color: string; label: string; dashed?: boolean; area?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs muted mb-2" aria-label="Legend">
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          {it.area ? (
            <span aria-hidden="true" className="inline-block w-4 h-2.5 rounded-sm" style={{ background: it.color, opacity: 0.35 }} />
          ) : (
            <span aria-hidden="true" className="inline-block w-4 h-0 border-t-2" style={{ borderColor: it.color, borderTopStyle: it.dashed ? "dashed" : "solid" }} />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Confidence interval drawn on a shared axis. `domain` lets several bars share the same scale so
 * they can be compared directly (e.g. raw vs CUPED-adjusted).
 */
export function IntervalBar({ lo, hi, est, domain, color = "var(--accent)", label }: { lo: number; hi: number; est: number; domain: [number, number]; color?: string; label?: ReactNode }) {
  const [d0, d1] = domain;
  const span = Math.max(1e-12, d1 - d0);
  const pct = (x: number) => `${Math.max(0, Math.min(100, ((x - d0) / span) * 100))}%`;
  const zeroInside = d0 < 0 && d1 > 0;
  return (
    <div className="grid gap-1">
      {label && <div className="flex justify-between text-xs faint">{label}</div>}
      <div className="relative h-6" role="img" aria-label={`Estimate ${est.toFixed(2)}, interval ${lo.toFixed(2)} to ${hi.toFixed(2)}`}>
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-bg3" />
        {zeroInside && <div className="absolute top-0 bottom-0 w-px bg-ink3" style={{ left: pct(0) }} title="0" />}
        <div className="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-full" style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})`, background: color, opacity: 0.55 }} />
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-3.5 rounded-full border-2 border-card" style={{ left: pct(est), background: color }} />
      </div>
      <div className="relative h-4 text-[11px] faint mono">
        <span className="absolute left-0">{d0.toFixed(1)}</span>
        {zeroInside && <span className="absolute -translate-x-1/2" style={{ left: pct(0) }}>0</span>}
        <span className="absolute right-0">{d1.toFixed(1)}</span>
      </div>
    </div>
  );
}

/** One cumulative look (day) of a sequential monitor; `*Plot` values are clamped to [floor, 1] for the log axis. */
export interface PValuePoint {
  day: number;
  /** Fixed-horizon p recomputed at this look (naive repeated testing). */
  p: number;
  pPlot: number;
  /** CUPED-adjusted fixed-horizon p (continuous metrics). */
  pc?: number;
  /** Always-valid p (mixture SPRT) — may be read at every look. */
  pAV?: number;
  pAVPlot?: number;
}

/**
 * Sequential p-values on a log axis: the naive fixed-horizon p (muted, dashed — for monitoring only, reading it daily
 * inflates false positives) overlaid with the always-valid p (strong — valid under continuous monitoring), the α line
 * and a marker on the first day the always-valid p crossed α.
 */
export function PValueChart({ series, alpha, floor = 1e-4, decidedDay = null, height = 280, naiveLabel = "Fixed-horizon p (naive, monitoring only)", avLabel = "Always-valid p (mSPRT)" }: {
  series: PValuePoint[];
  alpha: number;
  /** Lower bound of the log axis (matches the clamping applied to `pPlot` / `pAVPlot`). */
  floor?: number;
  /** 1-based day on which the always-valid p first fell below α, or null. */
  decidedDay?: number | null;
  height?: number;
  naiveLabel?: string;
  avLabel?: string;
}) {
  const hasAV = series.some((s) => typeof s.pAVPlot === "number" && Number.isFinite(s.pAVPlot));
  // Non-finite values become gaps (undefined) so Recharts never receives NaN coordinates.
  const data = series.map((s) => ({ ...s, pPlot: Number.isFinite(s.pPlot) ? s.pPlot : 1, pAVPlot: typeof s.pAVPlot === "number" && Number.isFinite(s.pAVPlot) ? s.pAVPlot : undefined }));
  const last = series[series.length - 1];
  const decided = hasAV && decidedDay !== null ? data.find((s) => s.day === decidedDay && typeof s.pAVPlot === "number") : undefined;
  const clamp = (p: number) => Math.max(floor, Math.min(1, p));
  const ticks = [1, 0.1, 0.01, 0.001, 1e-4, 1e-5, 1e-6].filter((t) => t >= floor);
  if (!ticks.includes(floor)) ticks.push(floor);
  const description = last
    ? `Sequential p-values by day. ${hasAV ? `Final always-valid p ${fmtP(last.pAV ?? NaN)}, ` : ""}final fixed-horizon p ${fmtP(last.pc ?? last.p)}, α = ${alpha}${decided ? `, always-valid p crossed α on day ${decided.day}` : hasAV ? ", always-valid p has not crossed α" : ""}.`
    : "Sequential p-values by day: no data yet.";
  const formatter = (val: unknown, name: unknown, item: { dataKey?: unknown; payload?: PValuePoint }) => {
    const pt = item.payload;
    const real = String(item.dataKey) === "pAVPlot" ? pt?.pAV : (pt?.pc ?? pt?.p);
    return [fmtP(typeof real === "number" ? real : typeof val === "number" ? val : NaN), String(name)] as [string, string];
  };
  return (
    <div>
      <Legend
        items={[
          { color: hasAV ? "var(--ink-3)" : "var(--bad)", label: naiveLabel, dashed: hasAV },
          ...(hasAV ? [{ color: "var(--accent)", label: avLabel, area: true }] : []),
          { color: "var(--bad)", label: `α = ${alpha}`, dashed: true },
        ]}
      />
      <div>
        <p className="sr-only">{description}</p>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={data} margin={{ left: -6, right: 12, top: 14 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="day" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} />
            <YAxis scale="log" domain={[floor, 1]} ticks={ticks} tick={axisTick} tickLine={false} axisLine={false} width={52} tickFormatter={(t: number) => (t < 0.001 ? t.toExponential(0) : String(t))} allowDataOverflow />
            <Tooltip {...tooltipProps} formatter={formatter} labelFormatter={(d) => `Day ${d}`} />
            <ReferenceLine y={alpha} stroke="var(--bad)" strokeDasharray="4 4" label={{ value: `α = ${alpha}`, fontSize: 10, fill: "var(--bad)", position: "insideTopRight" }} />
            {decided && <ReferenceLine x={decided.day} stroke="var(--accent)" strokeDasharray="2 4" />}
            <Line dataKey="pPlot" name={naiveLabel} stroke={hasAV ? "var(--ink-3)" : "var(--bad)"} strokeWidth={hasAV ? 1.5 : 2} strokeDasharray={hasAV ? "4 3" : undefined} dot={hasAV ? false : { r: 2, fill: "var(--bad)", stroke: "none" }} activeDot={{ r: 4 }} isAnimationActive={false} />
            {hasAV && <Area dataKey="pAVPlot" name={avLabel} stroke="var(--accent)" strokeWidth={2.4} fill="var(--accent)" fillOpacity={0.1} baseValue={floor} dot={{ r: 2.5, fill: "var(--accent)", stroke: "none" }} activeDot={{ r: 4 }} isAnimationActive={false} />}
            {decided && typeof decided.pAVPlot === "number" && (
              <ReferenceDot x={decided.day} y={clamp(decided.pAVPlot)} r={6} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} label={{ value: `decision · day ${decided.day}`, position: "top", fontSize: 10, fill: "var(--accent-text)" }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
