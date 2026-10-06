import { AlertTriangle, Check, CircleCheck, Copy, Download, FileJson, FileSpreadsheet, Files, Link2, Play, Printer, Save, Square } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { IntervalBar, Legend, PValueChart, axisTick, gridProps, tooltipProps } from "../components/charts";
import { MenuButton, type MenuEntry } from "../components/menu";
import { EmptyState, Page, Section, Stat, Toast, toneChip } from "../components/ui";
import { P_PLOT_FLOOR, analyse, verdict, type Analysis, type Verdict } from "../lib/analysis";
import { toCsv, toJson } from "../lib/csv";
import { decodeShare, encodeShare } from "../lib/share";
import { isExperiment, store, useExperiments } from "../lib/storage";
import { buildSummary } from "../lib/summary";
import type { Experiment } from "../model";
import { fmtNum, fmtP, fmtPct, relativeLiftMeans, relativeLiftProportions, type RelCI } from "../stats";
import { useTitle } from "../theme";

/** Always-valid (mSPRT) summary attached to an analysis: final p, first day it fell below α, mixing scale. */
interface SequentialInfo { pAV: number; decidedDay: number | null; tau?: number }
/** `Analysis`/`Verdict` with the fields of the sequential-aware analysis hub read optionally, so the page renders the same with or without them. */
type AnalysisX = Analysis & { rel?: RelCI; sequential?: SequentialInfo };
type VerdictX = Verdict & { decision?: string; basis?: "fixed" | "sequential" };
type Status = Experiment["status"];
interface ToastState { key: number; message: string; actionLabel?: string; onAction?: () => void }
type ShareState = { kind: "idle" } | { kind: "busy" } | { kind: "copied"; url: string } | { kind: "manual"; url: string } | { kind: "error"; message: string };

const STATUS_LABEL: Record<Status, string> = { draft: "Draft", running: "Running", completed: "Completed", stopped: "Stopped" };
const signedPct = (x: number, d = 2): string => `${Number.isFinite(x) && x > 0 ? "+" : ""}${fmtPct(x, d)}`;
const signedNum = (x: number, d = 2): string => `${Number.isFinite(x) && x > 0 ? "+" : ""}${fmtNum(x, d)}`;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Client-side download through a Blob URL (no data: URLs, no server round-trip). */
function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function NotFound({ shared }: { shared: boolean }) {
  return (
    <Page eyebrow={shared ? "Shared result" : "Results"} title="Experiment not found">
      <EmptyState
        title={shared ? "This share link could not be decoded" : "This link doesn't match an experiment in this browser"}
        body={shared ? "The link is incomplete or was created by a newer version of the app. Ask for a fresh share link — it carries the full result in the URL." : "Experiments live in local storage. Ask for a share link instead — it carries the full result in the URL."}
        action={<Link className="btn btn-primary btn-sm" to="/">Back to experiments</Link>}
      />
    </Page>
  );
}

/** `/exp/:id` reads the local store; `/share/:id` decodes the token (v2 compressed or legacy v1) without touching storage. */
export function Results({ shared }: { shared?: boolean }) {
  const { id = "" } = useParams();
  return shared ? <SharedResults token={id} /> : <LocalResults id={id} />;
}

function LocalResults({ id }: { id: string }) {
  const e = useExperiments().find((x) => x.id === id) ?? null;
  useTitle(e ? `${e.name} — abkit` : "Experiment not found — abkit");
  return e ? <ResultsView key={e.id} e={e} shared={false} /> : <NotFound shared={false} />;
}

function SharedResults({ token }: { token: string }) {
  const [decoded, setDecoded] = useState<{ token: string; e: Experiment | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    decodeShare(token).then(
      (e) => { if (!cancelled) setDecoded({ token, e }); },
      () => { if (!cancelled) setDecoded({ token, e: null }); },
    );
    return () => { cancelled = true; };
  }, [token]);
  const e = decoded && decoded.token === token ? decoded.e : undefined; // undefined → still decoding
  useTitle(e === undefined ? "Opening shared result — abkit" : e ? `${e.name} — abkit` : "Experiment not found — abkit");
  if (e === undefined) {
    return (
      <Page eyebrow="Shared result · read-only" title="Opening shared result…">
        <p className="muted flex items-center gap-2 text-sm" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Decoding the link in your browser — nothing is sent to a server.
        </p>
      </Page>
    );
  }
  return e ? <ResultsView key={`shared:${e.id}`} e={e} shared /> : <NotFound shared />;
}

