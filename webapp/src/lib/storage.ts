/**
 * Versioned, validated experiment storage with a quarantine for records that fail validation.
 *
 * Keys (localStorage, or an in-memory fallback when storage is unavailable):
 *   - `abkit-experiments-v2`         → StoreFile { version: 2, savedAt, experiments }
 *   - `abkit-experiments-quarantine` → Quarantined[]: invalid records are set aside with a reason, never silently dropped
 *   - `abkit-experiments-v1`         → legacy bare array; migrated to v2 on first load, then removed
 *
 * `createStore()` is a small external store: `load()` and `quarantine()` return referentially stable snapshots until
 * something is written (safe for `useSyncExternalStore`), every write notifies subscribers, and `reload()` re-reads
 * what another tab wrote. Nothing is stored anywhere but the given storage object.
 */
import { useSyncExternalStore } from "react";
import { seedExperiments, type Experiment } from "../model";

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const KEY_V1 = "abkit-experiments-v1";
export const KEY_V2 = "abkit-experiments-v2";
export const KEY_QUARANTINE = "abkit-experiments-quarantine";
export interface StoreFile { version: 2; savedAt: string; experiments: Experiment[] }
export interface Quarantined { raw: unknown; reason: string; at: string }
export interface ImportResult { added: number; updated: number; skipped: Quarantined[] }
export interface Store {
  /** Current experiments (migrating/seeding on first call). Treat the array as immutable. */
  load(): Experiment[];
  save(list: Experiment[]): void;
  /** Replaces the experiment with the same id in place, or inserts a new one at the front. */
  upsert(e: Experiment): Experiment[];
  remove(id: string): Experiment[];
  /** Changes the lifecycle status; stopping or completing records `stoppedAt`, resuming clears it. */
  setStatus(id: string, status: Experiment["status"]): Experiment[];
  /** A draft copy with a fresh id and no data — not saved (the wizard finishes it via `/new?from=<id>`). */
  duplicate(id: string): Experiment | null;
  /** Re-adds the six demo experiments (replacing demo ids, keeping everything else). */
  restoreDemo(): Experiment[];
  quarantine(): Quarantined[];
  discardQuarantine(): void;
  /** Pretty-printed v2 StoreFile. */
  exportAll(): string;
  /** Accepts a StoreFile, a bare array, `{ experiment }` or a bare experiment; invalid records are skipped and quarantined. */
  importAll(json: string): ImportResult;
  subscribe(cb: () => void): () => void;
  /** Drops the cached snapshots (e.g. after another tab wrote) and notifies subscribers. */
  reload(): void;
}

// ---------------------------------------------------------------- validation
const METRIC_TYPES: ReadonlySet<string> = new Set(["conversion", "continuous"]);
const STATUSES: ReadonlySet<string> = new Set(["draft", "running", "completed", "stopped"]);
const STRING_FIELDS = ["id", "name", "hypothesis", "owner", "metric", "startDate", "source"] as const;
const OPTIONAL_STRING_FIELDS = ["stoppedAt", "scenario", "notes"] as const;
const NUMBER_FIELDS = ["baseline", "mdeRel", "alpha", "power", "dailyTraffic", "split", "plannedPerArm"] as const;
const UNIT_FIELDS = ["alpha", "power", "split"] as const; // strictly inside (0, 1)
const COUNT_FIELDS = ["day", "nA", "nB", "convA", "convB"] as const;
const SUM_FIELDS = ["n", "sx", "sy", "sxx", "syy", "sxy"] as const;
const MAX_REASONS = 6;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const now = (): string => new Date().toISOString();
const today = (): string => now().slice(0, 10);

