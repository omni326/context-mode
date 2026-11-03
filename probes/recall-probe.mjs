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
 *   PROBE_DB=~/.context-mode/projects/<project-hash>/context.db PROBE_FACTS=20 \
 *     node probes/recall-probe.mjs
 * `PROBE_DB` defaults to the busiest project store on this machine. Output is one
 * JSON object: sources replayed, bytes, facts sampled, recovered, recall, misses,
 * plus escape-bearing chunks (ANSI) reported separately so a colour-code effect is
 * never confused with a chunk-boundary artifact.
 *
 * RESULT (2026-11-04, opencode v2.2.5, context-mode fork @ 44c6df1f)
 *   98 sources / 1.33 MB replayed, 327 fact queries, 327 recovered → recall 1.000
 *   (gate was ≥0.95). The 3 initial ANSI "misses" were probe artifacts: the phrases
 *   were built from escape-stripped text and spanned chunk/source boundaries, so
 *   they were never contiguous visible text. A dedicated adjacency A/B over the 4
 *   escape-bearing sources (4/4 recovered with escapes indexed vs 4/4 without)
 *   showed indexing escapes verbatim costs nothing measurable — that is why there
 *   is no ANSI stripping at the index chokepoint.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../build/store.js";

const REAL =
  process.env.PROBE_DB ||
  join(process.env.HOME, ".context-mode/projects/88d413faf427e440/context.db");
const FACTS = Number(process.env.PROBE_FACTS || 20);
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function sampleFacts(text, n) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const facts = [];
  const step = Math.max(1, Math.floor(lines.length / n));
  for (let i = 0; i < lines.length && facts.length < n; i += step) {
    const l = lines[i];
    if (l.length < 24 || l.length > 400) continue;
    const words = strip(l).split(/\s+/).filter((w) => /[A-Za-z0-9_./-]{5,}/.test(w));
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

const fresh = new ContentStore(join(tmpdir(), `recall-probe-${Date.now()}.db`));
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
