/**
 * Cross-hook marker files must not accumulate forever.
 *
 * PreToolUse writes `context-mode-latency-<sid>-<tool>.txt` for every call and
 * `context-mode-rejected-<sid>.txt` on every deny/modify. PostToolUse is the only
 * consumer — so a denied call (no PostToolUse), a crash between the two hooks, or
 * a subagent tool leaves the marker behind permanently. Nothing swept them.
 *
 * The sweep is deliberately limited to these two prefixes: other
 * `context-mode-*` files in tmp carry different contracts (cache, heal, redirect,
 * retrieval) and are consumed elsewhere.
 */

import { describe, test, expect } from "vitest";
import { writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepStaleHookMarkers } from "../../hooks/session-helpers.mjs";

const DAY = 86400;
const sid = `sweeptest-${Date.now()}`;
const paths = {
  staleLatency: join(tmpdir(), `context-mode-latency-${sid}-Bash.txt`),
  staleRejected: join(tmpdir(), `context-mode-rejected-${sid}.txt`),
  freshLatency: join(tmpdir(), `context-mode-latency-${sid}-Read.txt`),
  otherPrefix: join(tmpdir(), `context-mode-retrieval-${sid}.txt`),
};

function age(path: string, seconds: number): void {
  const t = Date.now() / 1000 - seconds;
  utimesSync(path, t, t);
}

describe("sweepStaleHookMarkers", () => {
  test("removes day-old latency/rejected markers, spares fresh ones and other prefixes", () => {
    for (const p of Object.values(paths)) writeFileSync(p, "123", "utf-8");
    age(paths.staleLatency, 2 * DAY);
    age(paths.staleRejected, 2 * DAY);
    age(paths.otherPrefix, 2 * DAY); // different contract — must survive

    sweepStaleHookMarkers();

    expect(existsSync(paths.staleLatency)).toBe(false);
    expect(existsSync(paths.staleRejected)).toBe(false);
    expect(existsSync(paths.freshLatency)).toBe(true);
    expect(existsSync(paths.otherPrefix)).toBe(true);

    for (const p of Object.values(paths)) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  });
});
