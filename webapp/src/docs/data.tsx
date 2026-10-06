import type { DocSection } from "./index";

/** Data import/export formats and the privacy model of storage and share links. */
export const sections: DocSection[] = [
  {
    id: "csv-formats",
    title: "CSV formats: per-user and aggregated",
    group: "data",
    body: (
      <>
        <p>
          The importer reads two layouts. <b>Per-user</b> files have one row per user; <b>aggregated</b> files have one row per arm and day and are
          what the results page exports. Headers are case-insensitive; columns may come in any order.
        </p>
        <pre className="formula">{"per-user     variant, converted | value [, pre_value] [, day]\naggregated   variant, users, conversions | sum, sum_sq [, pre_sum, pre_sum_sq, cross_sum] [, day]"}</pre>
        <ul className="list-disc pl-5 grid gap-1">
          <li><code className="mono">converted</code> accepts 0/1, true/false and yes/no; <code className="mono">value</code> is any number (revenue, nights, minutes).</li>
          <li><code className="mono">pre_value</code> is the same metric measured before the experiment (CUPED covariate). In aggregated files the covariate travels as Σx, Σx² and Σxy.</li>
          <li><code className="mono">day</code> is a whole number or an ISO date (2026-09-01); dates are numbered from the earliest one. Without it everything is day 1.</li>
          <li>Aggregated continuous rows carry Σy and Σy² per arm and day, which is all the Welch t-test needs: mean = Σy/n, variance = (Σy² − n·mean²)/(n − 1).</li>
        </ul>
        <p>
          Files follow RFC 4180: quoted cells may contain the delimiter, line breaks and doubled quotes; comma, semicolon and tab delimiters are detected
          from the header (with a semicolon, a decimal comma such as 12,5 is accepted); CRLF line endings and a UTF-8 byte-order mark are fine. Rows that
          cannot be read — a value that is not a number, more conversions than users, a malformed date — are skipped and listed with their line number,
          never dropped silently.
        </p>
        <p>
          <b>Arm labels.</b> Control is any of <code className="mono">A, control, ctrl, 0, baseline</code>; treatment is <code className="mono">B, treatment, variant, test, 1</code>. Any
          other pair of exactly two labels works: the label seen first becomes control (with a warning), or name the control label explicitly. Three
          or more labels stop the import with a message listing them — this app analyses one treatment against one control.
        </p>
        <p>
          <b>Lossless export.</b> The CSV export writes the aggregated layout with every sufficient statistic in full precision, so re-importing it
          reproduces the same means, variances, p-values and intervals. The JSON export (<code className="mono">{'{ "schema": "abkit-experiment/1", "experiment": … }'}</code>)
          carries the whole experiment — settings, status, notes and daily data — and is what the dashboard's import expects. The Python package reads
          the same CSVs (<code className="mono">abkit analyze FILE.csv</code>), and the repository's fixtures hold files both implementations must agree on.
        </p>
      </>
    ),
  },
  {
    id: "privacy-sharing",
    title: "Privacy and share links",
    group: "data",
    body: (
      <>
        <p>
          Nothing leaves the browser. Uploaded files are parsed in memory and only daily aggregates are kept — never individual rows. Experiments live in
          this browser's local storage under a versioned key; records that fail validation are set aside in a quarantine you can download or discard,
          not deleted. There is no server, account or analytics call.
        </p>
        <p>
          A share link carries the whole experiment inside the URL, so it opens in any browser without a backend. The token after
          <code className="mono"> /share/</code> is built in three steps:
        </p>
        <pre className="formula">{"compact JSON  { v: 2, x: settings, d: [[day, nA, nB, convA, convB, sumsA?, sumsB?], …] }\n→ deflate-raw (the browser's CompressionStream)\n→ base64url, prefixed with \"2.\""}</pre>
        <p>
          A three-week conversion experiment becomes roughly a thousand characters instead of five, which keeps links inside the limits of chat tools and
          address bars. Browsers without CompressionStream fall back to the original v1 token (base64url of the plain JSON), and v1 links from earlier
          versions keep working. Opening a shared link is read-only and stores nothing unless you choose to save it.
        </p>
      </>
    ),
  },
];
