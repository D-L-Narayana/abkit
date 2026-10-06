import { AlertTriangle, ArrowRight, CircleCheck, Copy, Download, FileUp, Play, Plus, RotateCcw, ShieldAlert, Square, Trash2, Upload, type LucideIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FilterChip, SearchInput, SegmentedControl, SortSelect, type SortDir } from "../components/filters";
import { EmptyState, Page, Stat, Toast, toneChip } from "../components/ui";
import { analyse, verdict, type Analysis, type Verdict } from "../lib/analysis";
import { store, useExperiments, useQuarantine, type ImportResult } from "../lib/storage";
import type { Experiment } from "../model";
import { fmtNum, fmtP, fmtPct } from "../stats";
import { useTitle } from "../theme";

type Status = Experiment["status"];
type StatusFilter = "all" | Status;
type MetricFilter = "all" | Experiment["metricType"];
type SortKey = "start" | "lift" | "p" | "progress" | "name";
interface Row { e: Experiment; an: Analysis | null; v: Verdict | null }
interface ToastState { key: number; message: string; actionLabel?: string; onAction?: () => void }
interface Action { key: string; label: string; Icon: LucideIcon; onClick: () => void; danger?: boolean }

const STATUS_VALUES: readonly StatusFilter[] = ["all", "running", "completed", "stopped", "draft"];
const METRIC_VALUES: readonly MetricFilter[] = ["all", "conversion", "continuous"];
const SORT_KEYS: readonly SortKey[] = ["start", "lift", "p", "progress", "name"];
const DIRS: readonly SortDir[] = ["asc", "desc"];
const STATUS_LABEL: Record<StatusFilter, string> = { all: "All", running: "Running", completed: "Completed", stopped: "Stopped", draft: "Draft" };
const METRIC_LABEL: Record<MetricFilter, string> = { all: "All metrics", conversion: "Conversion", continuous: "Continuous" };
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "start", label: "Start date" },
  { value: "lift", label: "Lift" },
  { value: "p", label: "p-value" },
  { value: "progress", label: "Progress" },
  { value: "name", label: "Name" },
];
const DEFAULT_DIR: Record<SortKey, SortDir> = { start: "desc", lift: "desc", p: "asc", progress: "desc", name: "asc" };

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
const today = (): string => new Date().toISOString().slice(0, 10);

function analyseRow(e: Experiment): Row {
  try {
    const an = analyse(e);
    return { e, an, v: an ? verdict(e, an) : null };
  } catch {
    return { e, an: null, v: null };
  }
}

/** Sorts a copy; rows without a value for the key (no data yet) always go last. */
function sortRows(rows: Row[], key: SortKey, dir: SortDir): Row[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: Row, b: Row): number => a.e.name.localeCompare(b.e.name, undefined, { sensitivity: "base" });
  const num = (r: Row): number | null => {
    if (key === "lift") return r.v && Number.isFinite(r.v.lift) ? r.v.lift : null;
    if (key === "p") return r.v && Number.isFinite(r.v.p) ? r.v.p : null;
    if (key === "progress") return r.an ? r.an.progress : null;
    return null;
  };
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    if (key === "start") return sign * a.e.startDate.localeCompare(b.e.startDate) || byName(a, b);
    const x = num(a);
    const y = num(b);
    if (x === null && y === null) return byName(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y) || byName(a, b);
  });
}

