import { Check, Dices, Link2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { IntervalBar, Legend, axisTick, tooltipProps } from "../components/charts";
import { Field, Page, Section, useCopy } from "../components/ui";
import { buildRankings, interleavingTest, parseGrades, simulateSessions } from "../lib/interleaving";
import { fmtP, mrr, mulberry32, ndcgAtK, precisionAtK, teamDraft } from "../stats";
import { useTitle } from "../theme";

/** Lab state. It is mirrored into the URL query (?a=&b=&k=&seed=&n=) so a lab can be shared or bookmarked. */
interface LabState { a: string; b: string; k: number; seed: number; n: number }
const MAX_POSITIONS = 20;
const SESSIONS = { min: 100, max: 2000, step: 50 } as const;
const DEFAULTS: LabState = { a: "3,2,3,0,1,2,0,0,1,0", b: "3,3,2,2,1,0,1,0,0,0", k: 5, seed: 7, n: 400 };
/** Typing and slider drags update the URL at most every URL_DEBOUNCE_MS (browsers throttle history updates). */
const URL_DEBOUNCE_MS = 150;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}
function fromParams(params: URLSearchParams): LabState {
  return {
    a: params.get("a") ?? DEFAULTS.a,
    b: params.get("b") ?? DEFAULTS.b,
    k: clampInt(params.get("k"), DEFAULTS.k, 1, MAX_POSITIONS),
    seed: clampInt(params.get("seed"), DEFAULTS.seed, 0, 2147483647),
    n: clampInt(params.get("n"), DEFAULTS.n, SESSIONS.min, SESSIONS.max),
  };
}
/** Query string with literal commas so shared links stay readable: a=3,2,1&b=…&k=5&seed=7&n=400 */
function serialize(s: LabState): string {
  return (["a", "b", "k", "seed", "n"] as const).map((key) => `${key}=${encodeURIComponent(String(s[key])).replace(/%2C/gi, ",")}`).join("&");
}
const signedPct = (x: number): string => `${x > 0 ? "+" : x < 0 ? "−" : ""}${(100 * Math.abs(x)).toFixed(1)}%`;

