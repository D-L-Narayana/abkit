/**
 * Share links: the whole experiment (aggregates only — never per-user data) travels inside the URL, so a link works in
 * any browser without a server or an account and nothing is uploaded anywhere.
 *
 * v2 token = "2." + base64url( deflate-raw( compact JSON ) ) where the compact JSON is
 *   { v: 2, x: <experiment without days>, d: [[day, nA, nB, convA, convB] | [day, nA, nB, convA, convB, sumsA[6], sumsB[6]], …] }
 * (sums are only written when they are not all zero). Compression uses the browser's `CompressionStream`; where it is
 * missing the legacy v1 token — plain base64url of the experiment JSON, as produced by earlier versions — is written
 * instead. `decodeShare` accepts both; anything that does not decode to a structurally valid experiment yields `null`.
 */
import type { DayData, Experiment } from "../model";
import { emptySums, type Sums } from "../stats";
import { validateExperimentShape } from "./csv";

const V2 = "2.";
type SumsRow = [number, number, number, number, number, number];
type DayRow = [number, number, number, number, number] | [number, number, number, number, number, SumsRow, SumsRow];
interface PayloadV2 { v: 2; x: Omit<Experiment, "days">; d: DayRow[] }

// ---------------------------------------------------------------- bytes ↔ base64url
function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- deflate-raw via the Compression Streams API
/** Writes `bytes` through a (de)compression transform and collects the output; a corrupt stream rejects. */
async function pipeBytes(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  written.catch(() => undefined); // the same failure surfaces on the readable side; this only avoids a second, unhandled rejection
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    total += chunk.length;
  }
  await written;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
const deflateRaw = (bytes: Uint8Array): Promise<Uint8Array> => pipeBytes(bytes, new CompressionStream("deflate-raw"));
const inflateRaw = (bytes: Uint8Array): Promise<Uint8Array> => pipeBytes(bytes, new DecompressionStream("deflate-raw"));

// ---------------------------------------------------------------- compact payload
const isZero = (s: Sums): boolean => s.n === 0 && s.sx === 0 && s.sy === 0 && s.sxx === 0 && s.syy === 0 && s.sxy === 0;
const sumsRow = (s: Sums): SumsRow => [s.n, s.sx, s.sy, s.sxx, s.syy, s.sxy];
const isNumberList = (x: unknown, length: number): x is number[] => Array.isArray(x) && x.length === length && x.every((v) => typeof v === "number");

function pack(e: Experiment): PayloadV2 {
  const { days, ...x } = e;
  const d: DayRow[] = days.map((day) => {
    const base: [number, number, number, number, number] = [day.day, day.nA, day.nB, day.convA, day.convB];
    return isZero(day.sumsA) && isZero(day.sumsB) ? base : [...base, sumsRow(day.sumsA), sumsRow(day.sumsB)];
  });
  return { v: 2, x, d };
}

function unpack(payload: unknown): Experiment | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Partial<PayloadV2>;
  if (p.v !== 2 || typeof p.x !== "object" || p.x === null || !Array.isArray(p.d)) return null;
  const days: DayData[] = [];
  for (const row of p.d as unknown[]) {
    if (!Array.isArray(row) || (row.length !== 5 && row.length !== 7)) return null;
    const head = row.slice(0, 5);
    if (!isNumberList(head, 5)) return null;
    const [day, nA, nB, convA, convB] = head as [number, number, number, number, number];
    let sumsA = emptySums(), sumsB = emptySums();
    if (row.length === 7) {
      const a = row[5], b = row[6];
      if (!isNumberList(a, 6) || !isNumberList(b, 6)) return null;
      const toSums = (v: number[]): Sums => ({ n: v[0]!, sx: v[1]!, sy: v[2]!, sxx: v[3]!, syy: v[4]!, sxy: v[5]! });
      sumsA = toSums(a);
      sumsB = toSums(b);
    }
    days.push({ day, nA, nB, convA, convB, sumsA, sumsB });
  }
  const experiment = { ...(p.x as Omit<Experiment, "days">), days };
  return validateExperimentShape(experiment) === null ? experiment : null;
}

// ---------------------------------------------------------------- legacy v1
const encodeV1 = (e: Experiment): string => toBase64url(new TextEncoder().encode(JSON.stringify(e)));
function decodeV1(s: string): Experiment | null {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(s)));
  return validateExperimentShape(parsed) === null ? (parsed as Experiment) : null;
}

// ---------------------------------------------------------------- public API
/** Share token for `/share/<token>`: compressed v2 when the browser can compress, the legacy v1 token otherwise. */
export async function encodeShare(e: Experiment): Promise<string> {
  if (typeof CompressionStream === "undefined") return encodeV1(e);
  try {
    const bytes = await deflateRaw(new TextEncoder().encode(JSON.stringify(pack(e))));
    return V2 + toBase64url(bytes);
  } catch {
    return encodeV1(e);
  }
}

/** Decodes a v2 or legacy v1 token; `null` for anything malformed, truncated or not an experiment. Never throws. */
export async function decodeShare(s: string): Promise<Experiment | null> {
  try {
    if (!s.startsWith(V2)) return decodeV1(s);
    if (typeof DecompressionStream === "undefined") return null;
    const bytes = fromBase64url(s.slice(V2.length));
    if (bytes.length === 0) return null;
    const json = new TextDecoder().decode(await inflateRaw(bytes));
    return unpack(JSON.parse(json));
  } catch {
    return null;
  }
}
