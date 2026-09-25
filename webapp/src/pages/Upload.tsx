import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Field, Page } from "../components/ui";
import { parseCsv, upsert } from "../model";
import { useTitle } from "../theme";

const SAMPLE = "variant,converted,day\nA,1,1\nA,0,1\nB,1,1\nB,1,1\nA,0,2\nB,0,2";

export function UploadPage() {
  useTitle("Upload CSV — abkit");
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [name, setName] = useState("Uploaded experiment");

  async function onFile(file: File) {
    setBusy(true);
    setErr(null);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("That file is larger than 25 MB — aggregate it per day first.");
      const e = parseCsv(await file.text(), name.trim() || file.name.replace(/\.csv$/i, ""));
      upsert(e);
      nav(`/exp/${e.id}`);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page eyebrow="Import" title="Upload experiment data" lede="One row per user. Parsing and statistics run locally — the file never leaves your browser.">
      <div className="grid lg:grid-cols-[1fr_360px] gap-4">
        <div className="card p-5 md:p-6 rise">
          <Field label="Experiment name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <label
            className={`dropzone mt-4 grid place-items-center gap-2 min-h-52 cursor-pointer text-center p-6 ${over ? "is-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void onFile(f); }}
          >
            <Upload className="text-accent-text" aria-hidden="true" />
            <span className="font-medium">{busy ? "Parsing…" : "Drop a CSV here or click to choose"}</span>
            <span className="text-xs faint max-w-md">
              Columns: <code className="mono">variant</code> (A/B or control/treatment), <code className="mono">converted</code> (0/1) or <code className="mono">value</code> (number), optional <code className="mono">pre_value</code> for CUPED and <code className="mono">day</code>.
            </span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} disabled={busy} />
          </label>
          {err && <p role="alert" className="text-sm text-bad-ink bg-bad-soft rounded-lg p-3 mt-3">{err}</p>}
        </div>
        <aside className="card p-5 rise rise-d1 self-start">
          <span className="label">Example</span>
          <pre className="formula">{SAMPLE}</pre>
          <div className="flex flex-wrap gap-2 mt-3">
            <a className="btn btn-ghost btn-sm" href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`} download="abkit-sample.csv"><Download size={14} aria-hidden="true" /> Download sample</a>
            <a className="btn btn-ghost btn-sm" href={`data:text/csv;charset=utf-8,${encodeURIComponent("variant,value,pre_value,day\nA,412,380,1\nB,455,390,1\nA,120,140,1\nB,610,590,2\nA,390,410,2\nB,402,388,2")}`} download="abkit-sample-cuped.csv"><FileSpreadsheet size={14} aria-hidden="true" /> Continuous + CUPED</a>
          </div>
          <p className="text-xs faint mt-3">Variant labels accepted for treatment: B, treatment, variant, test, 1 — anything else counts as control.</p>
        </aside>
      </div>
    </Page>
  );
}
