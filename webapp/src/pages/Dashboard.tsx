import { AlertTriangle, ArrowRight, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, Page, Stat, Toast, toneChip } from "../components/ui";
import { analyse, verdict } from "../lib/analysis";
import { loadExperiments, remove, seedExperiments, saveExperiments, upsert, type Experiment } from "../model";
import { fmtNum, fmtP, fmtPct } from "../stats";
import { useTitle } from "../theme";

export function Dashboard() {
  useTitle("Experiments — abkit");
  const [list, setList] = useState<Experiment[]>(() => loadExperiments());
  const [undo, setUndo] = useState<Experiment | null>(null);
  const rows = useMemo(() => list.map((e) => ({ e, an: analyse(e) })), [list]);
  const running = rows.filter((r) => r.e.status === "running").length;
  const winners = rows.filter((r) => r.an && verdict(r.e, r.an).label === "Winner").length;
  const srms = rows.filter((r) => r.an?.srm.mismatch).length;
  const visitors = rows.reduce((s, r) => s + (r.an ? r.an.last.nA + r.an.last.nB : 0), 0);
  const closeToast = useCallback(() => setUndo(null), []);

  function del(e: Experiment) {
    setList(remove(e.id));
    setUndo(e);
  }
  function restoreDemo() {
    const seeded = seedExperiments();
    const merged = [...list.filter((e) => !seeded.some((s) => s.id === e.id)), ...seeded];
    saveExperiments(merged);
    setList(merged);
  }

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

      {rows.length === 0 ? (
        <div className="mt-5 rise rise-d1">
          <EmptyState
            title="No experiments yet"
            body="Create one with the wizard, upload a CSV of per-user rows, or bring back the six demo experiments."
            action={
              <>
                <Link to="/new" className="btn btn-primary btn-sm"><Plus size={14} aria-hidden="true" /> Create experiment</Link>
                <Link to="/upload" className="btn btn-ghost btn-sm"><Upload size={14} aria-hidden="true" /> Upload CSV</Link>
                <button type="button" className="btn btn-ghost btn-sm" onClick={restoreDemo}><RotateCcw size={14} aria-hidden="true" /> Restore demo data</button>
              </>
            }
          />
        </div>
      ) : (
        <>
          {/* Desktop / tablet: table */}
          <div className="card mt-5 overflow-hidden rise rise-d1 hidden md:block">
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
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ e, an }) => {
                    const v = an ? verdict(e, an) : null;
                    return (
                      <tr key={e.id}>
                        <td className="max-w-[22rem]">
                          <Link to={`/exp/${e.id}`} className="font-medium hover:text-accent-text transition-colors">{e.name}</Link>
                          <div className="text-xs faint mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                            <span>{e.owner} · started {e.startDate}</span>
                            {e.tags.map((t) => <span key={t} className="chip h-5 text-[10px]">{t}</span>)}
                          </div>
                        </td>
                        <td className="text-sm">
                          {e.metric}
                          <div className="text-xs faint whitespace-nowrap">{e.metricType === "conversion" ? `baseline ${fmtPct(e.baseline, 1)}` : `baseline ${fmtNum(e.baseline, 0)}`} · MDE {fmtPct(e.mdeRel, 0)}</div>
                        </td>
                        <td className="min-w-36">
                          {an && (
                            <div>
                              <div className={`progress ${an.progress >= 1 ? "is-done" : ""}`} role="progressbar" aria-valuenow={Math.round(an.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Sample progress">
                                <span style={{ width: `${Math.round(an.progress * 100)}%` }} />
                              </div>
                              <div className="text-xs faint mt-1 num whitespace-nowrap">{(an.last.nA + an.last.nB).toLocaleString()} users · {e.days.length}d</div>
                            </div>
                          )}
                        </td>
                        <td className={`text-right mono ${v && v.lift > 0 ? "text-ok" : v && v.lift < 0 ? "text-bad" : ""}`}>{v ? `${v.lift > 0 ? "+" : ""}${fmtPct(v.lift)}` : "–"}</td>
                        <td className="text-right mono">{v ? fmtP(v.p) : "–"}</td>
                        <td>{v && <span className={`chip ${toneChip[v.tone]}`} title={v.reason}>{v.tone === "bad" && <AlertTriangle size={12} aria-hidden="true" />}{v.label}</span>}</td>
                        <td className="text-right">
                          <button type="button" className="btn btn-danger btn-icon" aria-label={`Delete ${e.name}`} title="Delete experiment" onClick={() => del(e)}>
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phones: cards */}
          <ul className="md:hidden grid gap-3 mt-5 rise rise-d1" aria-label="Experiments">
            {rows.map(({ e, an }) => {
              const v = an ? verdict(e, an) : null;
              return (
                <li key={e.id} className="card p-4 grid gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/exp/${e.id}`} className="font-medium leading-snug block">{e.name}</Link>
                      <div className="text-xs faint mt-0.5">{e.metric} · started {e.startDate}</div>
                    </div>
                    {v && <span className={`chip shrink-0 ${toneChip[v.tone]}`}>{v.label}</span>}
                  </div>
                  {an && (
                    <div className={`progress ${an.progress >= 1 ? "is-done" : ""}`} role="progressbar" aria-valuenow={Math.round(an.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Sample progress">
                      <span style={{ width: `${Math.round(an.progress * 100)}%` }} />
                    </div>
                  )}
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    <div><dt className="text-[11px] faint uppercase tracking-wider">Lift</dt><dd className={`mono ${v && v.lift > 0 ? "text-ok" : v && v.lift < 0 ? "text-bad" : ""}`}>{v ? `${v.lift > 0 ? "+" : ""}${fmtPct(v.lift)}` : "–"}</dd></div>
                    <div><dt className="text-[11px] faint uppercase tracking-wider">p-value</dt><dd className="mono">{v ? fmtP(v.p) : "–"}</dd></div>
                    <div><dt className="text-[11px] faint uppercase tracking-wider">Users</dt><dd className="mono">{an ? (an.last.nA + an.last.nB).toLocaleString() : "–"}</dd></div>
                  </dl>
                  <div className="flex items-center justify-between">
                    <Link to={`/exp/${e.id}`} className="btn btn-soft btn-sm">Open results <ArrowRight size={14} aria-hidden="true" /></Link>
                    <button type="button" className="btn btn-danger btn-icon" aria-label={`Delete ${e.name}`} title="Delete experiment" onClick={() => del(e)}><Trash2 size={15} aria-hidden="true" /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="text-xs faint mt-4 max-w-3xl">
        Demo experiments are simulated deterministically (seeded PRNG) with known true effects — one has a deliberate 1.2 pt bucketing skew to show the SRM guardrail, one has a novelty effect that fades, one uses a continuous metric with CUPED.
        {list.length > 0 && list.length < 6 && (
          <>
            {" "}<button type="button" className="btn-link" onClick={restoreDemo}>Restore the demo set</button>.
          </>
        )}
      </p>
      {undo && <Toast message={`Deleted “${undo.name}”`} actionLabel="Undo" onAction={() => setList(upsert(undo))} onClose={closeToast} />}
    </Page>
  );
}
