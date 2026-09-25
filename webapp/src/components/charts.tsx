import type { ReactNode } from "react";

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
