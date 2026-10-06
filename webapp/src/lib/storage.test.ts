import { describe, expect, it } from "vitest";
import { seedExperiments, type Experiment } from "../model";
import { KEY_QUARANTINE, KEY_V1, KEY_V2, createStore, isExperiment, memoryStorage, resolveStorage, store, type StorageLike, type StoreFile } from "./storage";

/** Minimal in-memory StorageLike (independent of the module under test). */
function mem(initial: Record<string, string> = {}): StorageLike & { keys(): string[] } {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}

const seeds = seedExperiments();
const seedIds = seeds.map((e) => e.id);
/** A realistic corruption: a complete experiment whose `days` is no longer an array of DayData. */
const corrupt = { ...seeds[0]!, id: "exp-broken", name: "Broken record", days: "not-an-array" };
const emptyFile = (): string => JSON.stringify({ version: 2, savedAt: "2026-10-01T00:00:00.000Z", experiments: [] });
const ids = (list: Experiment[]): string[] => list.map((e) => e.id);

describe("migration v1 → v2", () => {
  it("keeps the 5 valid v1 records and quarantines the corrupt one with a reason", () => {
    const s = mem({ [KEY_V1]: JSON.stringify([...seeds.slice(0, 5), corrupt]) });
    const st = createStore(s);
    expect(ids(st.load())).toEqual(seedIds.slice(0, 5));
    const q = st.quarantine();
    expect(q).toHaveLength(1);
    expect(q[0]?.reason).toMatch(/days/);
    expect((q[0]?.raw as { id?: string } | undefined)?.id).toBe("exp-broken");
    expect(Number.isNaN(Date.parse(q[0]?.at ?? ""))).toBe(false);
  });

  it("writes a v2 file, persists the quarantine and removes the v1 key", () => {
    const s = mem({ [KEY_V1]: JSON.stringify([...seeds.slice(0, 5), corrupt]) });
    createStore(s).load();
    expect(s.getItem(KEY_V1)).toBeNull();
    const file = JSON.parse(s.getItem(KEY_V2) ?? "null") as StoreFile | null;
    expect(file?.version).toBe(2);
    expect(file?.experiments).toHaveLength(5);
    expect(Number.isNaN(Date.parse(file?.savedAt ?? ""))).toBe(false);
    const q = JSON.parse(s.getItem(KEY_QUARANTINE) ?? "[]") as unknown[];
    expect(q).toHaveLength(1);
    // a second store on the same storage sees the migrated data without re-migrating
    const again = createStore(s);
    expect(ids(again.load())).toEqual(seedIds.slice(0, 5));
    expect(again.quarantine()).toHaveLength(1);
  });

  it("quarantines a v1 blob that is not JSON instead of dropping it", () => {
    const s = mem({ [KEY_V1]: "{not json" });
    const st = createStore(s);
    expect(st.load()).toEqual([]);
    expect(st.quarantine()[0]?.raw).toBe("{not json");
    expect(st.quarantine()[0]?.reason).toMatch(/JSON/i);
    expect(s.getItem(KEY_V1)).toBeNull();
  });

  it("validates v2 records on load too: a corrupt record inside the v2 file is quarantined and the file rewritten", () => {
    const s = mem({ [KEY_V2]: JSON.stringify({ version: 2, savedAt: "2026-10-01T00:00:00.000Z", experiments: [seeds[0], corrupt] }) });
    const st = createStore(s);
    expect(ids(st.load())).toEqual([seedIds[0]]);
    expect(st.quarantine()).toHaveLength(1);
    const file = JSON.parse(s.getItem(KEY_V2) ?? "null") as StoreFile | null;
    expect(file?.experiments).toHaveLength(1);
  });

  it("seeds the six demo experiments when nothing is stored", () => {
    const s = mem();
    const st = createStore(s);
    expect(ids(st.load())).toEqual(seedIds);
    expect(seedIds).toHaveLength(6);
    const file = JSON.parse(s.getItem(KEY_V2) ?? "null") as StoreFile | null;
    expect(file?.version).toBe(2);
    expect(file?.experiments).toHaveLength(6);
  });

  it("does not seed when a v2 file exists — even an intentionally empty one", () => {
    const one = mem({ [KEY_V2]: JSON.stringify({ version: 2, savedAt: "2026-10-01T00:00:00.000Z", experiments: [seeds[2]] }) });
    expect(ids(createStore(one).load())).toEqual([seedIds[2]]);
    const empty = mem({ [KEY_V2]: emptyFile() });
    expect(createStore(empty).load()).toEqual([]);
  });
});

