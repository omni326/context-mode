/**
 * Recall probe for virtual pruning (plan.md 阶段 4 gate).
 *
 * Pruning is only lossless compression if the pruned bytes can come back through
 * ctx_search. This probe measures that against REAL captured output instead of
 * synthetic fixtures: it replays every `content` source from a live content store
 * into a fresh store through the same indexing chokepoint ctx_batch_execute uses
 * (`indexPlainText`, i.e. including secret redaction and chunking), samples fact
 * queries from each log the way a follow-up question would phrase them, and checks
 * the source comes back in top-k (or via an exact `source:` filter).
 *
 * MUST be run with capture on — pruning a native shell result that was never
 * captured is not a recall failure of the index, it is an unrecoverable byte loss,
 * which is what `isRecoverable()` in history-pruner.ts is the whitelist for.
 *
 * HOW TO RUN
 *   npm run build          # probes import from build/, which is gitignored
 *   node probes/recall-probe.mjs                 # biggest store in ~/.context-mode
 *   PROBE_DB=<path>/context.db PROBE_FACTS=20 node probes/recall-probe.mjs
 * Output is one JSON object: sources replayed, bytes, facts sampled, recovered,
 * recall, misses. It is INDEX-SIDE recall only: every query is copied verbatim
 * from an indexed line, so it answers "can FTS5 find a string we know is there",
 * not "will a paraphrased follow-up find it" and not "will the model call
 * ctx_search at all" — those need the behavioural test, not this probe.
 *
 * RESULT (2026-11-04, opencode v2.2.5, fork @ 44c6df1f, busiest local store)
 *   98 sources / 1.48 MB replayed, 321 fact queries, 321 recovered → recall 1.000
 *   (gate was ≥0.95). Numbers belong to that corpus; rerun on other data and
 *   expect different totals.
 *   The 3 initial ANSI "misses" were probe artifacts: phrases assembled from
 *   escape-stripped text that were never contiguous visible text (they spanned
 *   chunk/source boundaries). An adjacency A/B over the 4 escape-bearing sources
 *   recovered 4/4 with escapes indexed and 4/4 without, so nothing is stripped at
 *   index time. Sampling now skips escape-bearing lines outright (finding #7).
 *   Redaction is a real hole this probe cannot see: a line indexed as
 *   `password=[REDACTED]` can never be found by the value it used to carry.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ContentStore } from "../build/store.js";

// Biggest capture store on the machine — the one with the most real logs.
function biggestStore() {
  const root = join(homedir(), ".context-mode/projects");
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  let best = null;
  for (const d of dirs) {
    const p = join(root, d.name, "context.db");
    try {
      const size = statSync(p).size;
      if (!best || size > best.size) best = { p, size };
    } catch {}
  }
  if (!best) throw new Error(`no context.db under ${root}; set PROBE_DB=<path>`);
  return best.p;
}

const REAL = process.env.PROBE_DB || biggestStore();
const FACTS = Number(process.env.PROBE_FACTS || 20);

function sampleFacts(text, n) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const facts = [];
  const step = Math.max(1, Math.floor(lines.length / n));
  for (let i = 0; i < lines.length && facts.length < n; i += step) {
    const l = lines[i];
    if (l.length < 24 || l.length > 400) continue;
    // Escapes are indexed verbatim; a phrase built from their stripped form may
    // not be contiguous in the index, which would be a probe artifact, not a miss.
    if (l.includes("\x1b")) continue;
    const words = l.split(/\s+/).filter((w) => /[A-Za-z0-9_./-]{5,}/.test(w));
    if (words.length < 4) continue;
    const q = words.slice(0, 5).join(" ");
    if (seen.has(q)) continue;
    seen.add(q);
    facts.push(q);
  }
  return facts;
}

const real = new DatabaseSync(REAL, { readOnly: true });
const getBody = real.prepare("select body from chunks where rowid = ?");
const ansiIds = real
  .prepare("select distinct source_id as id from chunks where instr(body, ?) > 0")
  .all("\x1b")
  .map((r) => r.id);

// Replay: the biggest deliberate captures, plus every escape-bearing source so
// ANSI is represented even when the log is small.
const sources = real
  .prepare("select id, label from sources where kind='content' order by bytes_total desc limit 120")
  .all()
  .concat(
    real
      .prepare(`select id, label from sources where kind='content' and id in (${ansiIds.map(() => "?").join(",")})`)
      .all(...ansiIds),
  );

const probeDb = join(tmpdir(), `recall-probe-${Date.now()}.db`);
const fresh = new ContentStore(probeDb);
const perSource = new Map();
for (const s of sources) {
  const rows = real.prepare("select rowid as id from chunks where source_id = ? order by ord").all(s.id);
  const text = rows.map((r) => getBody.get(r.id)?.body ?? "").join("\n");
  if (!text || perSource.has(s.label)) continue;
  perSource.set(s.label, text);
  fresh.index({ content: text, source: `batch:${s.label}` });
}

let total = 0;
let found = 0;
const misses = [];
for (const [label, text] of perSource) {
  for (const q of sampleFacts(text, FACTS)) {
    total++;
    const src = `batch:${label}`;
    // store.search is the strict porter path; ctx_search uses searchWithFallback
    // (trigram + OR fallbacks), so this probe measures a floor, not the shipped path.
    const inTop = fresh.search(q, 5).some((h) => h.source === src);
    const exact = fresh.search(q, 5, src, "AND", undefined, "exact").length > 0;
    if (inTop || exact) found++;
    else misses.push({ label: label.slice(0, 50), q: q.slice(0, 80) });
  }
}

console.log(
  JSON.stringify(
    {
      db: REAL,
      sourcesReplayed: perSource.size,
      totalBytes: [...perSource.values()].reduce((a, t) => a + Buffer.byteLength(t), 0),
      facts: total,
      recovered: found,
      recall: total ? +(found / total).toFixed(3) : null,
      misses: misses.slice(0, 12),
    },
    null,
    2,
  ),
);

fresh.close();
for (const suffix of ["", "-wal", "-shm"]) rmSync(probeDb + suffix, { force: true });
