/**
 * Cross-hook markers must be keyed per tool call, not per session.
 *
 * PreToolUse writes `context-mode-rejected-<sid>.txt` / `context-mode-redirect-<sid>.txt`
 * and PostToolUse consumes them. Hosts run tool calls in parallel (parallel
 * tool_use blocks, subagents): with a session-wide name the second PreToolUse
 * overwrites the first marker, and whichever PostToolUse runs first consumes the
 * other call's marker — one event is lost and the survivor is attributed to the
 * wrong tool. `ctx_stats`'s bytes_avoided inherits the same error.
 *
 * Hosts that send no call id keep the session-wide name (today's behaviour), and
 * hosts whose Pre/Post ids differ (Cursor's fixtures send two distinct ids) fall
 * back to the session's oldest marker rather than losing the event outright.
 */

import { describe, test, expect, afterEach } from "vitest";
import { writeFileSync, existsSync, utimesSync, readFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { hookMarkerPath, readAndConsumeHookMarker } from "../../hooks/session-helpers.mjs";

const sid = `percall-${Date.now()}`;
const created: string[] = [];

function write(path: string, data: string, ageMs = 0): void {
  writeFileSync(path, data, "utf-8");
  created.push(path);
  if (ageMs) {
    const t = Date.now() / 1000 - ageMs / 1000;
    utimesSync(path, t, t);
  }
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      if (existsSync(p)) rmSync(p);
    } catch { /* already consumed by the code under test */ }
  }
});

describe("per-call hook markers", () => {
  test("two parallel calls in one session get different files", () => {
    const a = hookMarkerPath("context-mode-rejected-", sid, "tu-AAA");
    const b = hookMarkerPath("context-mode-rejected-", sid, "tu-BBB");
    expect(a).not.toBe(b);
    write(a, "Bash: denied A");
    write(b, "WebFetch: denied B");

    expect(readAndConsumeHookMarker("context-mode-rejected-", sid, "tu-AAA")).toBe("Bash: denied A");
    expect(readAndConsumeHookMarker("context-mode-rejected-", sid, "tu-BBB")).toBe("WebFetch: denied B");
    // Consumed exactly once — a third PostToolUse must not re-emit either event.
    expect(readAndConsumeHookMarker("context-mode-rejected-", sid, "tu-AAA")).toBe("");
  });

  test("no call id keeps the session-wide name", () => {
    const legacy = join(tmpdir(), `context-mode-rejected-${sid}.txt`);
    write(legacy, "Bash: denied legacy");
    expect(basename(hookMarkerPath("context-mode-rejected-", sid, undefined))).toBe(
      `context-mode-rejected-${sid}.txt`,
    );
    expect(readAndConsumeHookMarker("context-mode-rejected-", sid, undefined)).toBe("Bash: denied legacy");
    expect(existsSync(legacy)).toBe(false);
  });

  test("differing Pre/Post ids still consume the session's oldest marker", () => {
    // Cursor's fixtures: pre tool_use_id=cursor-tool-001, post cursor-tool-002.
    const written = hookMarkerPath("context-mode-redirect-", sid, "cursor-tool-001");
    write(written, "Bash:bash-redirected:8192:mvn package", 5000);
    const newer = hookMarkerPath("context-mode-redirect-", sid, "cursor-tool-003");
    write(newer, "Bash:bash-redirected:100:other");
    expect(readAndConsumeHookMarker("context-mode-redirect-", sid, "cursor-tool-002")).toBe(
      "Bash:bash-redirected:8192:mvn package",
    );
    expect(readAndConsumeHookMarker("context-mode-redirect-", sid, "cursor-tool-002")).toBe(
      "Bash:bash-redirected:100:other",
    );
  });

  test("the call id cannot escape the tmp directory", () => {
    const p = hookMarkerPath("context-mode-rejected-", sid, "../../etc/passwd");
    expect(p.startsWith(join(tmpdir(), "context-mode-rejected-"))).toBe(true);
    expect(p).not.toContain("..");
    expect(p.endsWith(".txt")).toBe(true);
  });

  test("a longer session id is not mistaken for ours", () => {
    // Fallback scans by prefix; `${sid}` must not swallow `${sid}-EXTRA`.
    const other = join(tmpdir(), `context-mode-rejected-${sid}-EXTRA.txt`);
    write(other, "not ours");
    expect(readAndConsumeHookMarker("context-mode-rejected-", sid, "tu-ZZZ")).toBe("");
    expect(readFileSync(other, "utf-8")).toBe("not ours");
  });
});