describe("isExperiment", () => {
  it("accepts every seeded experiment and rejects non-finite numbers, bad enums and malformed days", () => {
    for (const e of seeds) expect(isExperiment(e)).toBe(true);
    const e = seeds[0]!;
    const day = e.days[0]!;
    expect(isExperiment({ ...e, baseline: NaN })).toBe(false);
    expect(isExperiment({ ...e, baseline: "0.1" })).toBe(false);
    expect(isExperiment({ ...e, alpha: 1.5 })).toBe(false);
    expect(isExperiment({ ...e, metricType: "revenue" })).toBe(false);
    expect(isExperiment({ ...e, status: "paused" })).toBe(false);
    expect(isExperiment({ ...e, tags: "search" })).toBe(false);
    expect(isExperiment({ ...e, name: 42 })).toBe(false);
    expect(isExperiment({ ...e, days: "not-an-array" })).toBe(false);
    expect(isExperiment({ ...e, days: [{ ...day, nA: Infinity }] })).toBe(false);
    expect(isExperiment({ ...e, days: [{ ...day, nA: -1 }] })).toBe(false);
    expect(isExperiment({ ...e, days: [{ ...day, sumsA: { ...day.sumsA, sxy: null } }] })).toBe(false);
    expect(isExperiment({ ...e, days: [{ ...day, sumsB: undefined }] })).toBe(false);
    expect(isExperiment({ ...e, days: [] })).toBe(true);
    expect(isExperiment(null)).toBe(false);
    expect(isExperiment([])).toBe(false);
    expect(isExperiment("exp")).toBe(false);
  });
});