export function RankingLab() {
  useTitle("Ranking lab — abkit");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [copied, copy] = useCopy();
  // Local state keeps typing synchronous (router updates are transitions, which must not drive a controlled input).
  const [state, setState] = useState<LabState>(() => fromParams(params));
  const pushed = useRef(new Set<string>()); // our own URL writes whose router echo has not arrived yet
  // URL → state: a new link or in-app navigation. Echoes of our own writes (possibly already superseded by typing) are ignored.
  useEffect(() => {
    const fromUrl = fromParams(params);
    if (pushed.current.delete(serialize(fromUrl))) return;
    setState((s) => (serialize(s) === serialize(fromUrl) ? s : fromUrl));
  }, [params]);
  // state → URL, debounced and with replace so typing neither floods the history nor trips the browser's rate limit.
  useEffect(() => {
    const next = serialize(state);
    if (next === serialize(fromParams(params))) return;
    const id = window.setTimeout(() => {
      pushed.current.add(next);
      navigate({ search: `?${next}` }, { replace: true });
    }, URL_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [state, params, navigate]);
  const update = (patch: Partial<LabState>) => setState((s) => ({ ...s, ...patch }));
  const { a: relA, b: relB, seed, n: sessions } = state;

  const sim = useMemo(() => {
    const a = parseGrades(relA, MAX_POSITIONS), b = parseGrades(relB, MAX_POSITIONS);
    const n = Math.max(a.length, b.length);
    const A = Array.from({ length: n }, (_, i) => a[i] ?? 0), B = Array.from({ length: n }, (_, i) => b[i] ?? 0);
    const { grades, orderA, orderB } = buildRankings(A, B);
    const rnd = mulberry32(seed);
    const draft = teamDraft(orderA, orderB, rnd); // one example list; every simulated session re-draws the coin flips
    const wins = simulateSessions(A, B, sessions, rnd);
    const approximated = orderA.some((d, i) => grades[d] !== A[i]) || orderB.some((d, i) => grades[d] !== B[i]);
    return { A, B, n, grades, orderA, orderB, draft, wins, approximated };
  }, [relA, relB, seed, sessions]);

  const { A, B, n, grades, orderA, orderB, draft, wins, approximated } = sim;
  const k = Math.min(state.k, Math.max(1, n));
  const test = interleavingTest(wins.winsA, wins.winsB, wins.ties);
  const winner = test.winner === "A" ? "Ranker A" : test.winner === "B" ? "Ranker B" : "no significant preference";
  const rows = [["Ranker A", A], ["Ranker B", B]] as const;
  const doc = (i: number) => `d${i + 1}`;

  return (
    <Page
      eyebrow="Search quality"
      title="Ranking metrics playground"
      lede="Compare two rankers offline with graded relevance, then online with team-draft interleaving over simulated position-biased clicks. The lab's state is in the page URL, so it can be shared."
      right={
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(`${window.location.origin}${window.location.pathname}?${serialize(state)}`)}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />} {copied ? "Link copied" : "Copy link"}
        </button>
      }
    >
      <div className="grid lg:grid-cols-2 gap-4">
        <Section className="rise" title="Offline metrics" sub={`Enter the graded relevance (0–3) of the document at each position for both rankers — up to ${MAX_POSITIONS} positions. Values are clamped to 0–3.`}>
          <div className="grid gap-3">
            <Field label="Ranker A — relevance by position"><input className="input mono" value={relA} onChange={(e) => update({ a: e.target.value })} inputMode="numeric" spellCheck={false} autoComplete="off" /></Field>
            <Field label="Ranker B — relevance by position"><input className="input mono" value={relB} onChange={(e) => update({ b: e.target.value })} inputMode="numeric" spellCheck={false} autoComplete="off" /></Field>
            <Field label={`Cut-off k = ${k}`}><input type="range" min={1} max={Math.max(1, n)} value={k} onChange={(e) => update({ k: Number(e.target.value) })} className="range" aria-valuetext={`k = ${k}`} /></Field>
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

        <Section className="rise rise-d1" title="Team-draft interleaving" sub="Both rankers order one shared pool of documents and “pick” alternately into one list shown to the user; clicks are credited to the team that picked the item. Each simulated session re-draws the coin flips and the position-biased clicks.">
          <Field label={`Sessions: ${sessions}`} hint={`${SESSIONS.min}–${SESSIONS.max} simulated sessions.`}>
            <input type="range" className="range" min={SESSIONS.min} max={SESSIONS.max} step={SESSIONS.step} value={sessions} onChange={(e) => update({ n: Number(e.target.value) })} aria-valuetext={`${sessions} sessions`} />
          </Field>
          <div className="grid gap-1 text-xs faint mt-2 mb-3 mono break-words">
            <span>A shows: {orderA.map(doc).join(" ")}</span>
            <span>B shows: {orderB.map(doc).join(" ")}</span>
          </div>
          {approximated && <p className="text-xs muted mb-3">The two lists are not permutations of each other, so some positions got the nearest available grade from the shared pool (grades shown below).</p>}
          <ol className="grid gap-1.5" aria-label="One interleaved list">
            {draft.list.map((d, i) => (
              <li key={d} className="flex items-center gap-3 text-sm rounded-lg px-2 py-1 hover:bg-bg2">
                <span className="mono w-5 text-right faint">{i + 1}</span>
                <span className={`chip w-8 justify-center ${draft.teams[i] === "A" ? "" : "chip-accent"}`}>{draft.teams[i]}</span>
                <span className="mono flex-1">{doc(d)}</span>
                <span className="faint text-xs">rel {grades[d]}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {([["A", wins.winsA], ["B", wins.winsB], ["tie", wins.ties]] as const).map(([t, v]) => (
              <div key={t} className="rounded-xl bg-bg2 border border-line p-3">
                <div className="text-[11px] faint uppercase tracking-wider">{t === "tie" ? "ties" : `${t} wins`}</div>
                <div className="mono text-xl font-semibold">{v}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span aria-live="polite">Winner: <b>{winner}</b> · binomial p = <span className="mono">{fmtP(test.pValue)}</span></span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ seed: seed + 1 })}><Dices size={14} aria-hidden="true" /> Re-roll sessions</button>
            </div>
            <p className="text-xs faint">
              Exact two-sided binomial test of B's wins among the {test.decided} decided sessions (ties carry no information and are excluded).
              {test.decided > 0 && <> Preference for B <span className="mono">{signedPct(test.preference)}</span>, 95% CI <span className="mono">{signedPct(test.ciLow)}</span> to <span className="mono">{signedPct(test.ciHigh)}</span> (Wilson).</>}
            </p>
            <IntervalBar lo={test.ciLow} hi={test.ciHigh} est={test.preference} domain={[-1, 1]} color={test.preference >= 0 ? "var(--accent)" : "var(--chart-a)"} label={<><span>favours A</span><span>favours B</span></>} />
          </div>
        </Section>
      </div>
    </Page>
  );
}
