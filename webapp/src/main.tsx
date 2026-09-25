import { AlertTriangle, ArrowRight, Calculator, Check, Copy, FlaskConical, ListOrdered, Moon, Plus, Sun, Trash2, Upload, BookOpen, Download } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BrowserRouter, Link, NavLink, Outlet, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { cumulative, decodeShare, encodeShare, loadExperiments, parseCsv, remove, simulate, upsert, type Experiment } from "./model";
import { cuped, fmtNum, fmtP, fmtPct, holm, meanVar, mrr, mulberry32, ndcgAtK, precisionAtK, sampleSizeMean, sampleSizeProportion, srm, teamDraft, twoProportionZ, welch } from "./stats";
import "./index.css";

/* ---------------- shared ---------------- */
function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold text-[1.15rem] tracking-tight">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-label="abkit" role="img" fill="none">
        <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="currentColor" strokeWidth="1.5" className="text-accent" />
        <path d="M8 22l5-12 5 12M10.5 17h5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="text-accent" />
        <path d="M20 10h3.5a3 3 0 010 6H20zM20 16h4a3 3 0 010 6h-4z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" className="text-ink" />
      </svg>
      abkit
    </span>
  );
}
function ThemeToggle() {
  const [t, setT] = useState<"light" | "dark">(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  useEffect(() => { document.documentElement.dataset.theme = t; try { localStorage.setItem("abkit-theme", t); } catch { /* ignore */ } }, [t]);
  return <button className="btn btn-ghost btn-sm w-9 px-0" onClick={() => setT(t === "dark" ? "light" : "dark")} aria-label="Toggle theme">{t === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button>;
}
const NAV = [["/", "Experiments", FlaskConical], ["/calculator", "Calculator", Calculator], ["/ranking", "Ranking lab", ListOrdered], ["/docs", "Docs", BookOpen]] as const;
function Layout() {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-40 bg-bg/85 backdrop-blur border-b border-line">
        <div className="wrap h-14 flex items-center justify-between gap-3">
          <Link to="/" aria-label="abkit home"><Logo /></Link>
          <nav className="hidden md:flex gap-1" aria-label="Primary">
            {NAV.map(([to, label, Icon]) => (
              <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `h-9 px-3 inline-flex items-center gap-1.5 rounded-lg text-sm font-medium ${isActive ? "bg-accent-soft" : "text-ink2 hover:bg-bg2"}`}><Icon size={15} />{label}</NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/new" className="btn btn-primary btn-sm"><Plus size={15} /> New experiment</Link>
            <a href="https://github.com/D-L-Narayana/abkit" className="btn btn-ghost btn-sm hidden sm:inline-flex" rel="noopener">GitHub</a>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="flex-1 pb-20 md:pb-0"><Outlet /></main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-card/95 backdrop-blur border-t border-line grid grid-cols-4" aria-label="Mobile">
        {NAV.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `h-14 flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${isActive ? "text-accent" : "text-ink2"}`}><Icon size={17} />{label}</NavLink>)}
      </nav>
      <footer className="border-t border-line"><div className="wrap py-8 text-sm faint flex flex-wrap justify-between gap-3"><span>abkit — open-source experimentation toolkit by <a className="text-accent" href="https://github.com/D-L-Narayana">D L Narayana</a>. All experiments here are simulated or uploaded by you and stay in your browser.</span><span>Python package + this app: <a className="text-accent" href="https://github.com/D-L-Narayana/abkit">github.com/D-L-Narayana/abkit</a></span></div></footer>
    </div>
  );
}
function Page({ eyebrow, title, right, children }: { eyebrow: string; title: string; right?: ReactNode; children: ReactNode }) {
  return <div className="wrap py-7"><div className="flex flex-wrap items-end justify-between gap-3 mb-6"><div><span className="text-xs font-bold uppercase tracking-[.12em] text-accent">{eyebrow}</span><h1 className="text-[clamp(1.4rem,1.1rem+1vw,1.9rem)] mt-1">{title}</h1></div>{right}</div>{children}</div>;
}
function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "bad" | "warn" }) {
  return <div className="card p-4"><div className="text-[11px] font-semibold uppercase tracking-wider faint">{label}</div><div className={`mono text-xl sm:text-2xl font-semibold mt-1 text-balance ${tone === "ok" ? "text-ok" : tone === "bad" ? "text-rose" : tone === "warn" ? "text-amber" : ""}`}>{value}</div>{hint && <div className="text-xs faint mt-1">{hint}</div>}</div>;
}
const tip = { contentStyle: { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12 } };
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="block"><span className="label">{label}</span>{children}{hint && <span className="text-xs faint mt-1 block">{hint}</span>}</label>; }
const num = (v: string, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ---------------- analysis ---------------- */
function analyse(e: Experiment) {
  const cum = cumulative(e.days);
  const last = cum[cum.length - 1];
  if (!last) return null;
  const srmRes = srm([last.nA, last.nB], [e.split, 1 - e.split]);
  if (e.metricType === "conversion") {
    const z = twoProportionZ(last.convA, last.nA, last.convB, last.nB, e.alpha);
    const series = cum.map((d) => { const r = twoProportionZ(d.convA, d.nA, d.convB, d.nB, e.alpha); return { day: d.day, lift: 100 * r.liftRel, lo: 100 * (r.ciLow / r.rateA), hi: 100 * (r.ciHigh / r.rateA), p: r.p, n: d.nA + d.nB }; });
    const daily = e.days.map((d) => ({ day: d.day, A: 100 * (d.convA / Math.max(1, d.nA)), B: 100 * (d.convB / Math.max(1, d.nB)) }));
    return { kind: "conversion" as const, last, srm: srmRes, z, series, daily, progress: Math.min(1, Math.min(last.nA, last.nB) / Math.max(1, e.plannedPerArm)) };
  }
  const a = meanVar(last.sumsA), b = meanVar(last.sumsB);
  const raw = welch(a, b, e.alpha);
  const c = cuped(last.sumsA, last.sumsB);
  const adj = welch(c.adjA, c.adjB, e.alpha);
  const series = cum.map((d) => { const r = welch(meanVar(d.sumsA), meanVar(d.sumsB), e.alpha); const cc = cuped(d.sumsA, d.sumsB); const ra = welch(cc.adjA, cc.adjB, e.alpha); return { day: d.day, lift: 100 * r.liftRel, lo: 100 * (r.ciLow / (d.sumsA.sy / d.sumsA.n)), hi: 100 * (r.ciHigh / (d.sumsA.sy / d.sumsA.n)), cLo: 100 * (ra.ciLow / (d.sumsA.sy / d.sumsA.n)), cHi: 100 * (ra.ciHigh / (d.sumsA.sy / d.sumsA.n)), p: r.p, pc: ra.p, n: d.nA + d.nB }; });
  const daily = e.days.map((d) => ({ day: d.day, A: d.sumsA.sy / Math.max(1, d.nA), B: d.sumsB.sy / Math.max(1, d.nB) }));
  return { kind: "continuous" as const, last, srm: srmRes, a, b, raw, cuped: c, adj, series, daily, progress: Math.min(1, Math.min(last.nA, last.nB) / Math.max(1, e.plannedPerArm)) };
}
type Analysis = NonNullable<ReturnType<typeof analyse>>;
function verdict(e: Experiment, an: Analysis): { label: string; tone: "ok" | "bad" | "warn" | "neutral"; p: number; lift: number } {
  const p = an.kind === "conversion" ? an.z.p : an.adj.p;
  const lift = an.kind === "conversion" ? an.z.liftRel : an.adj.liftRel;
  if (an.srm.mismatch) return { label: "SRM — invalid", tone: "bad", p, lift };
  if (an.progress < 1 && e.status === "running") return { label: `Collecting · ${Math.round(an.progress * 100)}%`, tone: "neutral", p, lift };
  if (p < e.alpha) return lift > 0 ? { label: "Winner", tone: "ok", p, lift } : { label: "Loser", tone: "bad", p, lift };
  return { label: "No significant effect", tone: "warn", p, lift };
}

/* ---------------- Dashboard ---------------- */
function Dashboard() {
  const [list, setList] = useState<Experiment[]>(() => loadExperiments());
  useEffect(() => { document.title = "Experiments — abkit"; }, []);
  const rows = list.map((e) => ({ e, an: analyse(e) }));
  const running = rows.filter((r) => r.e.status === "running").length;
  const winners = rows.filter((r) => r.an && verdict(r.e, r.an).label === "Winner").length;
  const srms = rows.filter((r) => r.an?.srm.mismatch).length;
  const visitors = rows.reduce((s, r) => s + (r.an ? r.an.last.nA + r.an.last.nB : 0), 0);
  return (
    <Page eyebrow="Experimentation platform" title="Experiments" right={<Link to="/upload" className="btn btn-ghost btn-sm"><Upload size={14} /> Upload CSV</Link>}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 rise">
        <Stat label="Running" value={String(running)} hint={`${list.length} total`} />
        <Stat label="Winners shipped" value={String(winners)} tone="ok" hint="significant positive lift, no SRM" />
        <Stat label="SRM alerts" value={String(srms)} tone={srms ? "bad" : undefined} hint="sample-ratio mismatch at p < 0.001" />
        <Stat label="Visitors analysed" value={visitors.toLocaleString()} hint="across all experiments" />
      </div>
      <div className="card mt-5 overflow-hidden rise rise-d1">
        <div className="overflow-auto">
          <table className="data">
            <thead><tr><th>Experiment</th><th>Metric</th><th>Progress</th><th className="text-right">Lift</th><th className="text-right">p-value</th><th>Verdict</th><th></th></tr></thead>
            <tbody>
              {rows.map(({ e, an }) => {
                const v = an ? verdict(e, an) : null;
                return (
                  <tr key={e.id} className="hover:bg-bg2/60">
                    <td><Link to={`/exp/${e.id}`} className="font-medium hover:text-accent">{e.name}</Link><div className="text-xs faint">{e.owner} · started {e.startDate} · {e.tags.map((t) => <span key={t} className="chip mr-1 h-5 text-[10px]">{t}</span>)}</div></td>
                    <td className="text-sm">{e.metric}<div className="text-xs faint">{e.metricType === "conversion" ? `baseline ${fmtPct(e.baseline, 1)}` : `baseline ${fmtNum(e.baseline, 0)}`} · MDE {fmtPct(e.mdeRel, 0)}</div></td>
                    <td className="min-w-32">{an && <div><div className="h-1.5 rounded-full bg-bg2 overflow-hidden"><div className={`h-full ${an.progress >= 1 ? "bg-ok" : "bg-accent"}`} style={{ width: `${Math.round(an.progress * 100)}%` }} /></div><div className="text-xs faint mt-1 mono">{(an.last.nA + an.last.nB).toLocaleString()} users · {e.days.length}d</div></div>}</td>
                    <td className={`text-right mono ${v && v.lift > 0 ? "text-ok" : v && v.lift < 0 ? "text-rose" : ""}`}>{v ? `${v.lift > 0 ? "+" : ""}${fmtPct(v.lift)}` : "–"}</td>
                    <td className="text-right mono">{v ? fmtP(v.p) : "–"}</td>
                    <td>{v && <span className={`chip ${v.tone === "ok" ? "chip-ok" : v.tone === "bad" ? "chip-bad" : v.tone === "warn" ? "chip-warn" : "chip-accent"}`}>{v.tone === "bad" && <AlertTriangle size={12} />}{v.label}</span>}</td>
                    <td><button className="btn btn-ghost btn-sm w-8 px-0" aria-label={`Delete ${e.name}`} onClick={() => setList(remove(e.id))}><Trash2 size={14} /></button></td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={7} className="text-center py-12 muted">No experiments yet. <Link to="/new" className="text-accent font-medium">Create one</Link> or <Link to="/upload" className="text-accent font-medium">upload a CSV</Link>.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs faint mt-3">Demo experiments are simulated deterministically (seeded PRNG) with known true effects — one has a deliberate 1.2 pt bucketing skew to show the SRM guardrail, one has a novelty effect that fades, one uses a continuous metric with CUPED.</p>
    </Page>
  );
}

/* ---------------- Results ---------------- */
function Results({ shared }: { shared?: boolean }) {
  const { id = "" } = useParams();
  const [copied, setCopied] = useState(false);
  const e = useMemo(() => (shared ? decodeShare(id) : loadExperiments().find((x) => x.id === id) ?? null), [id, shared]);
  useEffect(() => { document.title = e ? `${e.name} — abkit` : "abkit"; }, [e]);
  if (!e) return <Page eyebrow="Results" title="Experiment not found"><div className="card p-10 text-center muted">This link doesn't match an experiment in this browser. <Link className="text-accent" to="/">Back to experiments</Link></div></Page>;
  const an = analyse(e);
  if (!an) return null;
  const v = verdict(e, an);
  const shareUrl = `${location.origin}/share/${encodeShare(e)}`;
  const csv = () => { const rows = [["day", "nA", "nB", e.metricType === "conversion" ? "convA" : "sumA", e.metricType === "conversion" ? "convB" : "sumB"], ...e.days.map((d) => [d.day, d.nA, d.nB, e.metricType === "conversion" ? d.convA : d.sumsA.sy.toFixed(2), e.metricType === "conversion" ? d.convB : d.sumsB.sy.toFixed(2)])]; const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${e.id}.csv`; a.click(); };
  const holmRes = an.kind === "conversion" ? holm([an.z.p, an.srm.p]) : holm([an.raw.p, an.adj.p]);
  return (
    <Page eyebrow={shared ? "Shared result (read-only)" : "Results"} title={e.name} right={<div className="flex gap-2"><button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Share link"}</button><button className="btn btn-ghost btn-sm" onClick={csv}><Download size={14} /> CSV</button></div>}>
      {e.hypothesis && <p className="muted -mt-3 mb-5 max-w-3xl">{e.hypothesis}</p>}
      {an.srm.mismatch && <div role="alert" className="card p-4 mb-4 border-rose/40 bg-bad-soft flex gap-3 items-start"><AlertTriangle className="text-rose shrink-0 mt-0.5" size={18} /><div><strong>Sample-ratio mismatch.</strong> Expected a {fmtPct(e.split, 0)} / {fmtPct(1 - e.split, 0)} split but observed {an.last.nA.toLocaleString()} / {an.last.nB.toLocaleString()} (χ² = {an.srm.chi2.toFixed(1)}, p = {fmtP(an.srm.p)}). The assignment or logging is broken; do not act on any metric below until it's fixed.</div></div>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 rise">
        <Stat label="Verdict" value={v.label} tone={v.tone === "neutral" ? undefined : v.tone} hint={`α = ${e.alpha} · ${e.days.length} days · ${(an.last.nA + an.last.nB).toLocaleString()} users`} />
        <Stat label="Relative lift" value={`${v.lift > 0 ? "+" : ""}${fmtPct(v.lift)}`} tone={v.lift > 0 ? "ok" : v.lift < 0 ? "bad" : undefined} hint={an.kind === "conversion" ? `${fmtPct(an.z.rateA)} → ${fmtPct(an.z.rateB)}` : `${fmtNum(an.a.mean)} → ${fmtNum(an.b.mean)} (CUPED-adjusted lift)`} />
        <Stat label="p-value" value={fmtP(v.p)} hint={an.kind === "conversion" ? `z = ${an.z.z.toFixed(2)} · two-sided` : `Welch t · CUPED-adjusted · raw p = ${fmtP(an.raw.p)}`} />
        <Stat label="Sample progress" value={`${Math.round(an.progress * 100)}%`} hint={`${Math.min(an.last.nA, an.last.nB).toLocaleString()} / ${e.plannedPerArm.toLocaleString()} per arm planned`} tone={an.progress >= 1 ? "ok" : undefined} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-5">
        <section className="card p-5 lg:col-span-2 rise rise-d1">
          <h2 className="text-base font-semibold">Relative lift over time with {Math.round((1 - e.alpha) * 100)}% confidence interval</h2>
          <p className="text-xs faint mb-3">Cumulative estimate by day. Early days swing widely — decide at the planned sample size, not when the band first clears zero.{an.kind === "continuous" ? " Dashed band: CUPED-adjusted interval." : ""}</p>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={an.series} margin={{ left: -10, right: 10 }}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--ink-3)" }} label={{ value: "day", position: "insideBottomRight", fontSize: 11, fill: "var(--ink-3)" }} />
              <YAxis unit="%" tick={{ fontSize: 11, fill: "var(--ink-3)" }} />
              <Tooltip {...tip} formatter={(val: unknown) => (typeof val === "number" ? `${val.toFixed(2)}%` : String(val))} />
              <ReferenceLine y={0} stroke="var(--ink-3)" />
              <ReferenceLine y={100 * e.mdeRel} stroke="var(--amber)" strokeDasharray="4 4" label={{ value: "MDE", fontSize: 10, fill: "var(--amber)" }} />
              <Area dataKey="hi" stroke="none" fill="var(--accent)" fillOpacity={0.12} name="CI high" />
              <Area dataKey="lo" stroke="none" fill="var(--card)" fillOpacity={1} name="CI low" />
              {an.kind === "continuous" && <Line dataKey="cHi" stroke="var(--teal)" strokeDasharray="4 3" dot={false} name="CUPED CI high" />}
              {an.kind === "continuous" && <Line dataKey="cLo" stroke="var(--teal)" strokeDasharray="4 3" dot={false} name="CUPED CI low" />}
              <Line dataKey="lift" stroke="var(--accent)" strokeWidth={2.2} dot={false} name="lift" />
            </ComposedChart>
          </ResponsiveContainer>
        </section>
        <section className="card p-5 rise rise-d2">
          <h2 className="text-base font-semibold">Sequential p-value</h2>
          <p className="text-xs faint mb-3">Peeking every day and stopping at the first p &lt; α inflates false positives to ~19% (see Docs). The line is for monitoring, not decisions.</p>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={an.series} margin={{ left: -10, right: 10 }}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--ink-3)" }} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11, fill: "var(--ink-3)" }} />
              <Tooltip {...tip} formatter={(val: unknown) => (typeof val === "number" ? val.toFixed(4) : String(val))} />
              <ReferenceLine y={e.alpha} stroke="var(--rose)" strokeDasharray="4 4" label={{ value: `α = ${e.alpha}`, fontSize: 10, fill: "var(--rose)" }} />
              <Area dataKey={an.kind === "continuous" ? "pc" : "p"} stroke="var(--rose)" fill="var(--rose)" fillOpacity={0.12} name="p" />
            </AreaChart>
          </ResponsiveContainer>
        </section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <section className="card p-5 rise rise-d2">
          <h2 className="text-base font-semibold">Daily {e.metricType === "conversion" ? "conversion rate" : "mean"} by arm</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={an.daily} margin={{ left: -10, right: 10 }}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--ink-3)" }} />
              <YAxis tick={{ fontSize: 11, fill: "var(--ink-3)" }} unit={e.metricType === "conversion" ? "%" : ""} />
              <Tooltip {...tip} formatter={(val: unknown) => (typeof val === "number" ? val.toFixed(2) : String(val))} />
              <Bar dataKey="A" fill="var(--ink-3)" radius={[3, 3, 0, 0]} name="A (control)" />
              <Bar dataKey="B" fill="var(--accent)" radius={[3, 3, 0, 0]} name="B (treatment)" />
            </BarChart>
          </ResponsiveContainer>
        </section>
        <section className="card p-5 rise rise-d3">
          <h2 className="text-base font-semibold">Arms & guardrails</h2>
          <div className="overflow-x-auto"><table className="data mt-2">
            <thead><tr><th>Arm</th><th className="text-right">Users</th><th className="text-right">{e.metricType === "conversion" ? "Conversions" : "Mean"}</th><th className="text-right">{e.metricType === "conversion" ? "Rate" : "Std"}</th></tr></thead>
            <tbody>
              <tr><td>A · control</td><td className="text-right mono">{an.last.nA.toLocaleString()}</td><td className="text-right mono">{an.kind === "conversion" ? an.last.convA.toLocaleString() : fmtNum(an.a.mean)}</td><td className="text-right mono">{an.kind === "conversion" ? fmtPct(an.z.rateA) : fmtNum(Math.sqrt(an.a.var))}</td></tr>
              <tr><td>B · treatment</td><td className="text-right mono">{an.last.nB.toLocaleString()}</td><td className="text-right mono">{an.kind === "conversion" ? an.last.convB.toLocaleString() : fmtNum(an.b.mean)}</td><td className="text-right mono">{an.kind === "conversion" ? fmtPct(an.z.rateB) : fmtNum(Math.sqrt(an.b.var))}</td></tr>
            </tbody>
          </table></div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mt-4 [&_dd]:break-words [&_dd]:min-w-0">
            <dt className="faint">Sample-ratio check</dt><dd className={`mono text-right ${an.srm.mismatch ? "text-rose font-semibold" : "text-ok"}`}>χ² {an.srm.chi2.toFixed(2)} · p {fmtP(an.srm.p)}</dd>
            <dt className="faint">Absolute difference · {Math.round((1 - e.alpha) * 100)}% CI</dt><dd className="mono text-right">{an.kind === "conversion" ? `${(100 * an.z.liftAbs).toFixed(2)} pt [${(100 * an.z.ciLow).toFixed(2)}, ${(100 * an.z.ciHigh).toFixed(2)}]` : `${fmtNum(an.adj.diff)} [${fmtNum(an.adj.ciLow)}, ${fmtNum(an.adj.ciHigh)}]`}</dd>
            <dt className="faint">Holm correction (2 tests)</dt><dd className="mono text-right">{holmRes.map((h) => (h ? "reject" : "keep")).join(" · ")}</dd>
            {an.kind === "continuous" && <><dt className="faint">CUPED θ · variance removed</dt><dd className="mono text-right text-teal">{an.cuped.theta.toFixed(3)} · {fmtPct(an.cuped.varianceReduction, 1)}</dd><dt className="faint">CI width raw → CUPED</dt><dd className="mono text-right">{fmtNum(an.raw.ciHigh - an.raw.ciLow)} → {fmtNum(an.adj.ciHigh - an.adj.ciLow)}</dd></>}
          </dl>
        </section>
      </div>
      {an.kind === "continuous" && (
        <section className="card p-5 mt-4 rise rise-d3">
          <h2 className="text-base font-semibold">CUPED — before and after</h2>
          <p className="text-xs faint mb-3">The pre-period covariate (last month's spend) is correlated with the metric, so subtracting θ·(x − x̄) removes the part of the variance the treatment could not have caused. The effect estimate stays unbiased; the interval shrinks.</p>
          <div className="grid sm:grid-cols-2 gap-4">
            {[{ t: "Raw", r: an.raw }, { t: "CUPED-adjusted", r: an.adj }].map(({ t, r }) => (
              <div key={t} className="rounded-xl border border-line p-4">
                <div className="flex justify-between items-baseline"><span className="font-medium">{t}</span><span className={`chip ${r.significant ? "chip-ok" : "chip-warn"}`}>{r.significant ? "significant" : "not significant"}</span></div>
                <div className="mono text-2xl mt-2">{r.diff > 0 ? "+" : ""}{fmtNum(r.diff)} <span className="text-sm faint">({r.liftRel > 0 ? "+" : ""}{fmtPct(r.liftRel)})</span></div>
                <div className="relative h-3 mt-3 rounded-full bg-bg2"><div className="absolute top-0 h-3 rounded-full bg-teal/50" style={{ left: `${50 + (r.ciLow / Math.max(1e-9, Math.abs(an.raw.ciHigh) * 2.2)) * 50}%`, width: `${((r.ciHigh - r.ciLow) / Math.max(1e-9, Math.abs(an.raw.ciHigh) * 2.2)) * 50}%` }} /><div className="absolute top-0 h-3 w-px bg-ink3 left-1/2" /></div>
                <div className="mono text-xs faint mt-2">CI [{fmtNum(r.ciLow)}, {fmtNum(r.ciHigh)}] · p {fmtP(r.p)} · df {r.df.toFixed(0)}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}

/* ---------------- Wizard ---------------- */
function Wizard() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: "", hypothesis: "", owner: "You", metric: "Booking conversion", metricType: "conversion" as "conversion" | "continuous", baseline: "0.10", std: "1", mdeRel: "0.05", alpha: "0.05", power: "0.8", dailyTraffic: "40000", split: "0.5", trueLift: "0.05", days: "14" });
  useEffect(() => { document.title = "New experiment — abkit"; }, []);
  const set = (k: keyof typeof f) => (ev: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: ev.target.value });
  const baseline = num(f.baseline, 0.1), mde = num(f.mdeRel, 0.05), alpha = num(f.alpha, 0.05), power = num(f.power, 0.8), daily = num(f.dailyTraffic, 40000);
  const perArm = f.metricType === "conversion" ? (baseline > 0 && baseline * (1 + mde) < 1 ? sampleSizeProportion(baseline, mde, alpha, power) : NaN) : sampleSizeMean(num(f.std, 1), baseline * mde, alpha, power);
  const daysNeeded = Math.ceil((2 * perArm) / Math.max(1, daily));
  const valid0 = f.name.trim().length > 2;
  function create() {
    const id = `exp-${f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36).slice(-4)}`;
    const def: Omit<Experiment, "days"> = { id, name: f.name.trim(), hypothesis: f.hypothesis.trim(), owner: f.owner, metric: f.metric, metricType: f.metricType, baseline, ...(f.metricType === "continuous" ? { std: num(f.std, 1) } : {}), mdeRel: mde, alpha, power, dailyTraffic: daily, split: num(f.split, 0.5), startDate: new Date().toISOString().slice(0, 10), status: "running", plannedPerArm: perArm, source: "simulated", tags: ["new"] };
    const e: Experiment = { ...def, days: simulate(def, { trueLiftRel: num(f.trueLift, 0), days: Math.max(1, Math.min(60, num(f.days, 14))) }) };
    upsert(e);
    nav(`/exp/${e.id}`);
  }
  const steps = ["Hypothesis", "Metric & power", "Simulate & launch"];
  return (
    <Page eyebrow="Create experiment" title="New experiment">
      <ol className="flex gap-2 mb-6 text-sm" aria-label="Steps">{steps.map((s, i) => <li key={s} className={`flex items-center gap-2 ${i === step ? "text-ink font-semibold" : "faint"}`}><span className={`grid place-items-center size-6 rounded-full text-xs ${i < step ? "bg-ok text-white" : i === step ? "bg-accent text-accent-ink" : "bg-bg2"}`}>{i < step ? <Check size={12} /> : i + 1}</span>{s}{i < steps.length - 1 && <span className="w-8 h-px bg-line" />}</li>)}</ol>
      <div className="grid lg:grid-cols-[1fr_340px] gap-5">
        <div className="card p-5 grid gap-4 rise">
          {step === 0 && <>
            <Field label="Experiment name"><input className="input" value={f.name} onChange={set("name")} placeholder="e.g. Map view as default on mobile" autoFocus /></Field>
            <Field label="Hypothesis" hint="If we [change], then [metric] will [move] because [reason]."><textarea className="input h-24 py-2" value={f.hypothesis} onChange={set("hypothesis")} /></Field>
            <div className="grid sm:grid-cols-2 gap-3"><Field label="Owner"><input className="input" value={f.owner} onChange={set("owner")} /></Field><Field label="Primary metric"><input className="input" value={f.metric} onChange={set("metric")} /></Field></div>
          </>}
          {step === 1 && <>
            <Field label="Metric type"><select className="input" value={f.metricType} onChange={set("metricType")}><option value="conversion">Conversion rate (binary per user)</option><option value="continuous">Continuous (revenue, nights, …)</option></select></Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label={f.metricType === "conversion" ? "Baseline rate" : "Baseline mean"} hint={f.metricType === "conversion" ? "e.g. 0.10 for 10%" : "e.g. 412"}><input className="input mono" value={f.baseline} onChange={set("baseline")} /></Field>
              {f.metricType === "continuous" ? <Field label="Std deviation"><input className="input mono" value={f.std} onChange={set("std")} /></Field> : <Field label="Minimum detectable effect (relative)" hint="0.05 = +5%"><input className="input mono" value={f.mdeRel} onChange={set("mdeRel")} /></Field>}
              {f.metricType === "continuous" && <Field label="Minimum detectable effect (relative)"><input className="input mono" value={f.mdeRel} onChange={set("mdeRel")} /></Field>}
              <Field label="Alpha"><input className="input mono" value={f.alpha} onChange={set("alpha")} /></Field>
              <Field label="Power"><input className="input mono" value={f.power} onChange={set("power")} /></Field>
              <Field label="Daily eligible users"><input className="input mono" value={f.dailyTraffic} onChange={set("dailyTraffic")} /></Field>
              <Field label="Share of traffic to control"><input className="input mono" value={f.split} onChange={set("split")} /></Field>
            </div>
          </>}
          {step === 2 && <>
            <p className="muted text-sm">This app has no production traffic, so we simulate the experiment with a true effect you choose — the analysis pipeline is exactly what real data would go through (and what <Link className="text-accent" to="/upload">CSV upload</Link> feeds).</p>
            <div className="grid sm:grid-cols-2 gap-3"><Field label="True relative effect to simulate" hint="0 = A/A test"><input className="input mono" value={f.trueLift} onChange={set("trueLift")} /></Field><Field label="Days of data"><input className="input mono" value={f.days} onChange={set("days")} /></Field></div>
          </>}
          <div className="flex justify-between pt-2"><button className="btn btn-ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>{step < 2 ? <button className="btn btn-primary" disabled={!valid0} onClick={() => setStep(step + 1)}>Continue <ArrowRight size={15} /></button> : <button className="btn btn-primary" onClick={create}><FlaskConical size={15} /> Launch experiment</button>}</div>
        </div>
        <aside className="card p-5 rise rise-d1 self-start">
          <span className="label">Power analysis</span>
          <div className="mono text-3xl font-semibold">{Number.isFinite(perArm) ? perArm.toLocaleString() : "–"}</div>
          <div className="text-sm muted">users per arm · {Number.isFinite(perArm) ? (2 * perArm).toLocaleString() : "–"} total</div>
          <div className="mt-3 text-sm"><span className="chip chip-accent">≈ {Number.isFinite(daysNeeded) ? daysNeeded : "–"} days</span> <span className="faint">at {daily.toLocaleString()} users/day</span></div>
          <p className="text-xs faint mt-4">Detects {f.metricType === "conversion" ? `${fmtPct(baseline, 1)} → ${fmtPct(baseline * (1 + mde), 2)}` : `${fmtNum(baseline)} → ${fmtNum(baseline * (1 + mde))}`} with {fmtPct(power, 0)} power at α = {alpha} (two-sided). Fix this before launch and do not stop early on a significant peek.</p>
        </aside>
      </div>
    </Page>
  );
}

/* ---------------- Calculator ---------------- */
function CalculatorPage() {
  const [s, setS] = useState({ base: "0.10", mde: "0.05", alpha: "0.05", power: "0.8", daily: "20000" });
  const [z, setZ] = useState({ ca: "1000", na: "10000", cb: "1100", nb: "10000", alpha: "0.05" });
  const [r, setR] = useState({ a: "100000", b: "101200", share: "0.5" });
  useEffect(() => { document.title = "Calculator — abkit"; }, []);
  const n = sampleSizeProportion(num(s.base, 0.1), num(s.mde, 0.05), num(s.alpha, 0.05), num(s.power, 0.8));
  const zr = twoProportionZ(num(z.ca, 0), num(z.na, 1), num(z.cb, 0), num(z.nb, 1), num(z.alpha, 0.05));
  const sr = srm([num(r.a, 0), num(r.b, 0)], [num(r.share, 0.5), 1 - num(r.share, 0.5)]);
  const curve = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15, 0.2].map((m) => ({ mde: `${Math.round(m * 100)}%`, perArm: sampleSizeProportion(num(s.base, 0.1), m, num(s.alpha, 0.05), num(s.power, 0.8)) }));
  const inp = (v: string, on: (x: string) => void, cls = "") => <input className={`input mono ${cls}`} value={v} onChange={(e) => on(e.target.value)} />;
  return (
    <Page eyebrow="Tools" title="Calculators">
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card p-5 rise"><h2 className="text-base font-semibold">Sample size</h2><p className="text-xs faint mb-3">Users per arm for a conversion-rate test (two-sided).</p>
          <div className="grid grid-cols-2 gap-3"><Field label="Baseline">{inp(s.base, (v) => setS({ ...s, base: v }))}</Field><Field label="MDE (rel.)">{inp(s.mde, (v) => setS({ ...s, mde: v }))}</Field><Field label="Alpha">{inp(s.alpha, (v) => setS({ ...s, alpha: v }))}</Field><Field label="Power">{inp(s.power, (v) => setS({ ...s, power: v }))}</Field></div>
          <Field label="Daily users (for duration)">{inp(s.daily, (v) => setS({ ...s, daily: v }))}</Field>
          <div className="mt-4 mono text-3xl font-semibold">{Number.isFinite(n) ? n.toLocaleString() : "–"}</div><div className="text-sm muted">per arm · ≈ {Number.isFinite(n) ? Math.ceil((2 * n) / Math.max(1, num(s.daily, 1))) : "–"} days</div>
          <ResponsiveContainer width="100%" height={160}><BarChart data={curve} margin={{ left: -10, right: 4 }}><XAxis dataKey="mde" tick={{ fontSize: 10, fill: "var(--ink-3)" }} /><YAxis tick={{ fontSize: 10, fill: "var(--ink-3)" }} scale="log" domain={["auto", "auto"]} /><Tooltip {...tip} formatter={(val: unknown) => (typeof val === "number" ? val.toLocaleString() : String(val))} /><Bar dataKey="perArm" radius={3}>{curve.map((c) => <Cell key={c.mde} fill={c.mde === `${Math.round(num(s.mde, 0.05) * 100)}%` ? "var(--accent)" : "var(--ink-3)"} />)}</Bar></BarChart></ResponsiveContainer>
          <p className="text-xs faint">Per-arm sample size vs MDE (log scale) — halving the MDE quadruples the sample.</p>
        </section>
        <section className="card p-5 rise rise-d1"><h2 className="text-base font-semibold">Two-proportion z-test</h2><p className="text-xs faint mb-3">Control A vs treatment B.</p>
          <div className="grid grid-cols-2 gap-3"><Field label="A conversions">{inp(z.ca, (v) => setZ({ ...z, ca: v }))}</Field><Field label="A visitors">{inp(z.na, (v) => setZ({ ...z, na: v }))}</Field><Field label="B conversions">{inp(z.cb, (v) => setZ({ ...z, cb: v }))}</Field><Field label="B visitors">{inp(z.nb, (v) => setZ({ ...z, nb: v }))}</Field></div>
          <div className="mt-4 rounded-xl bg-bg2 p-4 text-sm grid gap-1 mono"><div>{fmtPct(zr.rateA)} → {fmtPct(zr.rateB)} · lift <b>{zr.liftAbs > 0 ? "+" : ""}{fmtPct(zr.liftRel)}</b></div><div>z = {zr.z.toFixed(3)} · p = <b>{fmtP(zr.p)}</b></div><div>95% CI (abs): [{fmtPct(zr.ciLow)}, {fmtPct(zr.ciHigh)}]</div><div className={zr.significant ? "text-ok" : "text-amber"}>{zr.significant ? "Significant" : "Not significant"} at α = {z.alpha}</div></div>
        </section>
        <section className="card p-5 rise rise-d2"><h2 className="text-base font-semibold">Sample-ratio mismatch</h2><p className="text-xs faint mb-3">Chi-square test of arm sizes vs the intended split.</p>
          <div className="grid grid-cols-2 gap-3"><Field label="Users in A">{inp(r.a, (v) => setR({ ...r, a: v }))}</Field><Field label="Users in B">{inp(r.b, (v) => setR({ ...r, b: v }))}</Field><Field label="Intended share of A">{inp(r.share, (v) => setR({ ...r, share: v }))}</Field></div>
          <div className="mt-4 rounded-xl bg-bg2 p-4 text-sm grid gap-1 mono"><div>expected {sr.expected.map((x) => Math.round(x).toLocaleString()).join(" / ")}</div><div>χ² = {sr.chi2.toFixed(2)} · p = <b>{fmtP(sr.p)}</b></div><div className={sr.mismatch ? "text-rose font-semibold" : "text-ok"}>{sr.mismatch ? "Mismatch — investigate bucketing" : "No SRM at p < 0.001"}</div></div>
        </section>
      </div>
    </Page>
  );
}

/* ---------------- Ranking lab ---------------- */
function RankingLab() {
  const [k, setK] = useState(5);
  const [relA, setRelA] = useState("3,2,3,0,1,2,0,0,1,0");
  const [relB, setRelB] = useState("3,3,2,2,1,0,1,0,0,0");
  const [seed, setSeed] = useState(7);
  useEffect(() => { document.title = "Ranking lab — abkit"; }, []);
  const parse = (s: string) => s.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  const a = parse(relA), b = parse(relB);
  const items = a.map((_, i) => `d${i + 1}`);
  const rnd = mulberry32(seed);
  const rankA = [...items].sort((x, y) => a[items.indexOf(y)]! - a[items.indexOf(x)]! + (rnd() - 0.5) * 2.5);
  const rankB = [...items].sort((x, y) => b[items.indexOf(y)]! - b[items.indexOf(x)]! + (rnd() - 0.5) * 1.2);
  const { list, teams } = teamDraft(rankA, rankB, rnd);
  const wins = { A: 0, B: 0, tie: 0 };
  const sessions = 400;
  for (let s = 0; s < sessions; s++) {
    let ca = 0, cb = 0;
    list.forEach((it, pos) => { const rel = Math.max(a[items.indexOf(it)]!, b[items.indexOf(it)]!); if (rnd() < (rel / 3) * 0.7 / Math.sqrt(pos + 1)) { if (teams[pos] === "A") ca++; else cb++; } });
    if (ca > cb) wins.A++; else if (cb > ca) wins.B++; else wins.tie++;
  }
  const rows = [["Ranker A", a], ["Ranker B", b]] as const;
  return (
    <Page eyebrow="Search quality" title="Ranking metrics playground">
      <div className="grid lg:grid-cols-[1fr_1fr] gap-4">
        <section className="card p-5 rise"><h2 className="text-base font-semibold">Offline metrics</h2><p className="text-xs faint mb-3">Enter graded relevance (0–3) of the documents at each position of two rankers.</p>
          <Field label="Ranker A — relevance by position"><input className="input mono" value={relA} onChange={(e) => setRelA(e.target.value)} /></Field>
          <div className="h-3" /><Field label="Ranker B — relevance by position"><input className="input mono" value={relB} onChange={(e) => setRelB(e.target.value)} /></Field>
          <div className="h-3" /><Field label={`k = ${k}`}><input type="range" min={1} max={10} value={k} onChange={(e) => setK(Number(e.target.value))} className="w-full accent-[var(--accent)]" /></Field>
          <table className="data mt-3"><thead><tr><th>Ranker</th><th className="text-right">NDCG@{k}</th><th className="text-right">MRR</th><th className="text-right">P@{k}</th></tr></thead><tbody>{rows.map(([n, rel]) => <tr key={n}><td>{n}</td><td className="text-right mono">{ndcgAtK(rel, k).toFixed(3)}</td><td className="text-right mono">{mrr([rel.map((x) => x > 0)]).toFixed(3)}</td><td className="text-right mono">{precisionAtK(rel.map((x) => x > 0), k).toFixed(2)}</td></tr>)}</tbody></table>
          <ResponsiveContainer width="100%" height={180}><BarChart data={Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({ pos: i + 1, A: a[i] ?? 0, B: b[i] ?? 0 }))} margin={{ left: -20, right: 4 }}><XAxis dataKey="pos" tick={{ fontSize: 10, fill: "var(--ink-3)" }} /><YAxis domain={[0, 3]} tick={{ fontSize: 10, fill: "var(--ink-3)" }} /><Tooltip {...tip} /><Bar dataKey="A" fill="var(--ink-3)" radius={2} /><Bar dataKey="B" fill="var(--accent)" radius={2} /></BarChart></ResponsiveContainer>
          <p className="text-xs faint">Relevance by position. NDCG rewards putting high grades early with a log₂ discount.</p>
        </section>
        <section className="card p-5 rise rise-d1"><h2 className="text-base font-semibold">Team-draft interleaving</h2><p className="text-xs faint mb-3">Both rankers "pick" alternately into one list shown to the user; clicks are credited to the team that picked the item. {sessions} simulated sessions with position-biased clicks.</p>
          <ol className="grid gap-1.5">{list.map((it, i) => <li key={it} className="flex items-center gap-2 text-sm"><span className="mono w-6 faint">{i + 1}</span><span className={`chip ${teams[i] === "A" ? "" : "chip-accent"}`}>{teams[i]}</span><span className="mono">{it}</span><span className="faint text-xs">rel {Math.max(a[items.indexOf(it)] ?? 0, b[items.indexOf(it)] ?? 0)}</span></li>)}</ol>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">{(["A", "B", "tie"] as const).map((t) => <div key={t} className="rounded-xl bg-bg2 p-3"><div className="text-xs faint uppercase">{t === "tie" ? "ties" : `${t} wins`}</div><div className="mono text-xl font-semibold">{wins[t]}</div></div>)}</div>
          <p className="text-xs faint mt-3">Winner: <b>{wins.A > wins.B ? "Ranker A" : wins.B > wins.A ? "Ranker B" : "tie"}</b> · binomial p = {fmtP(twoProportionZ(wins.A, wins.A + wins.B, wins.B, wins.A + wins.B).p)} · <button className="text-accent" onClick={() => setSeed(seed + 1)}>re-roll sessions</button></p>
        </section>
      </div>
    </Page>
  );
}

/* ---------------- Upload ---------------- */
function UploadPage() {
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("Uploaded experiment");
  useEffect(() => { document.title = "Upload CSV — abkit"; }, []);
  const onFile = async (file: File) => { try { const e = parseCsv(await file.text(), name || file.name); upsert(e); nav(`/exp/${e.id}`); } catch (ex) { setErr((ex as Error).message); } };
  const sample = "variant,converted,day\nA,1,1\nA,0,1\nB,1,1\nB,1,1\nA,0,2\nB,0,2";
  return (
    <Page eyebrow="Import" title="Upload experiment data">
      <div className="grid lg:grid-cols-[1fr_360px] gap-4">
        <div className="card p-6 rise">
          <Field label="Experiment name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <label className="mt-4 grid place-items-center gap-2 h-52 rounded-xl border-2 border-dashed border-line hover:border-accent cursor-pointer text-center p-4" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void onFile(f); }}>
            <Upload className="text-accent" /><span className="font-medium">Drop a CSV here or click to choose</span><span className="text-xs faint">One row per user: <code className="mono">variant</code>, <code className="mono">converted</code> (0/1) or <code className="mono">value</code>, optional <code className="mono">pre_value</code> (for CUPED) and <code className="mono">day</code></span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          </label>
          {err && <p role="alert" className="text-sm text-rose mt-3">{err}</p>}
          <p className="text-xs faint mt-3">Data never leaves your browser — parsing and statistics run locally.</p>
        </div>
        <aside className="card p-5 rise rise-d1"><span className="label">Example</span><pre className="formula">{sample}</pre><a className="btn btn-ghost btn-sm mt-3" href={`data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`} download="abkit-sample.csv"><Download size={14} /> Download sample</a></aside>
      </div>
    </Page>
  );
}

/* ---------------- Docs ---------------- */
const DOCS: { id: string; title: string; body: ReactNode }[] = [
  { id: "ztest", title: "Two-proportion z-test", body: <><p>For conversion metrics we compare rates p̂A and p̂B with the pooled standard error for the test statistic and the unpooled (Wald) standard error for the confidence interval.</p><pre className="formula">z = (p̂B − p̂A) / √( p̄(1−p̄)(1/nA + 1/nB) ),   p̄ = (xA + xB)/(nA + nB){"\n"}CI = (p̂B − p̂A) ± z₁₋α/₂ · √( p̂A(1−p̂A)/nA + p̂B(1−p̂B)/nB )</pre><p>Continuous metrics use Welch's t-test with the Welch–Satterthwaite degrees of freedom.</p></> },
  { id: "power", title: "Sample size & power", body: <><p>Fix α, power and the minimum detectable effect <em>before</em> launch. For proportions:</p><pre className="formula">n = ( z₁₋α/₂·√(2p̄q̄) + z_power·√(p₁q₁ + p₂q₂) )² / (p₂ − p₁)²</pre><p>10% baseline, +10% relative lift, α = 0.05, power 0.8 → 14,751 users per arm. Halving the MDE quadruples the sample.</p></> },
  { id: "peeking", title: "Why you must not peek", body: <><p>Checking the p-value after every day and stopping at the first p &lt; 0.05 is a different test with a much higher false-positive rate. In our Monte-Carlo study (A/A data, 10 looks) it was <b>19.1%</b> instead of 5%. A Bonferroni α/looks per look brought it to 2.6% (over-conservative). Use the planned sample size, or a proper sequential test (mSPRT / always-valid p-values).</p></> },
  { id: "srm", title: "Sample-ratio mismatch", body: <><p>If the split of users between arms differs from the intended ratio more than chance allows, the assignment or logging is broken and every metric is suspect. Chi-square goodness of fit at a strict α = 0.001:</p><pre className="formula">χ² = Σ (observed − expected)² / expected,   df = arms − 1</pre><p>At 200k users a 49/51 skew is detected 100% of the time with 0.06% false alarms.</p></> },
  { id: "cuped", title: "CUPED variance reduction", body: <><p>Controlled-experiment Using Pre-Experiment Data (Deng et al., 2013): subtract the part of the metric explained by a pre-period covariate X that is independent of treatment.</p><pre className="formula">θ = cov(X, Y) / var(X),   Ỳ = Y − θ (X − X̄){"\n"}var(Ỳ) = var(Y)(1 − ρ²)</pre><p>With ρ = 0.6 the variance drops 36% — our simulation saw power rise from 70% to 88% with the lift still unbiased (bias 0.0003).</p></> },
  { id: "ranking", title: "Ranking evaluation", body: <><p>Offline: NDCG@k = DCG@k / IDCG@k with DCG = Σ (2^rel − 1)/log₂(i + 1); MRR = mean of 1/rank of the first relevant item; P@k. Online: team-draft interleaving shows one merged list built by alternating picks and credits clicks to the ranker that picked the item — every session compares both rankers, so it needs fewer sessions than a traffic-split A/B test.</p></> },
  { id: "multiple", title: "Multiple comparisons", body: <><p>Testing several metrics or variants inflates the family-wise error rate. Holm's step-down procedure orders p-values and compares p(k) with α/(m − k + 1) — uniformly more powerful than Bonferroni at the same FWER.</p></> },
];
function Docs() {
  useEffect(() => { document.title = "Docs — abkit"; }, []);
  return (
    <Page eyebrow="Methodology" title="Docs">
      <div className="grid lg:grid-cols-[220px_1fr] gap-6">
        <nav className="hidden lg:block sticky top-20 self-start text-sm grid gap-1" aria-label="Sections">{DOCS.map((d) => <a key={d.id} href={`#${d.id}`} className="px-3 py-1.5 rounded-lg hover:bg-bg2 muted">{d.title}</a>)}</nav>
        <div className="grid gap-4">{DOCS.map((d, i) => <section key={d.id} id={d.id} className={`card p-6 rise rise-d${Math.min(i, 3)} grid gap-3 leading-relaxed text-[15px]`}><h2 className="text-lg">{d.title}</h2>{d.body}</section>)}
          <p className="text-xs faint">Everything on this page is implemented in the <a className="text-accent" href="https://github.com/D-L-Narayana/abkit">Python package</a> (with pytest checks against SciPy) and mirrored in TypeScript for this app.</p></div>
      </div>
    </Page>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="new" element={<Wizard />} />
          <Route path="exp/:id" element={<Results />} />
          <Route path="share/:id" element={<Results shared />} />
          <Route path="calculator" element={<CalculatorPage />} />
          <Route path="ranking" element={<RankingLab />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="docs" element={<Docs />} />
          <Route path="*" element={<Page eyebrow="404" title="Page not found"><Link to="/" className="btn btn-primary btn-sm">Back to experiments</Link></Page>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