describe("lifecycle", () => {
  it("setStatus → stopped sets status and stoppedAt, persists, and resume clears stoppedAt", () => {
    const s = mem();
    const st = createStore(s);
    st.load();
    const id = "exp-free-cancel-badge";
    const stopped = st.setStatus(id, "stopped").find((x) => x.id === id);
    expect(stopped?.status).toBe("stopped");
    expect(typeof stopped?.stoppedAt).toBe("string");
    expect(Number.isNaN(Date.parse(stopped?.stoppedAt ?? ""))).toBe(false);
    // persisted for a fresh store on the same storage
    const fresh = createStore(s).load().find((x) => x.id === id);
    expect(fresh?.status).toBe("stopped");
    expect(typeof fresh?.stoppedAt).toBe("string");
    const resumed = st.setStatus(id, "running").find((x) => x.id === id);
    expect(resumed?.status).toBe("running");
    expect(resumed?.stoppedAt).toBeUndefined();
    // other experiments untouched
    expect(st.load().filter((x) => x.id !== id).map((x) => x.status)).toEqual(seeds.filter((x) => x.id !== id).map((x) => x.status));
  });

  it("setStatus → completed also records stoppedAt and keeps an earlier stop time", () => {
    const st = createStore(mem());
    st.load();
    const id = "exp-urgency-copy";
    const stopped = st.setStatus(id, "stopped").find((x) => x.id === id);
    const completed = st.setStatus(id, "completed").find((x) => x.id === id);
    expect(completed?.status).toBe("completed");
    expect(completed?.stoppedAt).toBe(stopped?.stoppedAt);
    const direct = st.setStatus("exp-checkout-2step", "completed").find((x) => x.id === "exp-checkout-2step");
    expect(typeof direct?.stoppedAt).toBe("string");
  });

  it("duplicate returns a draft copy with a new id and no days — and does not save it", () => {
    const st = createStore(mem());
    const before = ids(st.load());
    const orig = seeds.find((e) => e.id === "exp-ranker-v2")!;
    const copy = st.duplicate("exp-ranker-v2");
    expect(copy).not.toBeNull();
    expect(copy?.id).not.toBe("exp-ranker-v2");
    expect(before).not.toContain(copy?.id);
    expect(copy?.status).toBe("draft");
    expect(copy?.days).toEqual([]);
    expect(copy?.name).toContain(orig.name);
    expect(copy?.metric).toBe(orig.metric);
    expect(copy?.baseline).toBe(orig.baseline);
    expect(copy?.tags).toEqual(orig.tags);
    expect(isExperiment(copy)).toBe(true);
    expect(ids(st.load())).toEqual(before);
    // a second duplicate gets another unused id
    const second = st.duplicate("exp-ranker-v2");
    expect(second?.id).toBe(copy?.id);
    st.upsert(copy!);
    expect(st.duplicate("exp-ranker-v2")?.id).not.toBe(copy?.id);
    expect(st.duplicate("does-not-exist")).toBeNull();
  });

  it("upsert inserts at the front or replaces by id; remove deletes; both persist", () => {
    const s = mem();
    const st = createStore(s);
    st.load();
    const mine: Experiment = { ...seeds[1]!, id: "mine", name: "Mine" };
    expect(st.upsert(mine)[0]?.id).toBe("mine");
    expect(st.load()).toHaveLength(7);
    const renamed = st.upsert({ ...mine, name: "Renamed" });
    expect(renamed.filter((e) => e.id === "mine")).toHaveLength(1);
    expect(renamed.find((e) => e.id === "mine")?.name).toBe("Renamed");
    expect(createStore(s).load().find((e) => e.id === "mine")?.name).toBe("Renamed");
    expect(ids(st.remove("mine"))).toEqual(seedIds);
    expect(ids(createStore(s).load())).toEqual(seedIds);
  });

  it("restoreDemo brings back deleted demo experiments without duplicating the user's own", () => {
    const st = createStore(mem());
    st.load();
    st.remove("exp-ranker-v2");
    st.remove("exp-map-default");
    st.upsert({ ...seeds[0]!, id: "mine", name: "Mine" });
    expect(st.load()).toHaveLength(5);
    const list = st.restoreDemo();
    expect(ids(list).sort()).toEqual([...seedIds, "mine"].sort());
    expect(list.filter((e) => e.id === "mine")).toHaveLength(1);
    expect(st.load()).toHaveLength(7);
  });
});

describe("export / import", () => {
  it("exportAll produces a v2 file and importAll(exportAll()) is idempotent", () => {
    const st = createStore(mem());
    st.load();
    const json = st.exportAll();
    const parsed = JSON.parse(json || "null") as StoreFile | null;
    expect(parsed?.version).toBe(2);
    expect(parsed?.experiments).toHaveLength(6);
    expect(Number.isNaN(Date.parse(parsed?.savedAt ?? ""))).toBe(false);
    const r = st.importAll(json);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.skipped).toEqual([]);
    expect(ids(st.load())).toEqual(seedIds);
  });

  it("importAll into an empty store adds everything from the exported file", () => {
    const src = createStore(mem());
    src.load();
    const json = src.exportAll();
    const dst = createStore(mem({ [KEY_V2]: emptyFile() }));
    const r = dst.importAll(json);
    expect(r.added).toBe(6);
    expect(r.skipped).toEqual([]);
    expect(dst.load()).toEqual(src.load());
  });

  it("importAll skips a bad record with a reason, keeps the good ones and quarantines the bad one", () => {
    const st = createStore(mem({ [KEY_V2]: emptyFile() }));
    const r = st.importAll(JSON.stringify({ version: 2, savedAt: "2026-10-01T00:00:00.000Z", experiments: [seeds[0], corrupt, seeds[1]] }));
    expect(r.added).toBe(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toMatch(/days/);
    expect(ids(st.load())).toEqual([seedIds[0], seedIds[1]]);
    expect(st.quarantine()).toHaveLength(1);
  });

  it("importAll accepts a bare array, a single-experiment envelope and a bare experiment", () => {
    const st = createStore(mem({ [KEY_V2]: emptyFile() }));
    expect(st.importAll(JSON.stringify([seeds[0]])).added).toBe(1);
    expect(st.importAll(JSON.stringify({ schema: "abkit-experiment/1", experiment: seeds[1] })).added).toBe(1);
    expect(st.importAll(JSON.stringify(seeds[2])).added).toBe(1);
    expect(ids(st.load())).toEqual([seedIds[0], seedIds[1], seedIds[2]]);
  });

  it("importAll replaces an existing id only when the content changed and reports it as updated", () => {
    const st = createStore(mem());
    st.load();
    const r = st.importAll(JSON.stringify([{ ...seeds[0]!, name: "Renamed" }]));
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(st.load().find((e) => e.id === seedIds[0])?.name).toBe("Renamed");
    expect(st.load()).toHaveLength(6);
  });

  it("importAll reports input that is not JSON as skipped without throwing", () => {
    const st = createStore(mem());
    st.load();
    const r = st.importAll("variant,converted\nA,1\n");
    expect(r.added).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toMatch(/JSON/i);
    expect(st.load()).toHaveLength(6);
  });

  it("discardQuarantine clears the quarantine key and notifies subscribers", () => {
    const s = mem({ [KEY_V1]: JSON.stringify([corrupt]) });
    const st = createStore(s);
    st.load();
    expect(st.quarantine()).toHaveLength(1);
    let fired = 0;
    st.subscribe(() => { fired++; });
    st.discardQuarantine();
    expect(st.quarantine()).toEqual([]);
    expect(s.getItem(KEY_QUARANTINE)).toBeNull();
    expect(fired).toBe(1);
  });
});

