import { afterEach, describe, expect, it, vi } from "vitest";
import { seedExperiments, type Experiment } from "../model";
import { decodeShare, encodeShare } from "./share";

/** The share-link encoder shipped before v2 (base64url of the plain JSON) — the format old links in the wild use. */
function legacyEncode(e: Experiment): string {
  const bytes = new TextEncoder().encode(JSON.stringify(e));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const zero = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
const LEGACY_EXPERIMENT: Experiment = {
  id: "exp-legacy-v1",
  name: "Legacy share link",
  hypothesis: "Old links keep working.",
  owner: "Search team",
  metric: "Booking conversion",
  metricType: "conversion",
  baseline: 0.1,
  mdeRel: 0.05,
  alpha: 0.05,
  power: 0.8,
  dailyTraffic: 2000,
  split: 0.5,
  startDate: "2026-09-01",
  status: "completed",
  plannedPerArm: 14751,
  days: [
    { day: 1, nA: 1000, nB: 1000, convA: 100, convB: 112, sumsA: { ...zero }, sumsB: { ...zero } },
    { day: 2, nA: 990, nB: 1010, convA: 97, convB: 118, sumsA: { ...zero }, sumsB: { ...zero } },
  ],
  source: "simulated",
  tags: ["legacy"],
};
// Produced from LEGACY_EXPERIMENT with the pre-v2 encoder (JSON → UTF-8 → base64url without padding) and kept verbatim.
const LEGACY_V1 =
  "eyJpZCI6ImV4cC1sZWdhY3ktdjEiLCJuYW1lIjoiTGVnYWN5IHNoYXJlIGxpbmsiLCJoeXBvdGhlc2lzIjoiT2xkIGxpbmtzIGtlZXAgd29ya2luZy4iLCJvd25lciI6IlNlYXJjaCB0ZWFtIiwibWV0cmljIjoiQm9va2luZyBjb252ZXJzaW9uIiwibWV0cmljVHlwZSI6ImNvbnZlcnNpb24iLCJiYXNlbGluZSI6MC4xLCJtZGVSZWwiOjAuMDUsImFscGhhIjowLjA1LCJwb3dlciI6MC44LCJkYWlseVRyYWZmaWMiOjIwMDAsInNwbGl0IjowLjUsInN0YXJ0RGF0ZSI6IjIwMjYtMDktMDEiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJwbGFubmVkUGVyQXJtIjoxNDc1MSwiZGF5cyI6W3siZGF5IjoxLCJuQSI6MTAwMCwibkIiOjEwMDAsImNvbnZBIjoxMDAsImNvbnZCIjoxMTIsInN1bXNBIjp7Im4iOjAsInN4IjowLCJzeSI6MCwic3h4IjowLCJzeXkiOjAsInN4eSI6MH0sInN1bXNCIjp7Im4iOjAsInN4IjowLCJzeSI6MCwic3h4IjowLCJzeXkiOjAsInN4eSI6MH19LHsiZGF5IjoyLCJuQSI6OTkwLCJuQiI6MTAxMCwiY29udkEiOjk3LCJjb252QiI6MTE4LCJzdW1zQSI6eyJuIjowLCJzeCI6MCwic3kiOjAsInN4eCI6MCwic3l5IjowLCJzeHkiOjB9LCJzdW1zQiI6eyJuIjowLCJzeCI6MCwic3kiOjAsInN4eCI6MCwic3l5IjowLCJzeHkiOjB9fV0sInNvdXJjZSI6InNpbXVsYXRlZCIsInRhZ3MiOlsibGVnYWN5Il19";

afterEach(() => vi.unstubAllGlobals());

describe("share links v2", () => {
  it("encodes a 21-day conversion experiment to fewer than 1,200 URL-safe characters with the '2.' prefix", async () => {
    const e = seedExperiments().find((x) => x.id === "exp-ranker-v2")!;
    expect(e.days).toHaveLength(21);
    const s = await encodeShare(e);
    expect(s).toMatch(/^2\.[A-Za-z0-9_-]+$/);
    expect(s.length).toBeLessThan(1200);
    expect(s.length * 2).toBeLessThan(legacyEncode(e).length);
  });

  it("round-trips every demo experiment (conversion and continuous) deep-equal", async () => {
    for (const e of seedExperiments()) {
      const s = await encodeShare(e);
      expect(s.startsWith("2.")).toBe(true);
      expect(await decodeShare(s)).toEqual(e);
    }
  });

  it("still decodes a legacy v1 string produced by the previous encoder", async () => {
    expect(legacyEncode(LEGACY_EXPERIMENT)).toBe(LEGACY_V1);
    expect(await decodeShare(LEGACY_V1)).toEqual(LEGACY_EXPERIMENT);
    for (const e of seedExperiments()) expect(await decodeShare(legacyEncode(e))).toEqual(e);
  });

  it("falls back to the v1 format when CompressionStream is unavailable, and that output still decodes", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const e = seedExperiments().find((x) => x.id === "exp-map-default")!;
    const s = await encodeShare(e);
    expect(s.startsWith("2.")).toBe(false);
    expect(s).toBe(legacyEncode(e));
    expect(await decodeShare(s)).toEqual(e);
  });

  it("returns null for garbage, truncated v2 payloads and JSON that is not an experiment", async () => {
    expect(await decodeShare("")).toBeNull();
    expect(await decodeShare("2.")).toBeNull();
    expect(await decodeShare("2.!!not-base64!!")).toBeNull();
    const good = await encodeShare(seedExperiments()[0]!);
    expect(await decodeShare(good.slice(0, 40))).toBeNull();
    const notAnExperiment = btoa(JSON.stringify({ hello: "world" })).replace(/=+$/, "");
    expect(await decodeShare(notAnExperiment)).toBeNull();
    const missingDays = legacyEncode({ ...LEGACY_EXPERIMENT, days: undefined as unknown as Experiment["days"] });
    expect(await decodeShare(missingDays)).toBeNull();
  });
});
