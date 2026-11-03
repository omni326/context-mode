/**
 * Cross-hook marker files must not accumulate forever.
 *
 * PreToolUse writes `context-mode-latency-<sid>-<tool>.txt` for every call and
 * `context-mode-rejected-<sid>.txt` on every deny/modify. PostToolUse is the only
 * consumer — so a denied call (no PostToolUse), a crash between the two hooks, or
 * a subagent tool leaves the marker behind permanently. Nothing swept them.
 *
 * The sweep covers every marker family that has no other consumer. Measured on one
 * machine before this existed: 140 stale `retrieval-` markers and 19 `guidance-`
 * directories. Files with a different contract (sandbox dirs, which the server
 * sweeps by age in cleanupStaleSandboxDirs) must survive here.
 */

import { describe, test, expect } from "vitest";
import { writeFileSync, existsSync, utimesSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepStaleHookMarkers } from "../../hooks/session-helpers.mjs";

const DAY = 86400;
const sid = `sweeptest-${Date.now()}`;
const paths = {
  staleLatency: join(tmpdir(), `context-mode-latency-${sid}-Bash.txt`),
  staleRejected: join(tmpdir(), `context-mode-rejected-${sid}.txt`),
  staleRedirect: join(tmpdir(), `context-mode-redirect-${sid}.txt`),
  staleRetrieval: join(tmpdir(), `context-mode-retrieval-${sid}.txt`),
  // guidance markers live in a per-session directory (routing.mjs:122)
  staleGuidanceDir: join(tmpdir(), `context-mode-guidance-${sid}`),
  freshLatency: join(tmpdir(), `context-mode-latency-${sid}-Read.txt`),
  otherPrefix: join(tmpdir(), `context-mode-cache-${sid}.txt`),
};

function age(path: string, seconds: number): void {
  const t = Date.now() / 1000 - seconds;
  utimesSync(path, t, t);
}

describe("sweepStaleHookMarkers", () => {
  test("removes day-old markers of every family, spares fresh ones and other prefixes", () => {
    for (const p of Object.values(paths)) writeFileSync(p, "123", "utf-8");
    // the guidance dir needs a file inside it and a dir mtime to age
    rmSync(paths.staleGuidanceDir, { recursive: true, force: true });
    mkdirSync(paths.staleGuidanceDir, { recursive: true });
    writeFileSync(join(paths.staleGuidanceDir, "bash.count"), "1", "utf-8");
    age(join(paths.staleGuidanceDir, "bash.count"), 2 * DAY);
    age(paths.staleGuidanceDir, 2 * DAY);

    for (const p of [paths.staleLatency, paths.staleRejected, paths.staleRedirect, paths.staleRetrieval, paths.otherPrefix]) age(p, 2 * DAY);

    sweepStaleHookMarkers();

    expect(existsSync(paths.staleLatency)).toBe(false);
    expect(existsSync(paths.staleRejected)).toBe(false);
    expect(existsSync(paths.staleRedirect)).toBe(false);
    expect(existsSync(paths.staleRetrieval)).toBe(false);
    expect(existsSync(paths.staleGuidanceDir)).toBe(false);
    expect(existsSync(paths.freshLatency)).toBe(true);
    expect(existsSync(paths.otherPrefix)).toBe(true);

    for (const p of Object.values(paths)) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