function validateDay(d: unknown, i: number, problems: string[]): void {
  const at = `days[${i}]`;
  if (!isRecord(d)) {
    problems.push(`${at} must be an object`);
    return;
  }
  for (const k of COUNT_FIELDS) {
    const v = d[k];
    if (!isFiniteNumber(v) || v < 0) problems.push(`${at}.${k} must be a finite number ≥ 0`);
  }
  for (const arm of ["sumsA", "sumsB"] as const) {
    const s = d[arm];
    if (!isRecord(s)) {
      problems.push(`${at}.${arm} must be an object`);
      continue;
    }
    for (const k of SUM_FIELDS) if (!isFiniteNumber(s[k])) problems.push(`${at}.${arm}.${k} must be a finite number`);
  }
}

/**
 * Structural validation of an experiment record. Returns `null` when valid, otherwise a short, user-facing list of
 * what is wrong (strings, finite numbers, metricType/status enums, `days` as DayData with finite Sums).
 * `source` only has to be a string so files written by newer versions still load.
 */
export function validateExperiment(x: unknown): string | null {
  if (!isRecord(x)) return Array.isArray(x) ? "expected an experiment object, got an array" : `expected an experiment object, got ${x === null ? "null" : typeof x}`;
  const problems: string[] = [];
  for (const k of STRING_FIELDS) if (typeof x[k] !== "string") problems.push(`${k} must be a string`);
  const id = x.id;
  if (typeof id === "string" && id.trim() === "") problems.push("id must not be empty");
  for (const k of OPTIONAL_STRING_FIELDS) if (x[k] !== undefined && typeof x[k] !== "string") problems.push(`${k} must be a string`);
  if (typeof x.metricType !== "string" || !METRIC_TYPES.has(x.metricType)) problems.push('metricType must be "conversion" or "continuous"');
  if (typeof x.status !== "string" || !STATUSES.has(x.status)) problems.push('status must be "draft", "running", "completed" or "stopped"');
  for (const k of NUMBER_FIELDS) if (!isFiniteNumber(x[k])) problems.push(`${k} must be a finite number`);
  for (const k of UNIT_FIELDS) {
    const v = x[k];
    if (isFiniteNumber(v) && (v <= 0 || v >= 1)) problems.push(`${k} must be between 0 and 1`);
  }
  if (x.std !== undefined && !isFiniteNumber(x.std)) problems.push("std must be a finite number");
  if (!Array.isArray(x.tags) || !x.tags.every((t: unknown) => typeof t === "string")) problems.push("tags must be an array of strings");
  const days: unknown = x.days;
  if (!Array.isArray(days)) problems.push("days must be an array of daily records");
  else for (let i = 0; i < days.length && problems.length < MAX_REASONS; i++) validateDay(days[i], i, problems);
  if (problems.length === 0) return null;
  return problems.slice(0, MAX_REASONS).join("; ") + (problems.length > MAX_REASONS ? "; …" : "");
}

/** Type guard built on `validateExperiment`. */
export function isExperiment(x: unknown): x is Experiment {
  return validateExperiment(x) === null;
}

// ---------------------------------------------------------------- storage backends
/** Map-backed StorageLike (private mode, disabled storage, tests, server-side rendering). */
export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Uses `candidate` when it round-trips a probe value, otherwise an in-memory store. */
export function resolveStorage(candidate: StorageLike | null | undefined): StorageLike {
  if (!candidate) return memoryStorage();
  const probe = "abkit-storage-probe";
  try {
    candidate.setItem(probe, "1");
    const ok = candidate.getItem(probe) === "1";
    candidate.removeItem(probe);
    return ok ? candidate : memoryStorage();
  } catch {
    return memoryStorage();
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Experiment candidates inside parsed JSON: a StoreFile, a bare array, `{ experiment }` (single-experiment envelope) or a bare experiment. */
function candidatesOf(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.experiments)) return parsed.experiments;
  if (isRecord(parsed.experiment)) return [parsed.experiment];
  return [parsed];
}