/** Downloads in-memory text through a Blob URL (the CSP forbids data: URLs for navigation). */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importMessage(r: ImportResult, file: string): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${r.added} added`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  const reason = r.skipped[0]?.reason;
  if (!r.added && !r.updated) return reason ? `Could not import ${file}: ${reason}` : `Nothing new in ${file} — every experiment is already stored.`;
  return `Imported ${file}: ${parts.join(", ")}${reason ? ` — ${reason}` : ""}`;
}

function lifecycleNote(e: Experiment): string {
  const stoppedAt = e.stoppedAt?.slice(0, 10);
  const started = `started ${e.startDate}`;
  if (e.status === "running") return started;
  if (e.status === "draft") return "draft";
  return `${started} · ${e.status}${stoppedAt ? ` ${stoppedAt}` : ""}`;
}

export function Dashboard() {
  useTitle("Experiments — abkit");
  const list = useExperiments();
  const quarantine = useQuarantine();
  const firstReason = quarantine[0]?.reason;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [toast, setToastState] = useState<ToastState | null>(null);
  const closeToast = useCallback(() => setToastState(null), []);
  const toastSeq = useRef(0);
  const setToast = (t: Omit<ToastState, "key">) => setToastState({ ...t, key: ++toastSeq.current });
  const fileRef = useRef<HTMLInputElement>(null);

  // filter / sort state lives in the URL query so it survives navigation and can be shared
  const q = params.get("q") ?? "";
  const status = pick(params.get("status"), STATUS_VALUES, "all");
  const metric = pick(params.get("metric"), METRIC_VALUES, "all");
  const tags = params.getAll("tag");
  const sort = pick(params.get("sort"), SORT_KEYS, "start");
  const dir = pick(params.get("dir"), DIRS, DEFAULT_DIR[sort]);
  const hasFilters = q !== "" || status !== "all" || metric !== "all" || tags.length > 0;
  function update(patch: Record<string, string | string[] | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          next.delete(k);
          if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
          else if (v !== null && v !== "") next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  }

  const rows = useMemo(() => list.map(analyseRow), [list]);
  const running = rows.filter((r) => r.e.status === "running").length;
  const winners = rows.filter((r) => r.v?.decision === "winner").length; // fixed-horizon and sequential winners; SRM-invalid resolves to "invalid"
  const srms = rows.filter((r) => r.an?.srm.mismatch).length;
  const visitors = rows.reduce((s, r) => s + (r.an ? r.an.last.nA + r.an.last.nB : 0), 0);
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of list) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
  }, [list]);
  const statusOptions = STATUS_VALUES.map((s) => ({ value: s, label: STATUS_LABEL[s], count: s === "all" ? list.length : list.filter((e) => e.status === s).length }));
  const metricOptions = METRIC_VALUES.map((m) => ({ value: m, label: METRIC_LABEL[m] }));

  const needle = q.trim().toLowerCase();
  const visible = sortRows(
    rows.filter(
      ({ e }) =>
        (status === "all" || e.status === status) &&
        (metric === "all" || e.metricType === metric) &&
        (tags.length === 0 || tags.some((t) => e.tags.includes(t))) &&
        (needle === "" || [e.name, e.metric, e.owner, ...e.tags].some((s) => s.toLowerCase().includes(needle))),
    ),
    sort,
    dir,
  );

  // ----- actions
  function del(e: Experiment) {
    const index = list.findIndex((x) => x.id === e.id);
    store.remove(e.id);
    setToast({
      message: `Deleted “${e.name}”`,
      actionLabel: "Undo",
      onAction: () => {
        const cur = store.load().filter((x) => x.id !== e.id);
        const at = Math.min(Math.max(0, index), cur.length);
        store.save([...cur.slice(0, at), e, ...cur.slice(at)]);
      },
    });
  }
  function changeStatus(e: Experiment, next: Status, verb: string) {
    const previous = e.status;
    store.setStatus(e.id, next);
    setToast({ message: `${verb} “${e.name}”`, actionLabel: "Undo", onAction: () => store.setStatus(e.id, previous) });
  }
  function restoreDemo() {
    store.restoreDemo();
    setToast({ message: "Demo experiments restored" });
  }
  function exportAll() {
    download(`abkit-experiments-${today()}.json`, store.exportAll());
  }
  async function onImportFile(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    const text = await file.text();
    setToast({ message: importMessage(store.importAll(text), file.name) });
  }
  function actionsFor(e: Experiment): Action[] {
    const items: Action[] = [];
    if (e.status === "running") items.push({ key: "stop", label: "Stop", Icon: Square, onClick: () => changeStatus(e, "stopped", "Stopped") });
    if (e.status === "stopped" || e.status === "completed") items.push({ key: "resume", label: "Resume", Icon: Play, onClick: () => changeStatus(e, "running", "Resumed") });
    if (e.status === "running" || e.status === "stopped") items.push({ key: "complete", label: "Mark complete", Icon: CircleCheck, onClick: () => changeStatus(e, "completed", "Completed") });
    items.push({ key: "duplicate", label: "Duplicate", Icon: Copy, onClick: () => navigate(`/new?from=${encodeURIComponent(e.id)}`) });
    items.push({ key: "delete", label: "Delete", Icon: Trash2, onClick: () => del(e), danger: true });
    return items;
  }
  const iconActions = (e: Experiment) => (
    <div className="flex justify-end gap-0.5">
      {actionsFor(e).map(({ key, label, Icon, onClick, danger }) => (
        <button key={key} type="button" className={`btn btn-icon ${danger ? "btn-danger" : "btn-ghost border-transparent"}`} aria-label={`${label}: ${e.name}`} title={label} onClick={onClick}>
          <Icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
  const labelActions = (e: Experiment) => (
    <div className="flex flex-wrap gap-1.5">
      {actionsFor(e).map(({ key, label, Icon, onClick, danger }) =>
        danger ? (
          <button key={key} type="button" className="btn btn-danger btn-icon" aria-label={`${label}: ${e.name}`} title={label} onClick={onClick}><Icon size={15} aria-hidden="true" /></button>
        ) : (
          <button key={key} type="button" className="btn btn-ghost btn-sm" aria-label={`${label}: ${e.name}`} onClick={onClick}><Icon size={14} aria-hidden="true" /> {label}</button>
        ),
      )}
    </div>
  );
  const liftCell = (v: Verdict | null) => <span className={`mono ${v && v.lift > 0 ? "text-ok" : v && v.lift < 0 ? "text-bad" : ""}`}>{v ? `${v.lift > 0 ? "+" : ""}${fmtPct(v.lift)}` : "–"}</span>;
  const progressBar = (an: Analysis) => (
    <div className={`progress ${an.progress >= 1 ? "is-done" : ""}`} role="progressbar" aria-valuenow={Math.round(an.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Sample progress">
      <span style={{ width: `${Math.round(an.progress * 100)}%` }} />
    </div>
  );

  const dataTools = (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={exportAll} disabled={list.length === 0}><Download size={14} aria-hidden="true" /> Export all</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><FileUp size={14} aria-hidden="true" /> Import JSON</button>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(ev) => void onImportFile(ev)} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={restoreDemo}><RotateCcw size={14} aria-hidden="true" /> Restore demo set</button>
    </>
  );

  return (
    <Page
      eyebrow="Experimentation platform"
      title="Experiments"
      right={
        <>
          <Link to="/upload" className="btn btn-ghost btn-sm"><Upload size={14} aria-hidden="true" /> Upload CSV</Link>
          <Link to="/new" className="btn btn-primary btn-sm"><Plus size={14} aria-hidden="true" /> New experiment</Link>
        </>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 rise">
        <Stat label="Running" value={String(running)} hint={`${list.length} total`} />
        <Stat label="Winners shipped" value={String(winners)} tone={winners ? "ok" : "neutral"} hint="significant positive lift, no SRM" />
        <Stat label="SRM alerts" value={String(srms)} tone={srms ? "bad" : "neutral"} hint="sample-ratio mismatch at p < 0.001" />
        <Stat label="Visitors analysed" value={visitors.toLocaleString()} hint="across all experiments" />
      </div>

      {quarantine.length > 0 && (
        <div className="card mt-5 p-4 border-warn bg-warn-soft text-warn-ink flex flex-wrap items-center gap-3 rise" role="status">
          <ShieldAlert size={18} aria-hidden="true" className="shrink-0" />
          <div className="min-w-0 flex-1 text-sm">
            <strong>{quarantine.length} stored {quarantine.length === 1 ? "record" : "records"} could not be read</strong> and {quarantine.length === 1 ? "was" : "were"} set aside instead of being deleted.
            {firstReason && <span className="block text-xs mt-0.5 break-words">First reason: {firstReason}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => download(`abkit-quarantine-${today()}.json`, JSON.stringify(quarantine, null, 2))}><Download size={14} aria-hidden="true" /> Download JSON</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => store.discardQuarantine()}><Trash2 size={14} aria-hidden="true" /> Discard</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mt-5 rise rise-d1">
          <EmptyState
            title="No experiments yet"
            body="Create one with the wizard, upload a CSV of per-user rows, import a JSON export, or bring back the six demo experiments."
            action={
              <>
                <Link to="/new" className="btn btn-primary btn-sm"><Plus size={14} aria-hidden="true" /> Create experiment</Link>
                <Link to="/upload" className="btn btn-ghost btn-sm"><Upload size={14} aria-hidden="true" /> Upload CSV</Link>
                {dataTools}
              </>
            }
          />
        </div>
      ) : (
        <>
          <div className="card mt-5 p-3 grid gap-3 rise rise-d1">
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput label="Search experiments" value={q} onChange={(v) => update({ q: v })} placeholder="Search name, metric, owner or tag…" className="flex-1 min-w-[12rem] sm:max-w-sm" />
              <SortSelect value={sort} options={SORT_OPTIONS} onChange={(k) => update({ sort: k === "start" ? null : k, dir: null })} dir={dir} onDirChange={(d) => update({ dir: d === DEFAULT_DIR[sort] ? null : d })} />
              <p className="text-xs faint ml-auto num" aria-live="polite">Showing {visible.length} of {list.length}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl label="Status" value={status} options={statusOptions} onChange={(v) => update({ status: v === "all" ? null : v })} />
              <SegmentedControl label="Metric type" value={metric} options={metricOptions} onChange={(v) => update({ metric: v === "all" ? null : v })} />
              {hasFilters && <button type="button" className="btn-link text-sm" onClick={() => update({ q: null, status: null, metric: null, tag: null })}>Clear filters</button>}
            </div>
            {allTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag (any selected tag matches)">
                <span className="label mb-0 mr-1">Tags</span>
                {allTags.map(({ tag, count }) => (
                  <FilterChip key={tag} label={tag} count={count} pressed={tags.includes(tag)} onToggle={() => update({ tag: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag] })} />
                ))}
              </div>
            )}
          </div>

          {visible.length === 0 ? (
            <div className="mt-5">
              <EmptyState title="No experiments match" body="Try another search term or clear the filters." action={<button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ q: null, status: null, metric: null, tag: null })}>Clear filters</button>} />
            </div>
          ) : (
            <>
              {/* Desktop / tablet: table */}
              <div className="card mt-5 overflow-hidden rise rise-d2 hidden md:block">
                <div className="overflow-x-auto">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Experiment</th>
                        <th scope="col">Metric</th>
                        <th scope="col">Progress</th>
                        <th scope="col" className="text-right">Lift</th>
                        <th scope="col" className="text-right">p-value</th>
                        <th scope="col">Verdict</th>
                        <th scope="col" className="text-right"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(({ e, an, v }) => (
                        <tr key={e.id}>
                          <td className="max-w-[22rem]">
                            <Link to={`/exp/${e.id}`} className="font-medium hover:text-accent-text transition-colors">{e.name}</Link>
                            <div className="text-xs faint mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                              <span>{e.owner} · {lifecycleNote(e)}</span>
                              {e.tags.map((t) => <span key={t} className="chip h-5 text-[10px]">{t}</span>)}
                            </div>
                          </td>
                          <td className="text-sm">
                            {e.metric}
                            <div className="text-xs faint whitespace-nowrap">{e.metricType === "conversion" ? `baseline ${fmtPct(e.baseline, 1)}` : `baseline ${fmtNum(e.baseline, 0)}`} · MDE {fmtPct(e.mdeRel, 0)}</div>
                          </td>
                          <td className="min-w-36">
                            {an ? (
                              <div>
                                {progressBar(an)}
                                <div className="text-xs faint mt-1 num whitespace-nowrap">{(an.last.nA + an.last.nB).toLocaleString()} users · {e.days.length}d</div>
                              </div>
                            ) : (
                              <span className="text-xs faint">no data yet</span>
                            )}
                          </td>
                          <td className="text-right">{liftCell(v)}</td>
                          <td className="text-right mono">{v ? fmtP(v.p) : "–"}</td>
                          <td>{v && <span className={`chip ${toneChip[v.tone]}`} title={v.reason}>{v.tone === "bad" && <AlertTriangle size={12} aria-hidden="true" />}{v.label}</span>}</td>
                          <td className="text-right">{iconActions(e)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Phones: cards */}
              <ul className="md:hidden grid gap-3 mt-5 rise rise-d2" aria-label="Experiments">
                {visible.map(({ e, an, v }) => (
                  <li key={e.id} className="card p-4 grid gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link to={`/exp/${e.id}`} className="font-medium leading-snug block">{e.name}</Link>
                        <div className="text-xs faint mt-0.5">{e.metric} · {lifecycleNote(e)}</div>
                      </div>
                      {v && <span className={`chip shrink-0 ${toneChip[v.tone]}`}>{v.label}</span>}
                    </div>
                    {an && progressBar(an)}
                    <dl className="grid grid-cols-3 gap-2 text-sm">
                      <div><dt className="text-[11px] faint uppercase tracking-wider">Lift</dt><dd>{liftCell(v)}</dd></div>
                      <div><dt className="text-[11px] faint uppercase tracking-wider">p-value</dt><dd className="mono">{v ? fmtP(v.p) : "–"}</dd></div>
                      <div><dt className="text-[11px] faint uppercase tracking-wider">Users</dt><dd className="mono">{an ? (an.last.nA + an.last.nB).toLocaleString() : "–"}</dd></div>
                    </dl>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link to={`/exp/${e.id}`} className="btn btn-soft btn-sm">Open results <ArrowRight size={14} aria-hidden="true" /></Link>
                      {labelActions(e)}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">{dataTools}</div>
        </>
      )}
      <p className="text-xs faint mt-4 max-w-3xl">
        Demo experiments are simulated deterministically (seeded PRNG) with known true effects — one has a deliberate 1.2 pt bucketing skew to show the SRM guardrail, one has a novelty effect that fades, one uses a continuous metric with CUPED. Everything is stored in this browser only; export a JSON backup before clearing site data.
      </p>
      {toast && <Toast key={toast.key} message={toast.message} actionLabel={toast.actionLabel} onAction={toast.onAction} onClose={closeToast} />}
    </Page>
  );
}
