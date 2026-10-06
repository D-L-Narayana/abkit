import { AlertTriangle, Download, FileSpreadsheet, FileText, Upload } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Field, Page } from "../components/ui";
import { parseCsvText, type ParseResult } from "../lib/csv";
import { store } from "../lib/storage";
import { fmtNum, fmtPct } from "../stats";
import { useTitle } from "../theme";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ISSUES = 20;

const SAMPLE_PER_USER = ["variant,converted,day", "A,1,1", "A,0,1", "B,1,1", "B,1,1", "A,0,1", "B,0,1", "A,1,2", "B,1,2", "A,0,2", "B,1,2", "A,0,2", "B,0,2", ""].join("\n");
const SAMPLE_AGGREGATED = ["day,variant,users,conversions", "1,A,1000,100", "1,B,1000,115", "2,A,980,96", "2,B,1020,121", "3,A,1010,104", "3,B,990,118", ""].join("\n");
const SAMPLE_CUPED = ["variant,value,pre_value,day", "A,412,380,1", "B,455,390,1", "A,120,140,1", "B,610,590,1", "A,390,410,2", "B,402,388,2", "A,275,300,2", "B,520,480,2", ""].join("\n");

/** Offers `content` as a file download through a Blob URL (no data: URLs — the content-security policy forbids them). */
function downloadText(filename: string, content: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

type Parsed = { ok: true; result: ParseResult } | { ok: false; error: string };
function safeParse(text: string, name: string, controlLabel: string, plannedPerArm: number | undefined): Parsed {
  try {
    return { ok: true, result: parseCsvText(text, name, { controlLabel: controlLabel.trim() || undefined, plannedPerArm }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function UploadPage() {
  useTitle("Upload CSV — abkit");
  const nav = useNavigate();
  const [name, setName] = useState("Uploaded experiment");
  const [nameTouched, setNameTouched] = useState(false);
  const [controlLabel, setControlLabel] = useState("");
  const [planned, setPlanned] = useState("");
  const [pasted, setPasted] = useState("");
  const [source, setSource] = useState<{ text: string; from: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const plannedNum = planned.trim() === "" ? undefined : Number(planned);
  const plannedInvalid = plannedNum !== undefined && !(Number.isInteger(plannedNum) && plannedNum >= 0);
  const parsed = useMemo(() => (source && !plannedInvalid ? safeParse(source.text, "preview", controlLabel, plannedNum) : null), [source, controlLabel, plannedNum, plannedInvalid]);
  const error = readError ?? (parsed && !parsed.ok ? parsed.error : null);

  async function onFile(file: File) {
    setBusy(true);
    setReadError(null);
    try {
      if (file.size > MAX_BYTES) throw new Error("That file is larger than 25 MB — aggregate it per day first (see the aggregated format below).");
      const text = await file.text();
      if (!nameTouched) setName(file.name.replace(/\.(csv|txt|tsv)$/i, "") || "Uploaded experiment");
      setSource({ text, from: file.name });
    } catch (err) {
      setSource(null);
      setReadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function usePasted() {
    setReadError(null);
    if (!pasted.trim()) { setSource(null); setReadError("Paste some CSV text first (header row plus data rows)."); return; }
    setSource({ text: pasted, from: "pasted text" });
  }

  function create(result: ParseResult) {
    const experiment = { ...result.experiment, name: name.trim() || "Uploaded experiment" };
    store.upsert(experiment);
    nav(`/exp/${experiment.id}`);
  }

  return (
    <Page eyebrow="Import" title="Upload experiment data" lede="One row per user, or one row per arm and day. Parsing and statistics run locally — the file never leaves your browser.">
      <div className="grid lg:grid-cols-[1fr_360px] gap-4">
        <div className="grid gap-4 min-w-0">
          <div className="card p-5 md:p-6 rise grid gap-4">
            <div className="grid sm:grid-cols-[1fr_200px] gap-3">
              <Field label="Experiment name">
                <input className="input" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
              </Field>
              <Field label="Planned users per arm" hint="Optional — enables the sequential verdict while collecting." error={plannedInvalid ? "Enter a whole number ≥ 0." : null}>
                <input className="input mono" inputMode="numeric" value={planned} onChange={(e) => setPlanned(e.target.value)} placeholder="e.g. 20000" aria-invalid={plannedInvalid} />
              </Field>
            </div>
            <label
              className={`dropzone grid place-items-center gap-2 min-h-48 cursor-pointer text-center p-6 ${over ? "is-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void onFile(f); }}
            >
              <Upload className="text-accent-text" aria-hidden="true" />
              <span className="font-medium">{busy ? "Reading…" : source ? `Loaded ${source.from} — drop another file to replace it` : "Drop a CSV here or click to choose"}</span>
              <span className="text-xs faint max-w-md">
                Per user: <code className="mono">variant</code>, <code className="mono">converted</code> (0/1, yes/no) or <code className="mono">value</code>, optional <code className="mono">pre_value</code> and <code className="mono">day</code>.
                Aggregated: <code className="mono">variant</code>, <code className="mono">users</code>, <code className="mono">conversions</code> or <code className="mono">sum</code> + <code className="mono">sum_sq</code>, optional CUPED sums and <code className="mono">day</code>.
              </span>
              <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} disabled={busy} />
            </label>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Paste CSV text instead</summary>
              <div className="grid gap-2 mt-3">
                <Field label="CSV text" hint="Header row first; comma, semicolon or tab separated.">
                  <textarea className="input mono text-xs" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} />
                </Field>
                <div><button type="button" className="btn btn-ghost btn-sm" onClick={usePasted}><FileText size={14} aria-hidden="true" /> Preview pasted text</button></div>
              </div>
            </details>
            <Field label="Control label" hint='Optional — needed only when the labels are not A/B, control/treatment, 0/1 or similar (e.g. "old").'>
              <input className="input" value={controlLabel} onChange={(e) => setControlLabel(e.target.value)} placeholder="auto-detect" />
            </Field>
            {error && (
              <p role="alert" className="text-sm text-bad-ink bg-bad-soft rounded-lg p-3 flex gap-2 items-start">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
          </div>
          {parsed?.ok && <Preview result={parsed.result} onCreate={() => create(parsed.result)} />}
        </div>

        <aside className="card p-5 rise rise-d1 self-start grid gap-3">
          <span className="label">Sample files</span>
          <pre className="formula text-xs">{SAMPLE_PER_USER.trim()}</pre>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadText("abkit-sample-per-user.csv", SAMPLE_PER_USER)}><Download size={14} aria-hidden="true" /> Download sample (per-user)</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadText("abkit-sample-aggregated.csv", SAMPLE_AGGREGATED)}><FileSpreadsheet size={14} aria-hidden="true" /> Download sample (aggregated)</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadText("abkit-sample-cuped.csv", SAMPLE_CUPED)}><FileSpreadsheet size={14} aria-hidden="true" /> Download sample (continuous + CUPED)</button>
          </div>
          <p className="text-xs faint">
            Control labels: A, control, ctrl, 0, baseline. Treatment labels: B, treatment, variant, test, 1. Any other pair of two labels works too — the first one in the file becomes control unless you name it above.
            Quoted cells, semicolons or tabs, Windows line endings and a byte-order mark are all fine. Rows that cannot be read are listed, never silently dropped.
          </p>
          <p className="text-xs faint">
            Exports from the results page use the aggregated format with every sufficient statistic, so they re-import to exactly the same numbers. See <Link className="link" to="/docs#csv-formats">Docs → CSV formats</Link>.
          </p>
        </aside>
      </div>
    </Page>
  );
}

function Preview({ result, onCreate }: { result: ParseResult; onCreate: () => void }) {
  const e = result.experiment;
  const conversion = e.metricType === "conversion";
  const totalA = e.days.reduce((s, d) => s + d.nA, 0), totalB = e.days.reduce((s, d) => s + d.nB, 0);
  const convA = e.days.reduce((s, d) => s + d.convA, 0), convB = e.days.reduce((s, d) => s + d.convB, 0);
  const sumA = e.days.reduce((s, d) => s + d.sumsA.sy, 0), sumB = e.days.reduce((s, d) => s + d.sumsB.sy, 0);
  const headline = conversion ? `${fmtPct(convA / Math.max(1, totalA))} → ${fmtPct(convB / Math.max(1, totalB))}` : `${fmtNum(sumA / Math.max(1, totalA))} → ${fmtNum(sumB / Math.max(1, totalB))}`;
  const shownIssues = result.skipped.slice(0, MAX_ISSUES);
  return (
    <section className="card p-5 md:p-6 rise rise-d1 grid gap-4" aria-labelledby="upload-preview-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="upload-preview-h" className="text-base font-semibold">Preview — nothing is saved yet</h2>
        <div className="flex flex-wrap gap-2">
          <span className="chip chip-accent">{result.format}</span>
          <span className="chip">{conversion ? "conversion metric" : "continuous metric"}</span>
          {result.hasPre && <span className="chip chip-teal">CUPED covariate</span>}
        </div>
      </div>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Row k="Format" v={result.format === "per-user" ? "per-user (one row per user)" : "aggregated (one row per arm and day)"} />
        <Row k="Rows used" v={result.rows.toLocaleString()} />
        <Row k="Control label" v={<span className="mono">{result.labels.control}</span>} />
        <Row k="Treatment label" v={<span className="mono">{result.labels.treatment}</span>} />
        <Row k="Days" v={`${e.days.length} (${e.startDate} onwards)`} />
        <Row k="Users per arm" v={`${totalA.toLocaleString()} control · ${totalB.toLocaleString()} treatment`} />
        <Row k={conversion ? "Conversion rate A → B" : "Mean A → B"} v={<span className="mono">{headline}</span>} />
        <Row k="CUPED covariate" v={result.hasPre ? "present (pre-period values)" : "none"} />
      </dl>
      {result.warnings.length > 0 && (
        <ul className="grid gap-1 text-sm text-warn-ink bg-warn-soft rounded-lg p-3" aria-label="Warnings">
          {result.warnings.map((w) => (
            <li key={w} className="flex gap-2 items-start"><AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" /><span>{w}</span></li>
          ))}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">{result.skipped.length.toLocaleString()} row{result.skipped.length === 1 ? "" : "s"} skipped{result.skipped.length > MAX_ISSUES ? ` — first ${MAX_ISSUES} shown` : ""}</p>
          <ul className="mt-1 grid gap-0.5 faint mono text-xs max-h-48 overflow-auto" aria-label="Skipped rows">
            {shownIssues.map((i) => (
              <li key={`${i.row}-${i.reason}`}>line {i.row}: {i.reason}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={onCreate}>Create experiment</button>
        <span className="text-xs faint">Saves to this browser's storage and opens the results.</span>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-b border-line pb-1">
      <dt className="faint">{k}</dt>
      <dd className="text-right min-w-0 break-words">{v}</dd>
    </div>
  );
}