describe("subscriptions, snapshots and fallback", () => {
  it("subscribe fires on save/upsert/setStatus/remove and stops after unsubscribe", () => {
    const st = createStore(mem());
    st.load();
    let fired = 0;
    const off = st.subscribe(() => { fired++; });
    st.save(st.load());
    expect(fired).toBe(1);
    st.upsert({ ...seeds[0]!, id: "exp-extra" });
    expect(fired).toBe(2);
    st.setStatus("exp-extra", "stopped");
    expect(fired).toBe(3);
    st.remove("exp-extra");
    expect(fired).toBe(4);
    off();
    st.save([]);
    expect(fired).toBe(4);
  });

  it("load() returns the same snapshot until something changes (useSyncExternalStore-friendly)", () => {
    const st = createStore(mem());
    const a = st.load();
    const b = st.load();
    expect(a).toBe(b);
    st.setStatus("exp-map-default", "stopped");
    const c = st.load();
    expect(c).not.toBe(a);
    expect(st.load()).toBe(c);
    const q1 = st.quarantine();
    expect(st.quarantine()).toBe(q1);
  });

  it("reload() re-reads storage written by another tab and notifies", () => {
    const s = mem();
    const st = createStore(s);
    expect(st.load()).toHaveLength(6);
    s.setItem(KEY_V2, JSON.stringify({ version: 2, savedAt: "2026-10-02T00:00:00.000Z", experiments: [seeds[0]] }));
    expect(st.load()).toHaveLength(6);
    let fired = 0;
    st.subscribe(() => { fired++; });
    st.reload();
    expect(fired).toBe(1);
    expect(ids(st.load())).toEqual([seedIds[0]]);
  });

  it("falls back to an in-memory storage when localStorage is missing or unusable", () => {
    const broken: StorageLike = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    const a = resolveStorage(undefined);
    a.setItem("k", "v");
    expect(a.getItem("k")).toBe("v");
    a.removeItem("k");
    expect(a.getItem("k")).toBeNull();
    const b = resolveStorage(broken);
    expect(b).not.toBe(broken);
    b.setItem("k", "v");
    expect(b.getItem("k")).toBe("v");
    const m = mem();
    expect(resolveStorage(m)).toBe(m);
    const fallback = createStore(memoryStorage());
    expect(ids(fallback.load())).toEqual(seedIds);
    fallback.save([]);
    expect(fallback.load()).toEqual([]);
    // the app-wide singleton works here too (Node has no localStorage)
    expect(ids(store.load())).toEqual(seedIds);
  });
});