function freeId(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

// ---------------------------------------------------------------- store
export function createStore(storage: StorageLike): Store {
  const listeners = new Set<() => void>();
  let list: Experiment[] | null = null;
  let quarantined: Quarantined[] | null = null;

  const read = (k: string): string | null => { try { return storage.getItem(k); } catch { return null; } };
  const write = (k: string, v: string): void => { try { storage.setItem(k, v); } catch { /* quota exceeded or storage disabled: the in-memory snapshot still serves this session */ } };
  const drop = (k: string): void => { try { storage.removeItem(k); } catch { /* ignore */ } };
  const notify = (): void => { for (const l of [...listeners]) l(); };
  const fileOf = (experiments: Experiment[]): StoreFile => ({ version: 2, savedAt: now(), experiments });
  const writeFile = (experiments: Experiment[]): void => write(KEY_V2, JSON.stringify(fileOf(experiments)));

  function readQuarantine(): Quarantined[] {
    const raw = read(KEY_QUARANTINE);
    if (raw === null) return [];
    const parsed = parseJson(raw);
    if (!parsed.ok) return [{ raw, reason: `quarantine is not valid JSON: ${parsed.error}`, at: now() }];
    const entries = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    return entries.map((q: unknown): Quarantined => (isRecord(q) && typeof q.reason === "string" && typeof q.at === "string" ? { raw: q.raw, reason: q.reason, at: q.at } : { raw: q, reason: "malformed quarantine entry", at: now() }));
  }
  function addQuarantine(items: Quarantined[]): void {
    if (items.length === 0) return;
    const next = [...(quarantined ?? readQuarantine()), ...items];
    write(KEY_QUARANTINE, JSON.stringify(next));
    quarantined = next;
  }

  /** Reads (and, when needed, migrates) storage into the cached snapshot. */
  function ensure(): Experiment[] {
    if (list) return list;
    const rawV2 = read(KEY_V2);
    const rawV1 = read(KEY_V1);
    if (rawV2 === null && rawV1 === null) {
      list = seedExperiments();
      writeFile(list);
      return list;
    }
    const good: Experiment[] = [];
    const bad: Quarantined[] = [];
    let dirty = false;
    const take = (raw: string, label: string): void => {
      const parsed = parseJson(raw);
      if (!parsed.ok) {
        bad.push({ raw, reason: `${label} is not valid JSON: ${parsed.error}`, at: now() });
        dirty = true;
        return;
      }
      const cands = candidatesOf(parsed.value);
      if (!cands) {
        bad.push({ raw: parsed.value, reason: `${label} is not an experiments file`, at: now() });
        dirty = true;
        return;
      }
      for (const c of cands) {
        const reason = validateExperiment(c);
        if (reason !== null) {
          bad.push({ raw: c, reason, at: now() });
          dirty = true;
          continue;
        }
        const e = c as Experiment; // validated above
        if (good.some((g) => g.id === e.id)) {
          dirty = true; // same id already loaded (e.g. a v1 copy of a migrated record): the first copy wins
          continue;
        }
        good.push(e);
      }
    };
    if (rawV2 !== null) take(rawV2, "stored data (v2)");
    if (rawV1 !== null) {
      take(rawV1, "legacy data (v1)");
      drop(KEY_V1);
      dirty = true;
    }
    if (dirty) writeFile(good);
    list = good;
    addQuarantine(bad);
    return list;
  }

  function commit(next: Experiment[]): Experiment[] {
    list = next;
    writeFile(next);
    notify();
    return next;
  }

  return {
    load: () => ensure(),
    save(next) {
      commit([...next]);
    },
    upsert(e) {
      const cur = ensure();
      const i = cur.findIndex((x) => x.id === e.id);
      return commit(i < 0 ? [e, ...cur] : cur.map((x, j) => (j === i ? e : x)));
    },
    remove(id) {
      const cur = ensure();
      return cur.some((x) => x.id === id) ? commit(cur.filter((x) => x.id !== id)) : cur;
    },
    setStatus(id, status) {
      const cur = ensure();
      const i = cur.findIndex((x) => x.id === id);
      const target = cur[i];
      if (!target) return cur;
      const next: Experiment = { ...target, status };
      if (status === "stopped" || status === "completed") next.stoppedAt = target.stoppedAt ?? now();
      else delete next.stoppedAt;
      return commit(cur.map((x, j) => (j === i ? next : x)));
    },
    duplicate(id) {
      const cur = ensure();
      const src = cur.find((x) => x.id === id);
      if (!src) return null;
      const copy = JSON.parse(JSON.stringify(src)) as Experiment;
      delete copy.stoppedAt;
      const base = `${src.id.replace(/-copy(-\d+)?$/, "")}-copy`;
      const name = `${src.name.replace(/ \(copy\)$/, "")} (copy)`;
      // the copy carries the definition only; the wizard simulates (or the user uploads) new data for it
      return { ...copy, id: freeId(new Set(cur.map((e) => e.id)), base), name, status: "draft", days: [], startDate: today(), source: "simulated" };
    },
    restoreDemo() {
      const cur = ensure();
      const seeded = seedExperiments();
      return commit([...cur.filter((e) => !seeded.some((s) => s.id === e.id)), ...seeded]);
    },
    quarantine() {
      ensure();
      if (quarantined === null) quarantined = readQuarantine();
      return quarantined;
    },
    discardQuarantine() {
      ensure();
      drop(KEY_QUARANTINE);
      quarantined = [];
      notify();
    },
    exportAll() {
      return JSON.stringify(fileOf(ensure()), null, 2);
    },
    importAll(json) {
      const cur = ensure();
      const at = now();
      const parsed = parseJson(json);
      if (!parsed.ok) return { added: 0, updated: 0, skipped: [{ raw: json.length > 2000 ? `${json.slice(0, 2000)}…` : json, reason: `not valid JSON: ${parsed.error}`, at }] };
      const cands = candidatesOf(parsed.value);
      if (!cands) return { added: 0, updated: 0, skipped: [{ raw: parsed.value, reason: "expected an experiments file, an array of experiments or a single experiment", at }] };
      const next = [...cur];
      const skipped: Quarantined[] = [];
      let added = 0;
      let updated = 0;
      for (const c of cands) {
        const reason = validateExperiment(c);
        if (reason !== null) {
          skipped.push({ raw: c, reason, at });
          continue;
        }
        const e = c as Experiment; // validated above
        const i = next.findIndex((x) => x.id === e.id);
        if (i < 0) {
          next.push(e);
          added++;
        } else if (JSON.stringify(next[i]) !== JSON.stringify(e)) {
          next[i] = e;
          updated++;
        }
      }
      if (added || updated) {
        list = next;
        writeFile(next);
      }
      addQuarantine(skipped);
      if (added || updated || skipped.length) notify();
      return { added, updated, skipped };
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    reload() {
      list = null;
      quarantined = null;
      notify();
    },
  };
}

// ---------------------------------------------------------------- app singleton + React bindings
function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // access itself can throw when storage is disabled by policy
  }
}

/** App-wide store: localStorage when usable, otherwise an in-memory fallback for this page. */
export const store: Store = createStore(resolveStorage(browserStorage()));

// Cross-tab updates: another document on this origin wrote one of our keys (key === null means storage.clear()).
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === KEY_V1 || e.key === KEY_V2 || e.key === KEY_QUARANTINE) store.reload();
  });
}

/** Experiments from the app-wide store; re-renders on every write, including writes from other tabs. */
export function useExperiments(): Experiment[] {
  return useSyncExternalStore(store.subscribe, store.load, store.load);
}
/** Quarantined records from the app-wide store (same subscription). */
export function useQuarantine(): Quarantined[] {
  return useSyncExternalStore(store.subscribe, store.quarantine, store.quarantine);
}
