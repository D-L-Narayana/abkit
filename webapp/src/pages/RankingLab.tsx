import { Dices } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Legend, axisTick, tooltipProps } from "../components/charts";
import { Field, Page, Section } from "../components/ui";
import { fmtP, mrr, mulberry32, ndcgAtK, precisionAtK, teamDraft, twoProportionZ } from "../stats";
import { useTitle } from "../theme";

const SESSIONS = 400;
const parse = (s: string) => s.split(/[,\s]+/).map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)).map((x) => Math.max(0, Math.min(3, Math.round(x))));

export function RankingLab() {
  useTitle("Ranking lab — abkit");
  const [k, setK] = useState(5);
  const [relA, setRelA] = useState("3,2,3,0,1,2,0,0,1,0");
  const [relB, setRelB] = useState("3,3,2,2,1,0,1,0,0,0");
  const [seed, setSeed] = useState(7);

  const sim = useMemo(() => {
    const a = parse(relA), b = parse(relB);
    const n = Math.max(a.length, b.length);
    const A = Array.from({ length: n }, (_, i) => a[i] ?? 0), B = Array.from({ length: n }, (_, i) => b[i] ?? 0);
    const items = A.map((_, i) => `d${i + 1}`);
    const rnd = mulberry32(seed);
    const rankA = [...items].sort((x, y) => A[items.indexOf(y)]! - A[items.indexOf(x)]! + (rnd() - 0.5) * 2.5);
    const rankB = [...items].sort((x, y) => B[items.indexOf(y)]! - B[items.indexOf(x)]! + (rnd() - 0.5) * 1.2);
    const { list, teams } = teamDraft(rankA, rankB, rnd);
    const wins = { A: 0, B: 0, tie: 0 };
    for (let s = 0; s < SESSIONS; s++) {
      let ca = 0, cb = 0;
      list.forEach((it, pos) => {
        const rel = Math.max(A[items.indexOf(it)]!, B[items.indexOf(it)]!);
        if (rnd() < ((rel / 3) * 0.7) / Math.sqrt(pos + 1)) { if (teams[pos] === "A") ca++; else cb++; }
      });
      if (ca > cb) wins.A++; else if (cb > ca) wins.B++; else wins.tie++;
    }
    const rel = (it: string) => Math.max(A[items.indexOf(it)] ?? 0, B[items.indexOf(it)] ?? 0);
    return { A, B, n, list, teams, wins, rel };
  }, [relA, relB, seed]);

  const { A, B, n, list, teams, wins, rel } = sim;
  const rows = [["Ranker A", A], ["Ranker B", B]] as const;
  const decided = wins.A + wins.B;
  const p = decided > 0 ? twoProportionZ(wins.A, decided, wins.B, decided).p : NaN;
  const winner = wins.A > wins.B ? "Ranker A" : wins.B > wins.A ? "Ranker B" : "a tie";

  return (
    <Page eyebrow="Search quality" title="Ranking metrics playground" lede="Compare two rankers offline with graded relevance, then online with team-draft interleaving over simulated position-biased clicks.">
      <div className="grid lg:grid-cols-2 gap-4">
        <Section className="rise" title="Offline metrics" sub="Enter graded relevance (0–3) of the document at each position for both rankers. Values are clamped to 0–3.">
          <div className="grid gap-3">
            <Field label="Ranker A — relevance by position"><input className="input mono" value={relA} onChange={(e) => setRelA(e.target.value)} inputMode="numeric" spellCheck={false} /></Field>
            <Field label="Ranker B — relevance by position"><input className="input mono" value={relB} onChange={(e) => setRelB(e.target.value)} inputMode="numeric" spellCheck={false} /></Field>
            <Field label={`Cut-off k = ${k}`}><input type="range" min={1} max={Math.max(1, n)} value={Math.min(k, Math.max(1, n))} onChange={(e) => setK(Number(e.target.value))} className="range" aria-valuetext={`k = ${k}`} /></Field>
          </div>
          <div className="overflow-x-auto -mx-2 mt-3">
            <table className="data">
              <thead><tr><th scope="col">Ranker</th><th scope="col" className="text-right">NDCG@{k}</th><th scope="col" className="text-right">MRR</th><th scope="col" className="text-right">P@{k}</th></tr></thead>
              <tbody>
                {rows.map(([name, r]) => (
                  <tr key={name}><td>{name}</td><td className="text-right mono">{ndcgAtK(r, k).toFixed(3)}</td><td className="text-right mono">{mrr([r.map((x) => x > 0)]).toFixed(3)}</td><td className="text-right mono">{precisionAtK(r.map((x) => x > 0), k).toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4">
            <Legend items={[{ color: "var(--chart-a)", label: "Ranker A" }, { color: "var(--accent)", label: "Ranker B" }]} />
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={Array.from({ length: n }, (_, i) => ({ pos: i + 1, A: A[i] ?? 0, B: B[i] ?? 0 }))} margin={{ left: -24, right: 4, top: 4 }} barGap={2}>
                <XAxis dataKey="pos" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} />
                <YAxis domain={[0, 3]} ticks={[0, 1, 2, 3]} tick={axisTick} tickLine={false} axisLine={false} />
                <Tooltip {...tooltipProps} labelFormatter={(l) => `Position ${l}`} />
                <Bar dataKey="A" fill="var(--chart-a)" radius={2} isAnimationActive={false} name="Ranker A" />
                <Bar dataKey="B" fill="var(--accent)" radius={2} isAnimationActive={false} name="Ranker B" />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs faint mt-1">Relevance by position. NDCG rewards putting high grades early with a log₂ discount.</p>
          </div>
        </Section>

        <Section className="rise rise-d1" title="Team-draft interleaving" sub={`Both rankers "pick" alternately into one list shown to the user; clicks are credited to the team that picked the item. ${SESSIONS} simulated sessions with position-biased clicks.`}>
          <ol className="grid gap-1.5" aria-label="Interleaved list">
            {list.map((it, i) => (
              <li key={it} className="flex items-center gap-3 text-sm rounded-lg px-2 py-1 hover:bg-bg2">
                <span className="mono w-5 text-right faint">{i + 1}</span>
                <span className={`chip w-8 justify-center ${teams[i] === "A" ? "" : "chip-accent"}`}>{teams[i]}</span>
                <span className="mono flex-1">{it}</span>
                <span className="faint text-xs">rel {rel(it)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {(["A", "B", "tie"] as const).map((t) => (
              <div key={t} className="rounded-xl bg-bg2 border border-line p-3">
                <div className="text-[11px] faint uppercase tracking-wider">{t === "tie" ? "ties" : `${t} wins`}</div>
                <div className="mono text-xl font-semibold">{wins[t]}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>Winner: <b>{winner}</b> · binomial p = <span className="mono">{fmtP(p)}</span></span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSeed(seed + 1)}><Dices size={14} aria-hidden="true" /> Re-roll sessions</button>
          </div>
        </Section>
      </div>
    </Page>
  );
}