function ResultsView({ e, shared }: { e: Experiment; shared: boolean }) {
  const navigate = useNavigate();
  const shareInputId = useId();
  const an = useMemo<AnalysisX | null>(() => {
    try { return analyse(e); } catch { return null; }
  }, [e]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const [share, setShare] = useState<ShareState>({ kind: "idle" });
  const shareTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(shareTimer.current), []);
  const notify = (message: string, extra?: Pick<ToastState, "actionLabel" | "onAction">) => setToast({ key: Date.now(), message, ...extra });

  const statusChip = <span className="chip chip-status self-center" data-status={e.status}>{STATUS_LABEL[e.status]}</span>;
  if (!an) {
    return (
      <Page eyebrow={shared ? "Shared result · read-only" : "Results"} title={e.name} lede={e.hypothesis || undefined} right={statusChip}>
        <EmptyState
          title="No data to analyse yet"
          body="This experiment has no daily data. Finish it in the wizard to simulate data, or upload a CSV with its results."
          action={shared ? <Link to="/" className="btn btn-primary btn-sm">Back to experiments</Link> : <><Link to={`/new?from=${encodeURIComponent(e.id)}`} className="btn btn-primary btn-sm">Open in wizard</Link><Link to="/upload" className="btn btn-ghost btn-sm">Upload CSV</Link></>}
        />
      </Page>
    );
  }

  const v: VerdictX = verdict(e, an);
  // Delta-method relative CI: from the analysis hub when present, otherwise computed with the same functions on the same final statistics.
  const rel: RelCI = an.rel ?? (an.kind === "conversion" ? relativeLiftProportions(an.last.convA, an.last.nA, an.last.convB, an.last.nB, e.alpha) : relativeLiftMeans(an.cuped.adjA, an.cuped.adjB, e.alpha));
  const seq = an.sequential && Number.isFinite(an.sequential.pAV) ? an.sequential : undefined;
  const decision = v.decision ?? (an.srm.mismatch ? "invalid" : v.label.startsWith("Collecting") ? "collecting" : "fixed");
  const basis = an.srm.mismatch || decision === "invalid" ? "none — the sample-ratio check failed" : v.basis === "sequential" ? "always-valid p (mSPRT) — valid under daily peeking" : decision === "collecting" ? "none yet — planned sample size not reached" : "fixed-horizon test at the planned sample size";
  const ciPct = Math.round((1 - e.alpha) * 100);
  const users = an.last.nA + an.last.nB;
  const summary = () => buildSummary(e, { ...an, rel, sequential: seq }, v);
  const pointLabel = (val: unknown, name: unknown) => (typeof val === "number" ? [`${val.toFixed(2)}%`, String(name)] : Array.isArray(val) ? [`${val.map((x: number) => x.toFixed(2)).join("% … ")}%`, String(name)] : [String(val), String(name)]);

  // ----- exports (one entry per format; the Markdown summary goes to the clipboard, or downloads when the clipboard is unavailable)
  const exportItems: MenuEntry[] = [
    { id: "csv", label: "Download CSV", hint: ".csv", icon: <FileSpreadsheet size={15} />, onSelect: () => downloadText(`${e.id}.csv`, toCsv(e), "text/csv;charset=utf-8") },
    { id: "json", label: "Download JSON", hint: ".json", icon: <FileJson size={15} />, onSelect: () => downloadText(`${e.id}.json`, toJson(e), "application/json;charset=utf-8") },
    { id: "sep-1", separator: true },
    {
      id: "copy-md",
      label: "Copy Markdown summary",
      icon: <Copy size={15} />,
      onSelect: async () => {
        const text = summary();
        if (await copyText(text)) notify("Markdown summary copied");
        else {
          downloadText(`${e.id}-summary.md`, text, "text/markdown;charset=utf-8");
          notify(`Clipboard unavailable — downloaded ${e.id}-summary.md instead`);
        }
      },
    },
    { id: "print", label: "Print or save as PDF", icon: <Printer size={15} />, onSelect: () => window.print() },
  ];

  // ----- share link (v2 compressed token, encoded asynchronously)
  async function shareLink() {
    window.clearTimeout(shareTimer.current);
    setShare({ kind: "busy" });
    try {
      const token = await encodeShare(e);
      if (!token) throw new Error("the encoder returned an empty token");
      const url = `${location.origin}/share/${token}`;
      if (await copyText(url)) {
        setShare({ kind: "copied", url });
        shareTimer.current = window.setTimeout(() => setShare((s) => (s.kind === "copied" ? { kind: "idle" } : s)), 2000);
      } else {
        setShare({ kind: "manual", url });
      }
    } catch (err) {
      setShare({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ----- lifecycle (local experiments only; every change is undoable from the toast)
  function changeStatus(next: Status, verb: string) {
    const previous = e.status;
    store.setStatus(e.id, next);
    notify(`${verb} “${e.name}”`, { actionLabel: "Undo", onAction: () => store.setStatus(e.id, previous) });
  }
  const lifecycle: { id: string; label: string; icon: ReactNode; onClick: () => void }[] = [];
  if (e.status === "running") lifecycle.push({ id: "stop", label: "Stop experiment", icon: <Square size={14} aria-hidden="true" />, onClick: () => changeStatus("stopped", "Stopped") });
  if (e.status === "running" || e.status === "stopped") lifecycle.push({ id: "complete", label: "Mark complete", icon: <CircleCheck size={14} aria-hidden="true" />, onClick: () => changeStatus("completed", "Completed") });
  if (e.status === "stopped" || e.status === "completed") lifecycle.push({ id: "resume", label: "Resume", icon: <Play size={14} aria-hidden="true" />, onClick: () => changeStatus("running", "Resumed") });
  lifecycle.push({ id: "duplicate", label: "Duplicate", icon: <Files size={14} aria-hidden="true" />, onClick: () => navigate(`/new?from=${encodeURIComponent(e.id)}`) });

  function saveShared() {
    if (!isExperiment(e)) {
      notify("This shared result is incomplete and cannot be saved.");
      return;
    }
    const taken = new Set(store.load().map((x) => x.id));
    let id = e.id;
    for (let n = 1; taken.has(id); n++) id = `${e.id}-shared${n > 1 ? `-${n}` : ""}`;
    store.upsert(id === e.id ? e : { ...e, id, name: `${e.name} (shared)` });
    navigate(`/exp/${encodeURIComponent(id)}`);
  }

  const shareLabel = share.kind === "busy" ? "Preparing link…" : share.kind === "copied" ? "Link copied" : "Share link";
  return (
    <Page
      eyebrow={shared ? "Shared result · read-only" : "Results"}
      title={e.name}
      lede={e.hypothesis || undefined}
      right={
        <>
          {statusChip}
          <div className="no-print flex flex-wrap gap-2">
            <MenuButton label={<><Download size={14} aria-hidden="true" /> Export</>} items={exportItems} />
            {shared ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={saveShared}><Save size={14} aria-hidden="true" /> Save to my experiments</button>
            ) : (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void shareLink()} disabled={share.kind === "busy"} aria-busy={share.kind === "busy"} aria-live="polite">
                  {share.kind === "busy" ? <span className="spinner" aria-hidden="true" /> : share.kind === "copied" ? <Check size={14} aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />} {shareLabel}
                </button>
                {lifecycle.map((a) => (
                  <button key={a.id} type="button" className="btn btn-ghost btn-sm" onClick={a.onClick}>{a.icon} {a.label}</button>
                ))}
              </>
            )}
          </div>
        </>
      }
    >
      {share.kind === "manual" && (
        <div role="status" className="card no-print p-3 mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Link2 size={16} className="text-accent-text shrink-0" aria-hidden="true" />
          <label htmlFor={shareInputId} className="font-medium">Share link ready — copy it from here:</label>
          <input id={shareInputId} className="input mono text-xs flex-1 min-w-48 h-9" readOnly value={share.url} onFocus={(ev) => ev.currentTarget.select()} />
          <button type="button" className="btn btn-soft btn-sm" onClick={() => void copyText(share.url).then((ok) => ok && setShare({ kind: "copied", url: share.url }))}><Copy size={14} aria-hidden="true" /> Copy</button>
        </div>
      )}
      {share.kind === "error" && <p role="alert" className="no-print text-sm text-bad-ink bg-bad-soft rounded-lg p-3 mb-4">Could not create a share link: {share.message}.</p>}

      {an.srm.mismatch && (
        <div role="alert" className="card p-4 mb-4 flex gap-3 items-start border-bad/40 bg-bad-soft text-bad-ink">
          <AlertTriangle className="shrink-0 mt-0.5" size={18} aria-hidden="true" />
          <div className="text-sm">
            <strong>Sample-ratio mismatch.</strong> Expected a {fmtPct(e.split, 0)} / {fmtPct(1 - e.split, 0)} split but observed {an.last.nA.toLocaleString()} / {an.last.nB.toLocaleString()} (χ² = {an.srm.chi2.toFixed(1)}, p = {fmtP(an.srm.p)}). Assignment or logging is broken — do not act on any metric below until it is fixed.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 rise">
        <Stat label="Verdict" value={v.label} tone={v.tone} hint={`α = ${e.alpha} · ${e.days.length} days · ${users.toLocaleString()} users`} />
        <Stat label="Relative lift" value={signedPct(rel.lift)} tone={rel.lift > 0 ? "ok" : rel.lift < 0 ? "bad" : "neutral"} hint={`${ciPct}% CI [${signedPct(rel.lo)}, ${signedPct(rel.hi)}] · ${an.kind === "conversion" ? `${fmtPct(an.z.rateA)} → ${fmtPct(an.z.rateB)}` : `${fmtNum(an.a.mean)} → ${fmtNum(an.b.mean)} · CUPED`}`} />
        <Stat label="p-value" value={fmtP(v.p)} hint={an.kind === "conversion" ? `z = ${an.z.z.toFixed(2)} · two-sided${seq ? ` · always-valid p ${fmtP(seq.pAV)}` : ""}` : `Welch t · CUPED-adjusted · raw p = ${fmtP(an.raw.p)}${seq ? ` · always-valid p ${fmtP(seq.pAV)}` : ""}`} />
        <Stat label="Sample progress" value={`${Math.round(an.progress * 100)}%`} hint={`${Math.min(an.last.nA, an.last.nB).toLocaleString()} / ${e.plannedPerArm.toLocaleString()} per arm planned`} tone={an.progress >= 1 ? "ok" : "neutral"} />
      </div>
      <p className="text-sm muted mt-3">{v.reason}</p>

      <div className="grid lg:grid-cols-3 gap-4 mt-5 print-stack">
        <Section className="lg:col-span-2 rise rise-d1" title={`Relative lift over time · ${ciPct}% confidence interval`} sub={`Cumulative estimate by day with its delta-method interval, which includes the uncertainty of the control arm. Early days swing widely — decide at the planned sample size, or when the always-valid p-value crosses α.${an.kind === "continuous" ? " The dashed band is the CUPED-adjusted interval." : ""}`}>
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
        <Section className="rise rise-d2" title="Sequential monitoring" sub={<>Reading the fixed-horizon p-value every day and stopping at the first p &lt; α inflates false positives to ~19% (see <Link className="link" to="/docs">Docs</Link>). The always-valid p-value (mSPRT) stays valid under daily peeking, so it may be acted on the day it crosses α. Log scale.</>}>
          <PValueChart series={an.series} alpha={e.alpha} floor={P_PLOT_FLOOR} decidedDay={seq?.decidedDay ?? null} />
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4 print-stack">
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
            <Row k="Sample-ratio check" v={<span className={an.srm.mismatch ? "text-bad font-semibold" : "text-ok"}>{an.srm.mismatch ? "mismatch · " : "passed · "}χ² {an.srm.chi2.toFixed(2)} · p {fmtP(an.srm.p)}</span>} />
            <Row k={`Relative lift · ${ciPct}% CI (delta method)`} v={`${signedPct(rel.lift)} [${signedPct(rel.lo)}, ${signedPct(rel.hi)}]`} />
            <Row k={`Absolute difference · ${ciPct}% CI`} v={an.kind === "conversion" ? `${signedNum(100 * an.z.liftAbs)} pt [${signedNum(100 * an.z.ciLow)}, ${signedNum(100 * an.z.ciHigh)}]` : `${signedNum(an.adj.diff)} [${signedNum(an.adj.ciLow)}, ${signedNum(an.adj.ciHigh)}]`} />
            {seq && <Row k="Always-valid p (mSPRT)" v={<span className={seq.pAV < e.alpha ? "text-accent-text font-semibold" : ""}>{fmtP(seq.pAV)} · {seq.decidedDay !== null ? `crossed α on day ${seq.decidedDay}` : "not crossed"}</span>} />}
            <Row k="Decision basis" v={basis} />
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
                    <div className="mono text-2xl leading-none">{signedNum(r.diff)} <span className="text-sm faint">({signedPct(r.liftRel)})</span></div>
                    <IntervalBar lo={r.ciLow} hi={r.ciHigh} est={r.diff} domain={domain} color={c} />
                    <div className="mono text-xs faint">CI [{fmtNum(r.ciLow)}, {fmtNum(r.ciHigh)}] · p {fmtP(r.p)} · df {r.df.toFixed(0)}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>
      )}

      {e.notes && e.notes.trim() && (
        <Section className="mt-4 rise rise-d3" title="Notes">
          <p className="text-sm whitespace-pre-wrap">{e.notes.trim()}</p>
        </Section>
      )}

      {toast && <Toast key={toast.key} message={toast.message} actionLabel={toast.actionLabel} onAction={toast.onAction} onClose={closeToast} />}
    </Page>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
      <dt className="faint">{k}</dt>
      <dd className="mono text-right">{v}</dd>
    </div>
  );
}
