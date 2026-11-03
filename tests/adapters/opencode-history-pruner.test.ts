/**
 * Virtual pruning of stale tool results (plan.md phase 3).
 *
 * The V2 `context` hook rewrites the OUTGOING request only — persisted history
 * keeps the raw bytes (proven by probe run 0.3: pruned text reached the model
 * while session_message still carried the sentinel). So the pruner is a pure
 * function over provider messages, and these tests are pure too.
 *
 * Shapes come from the phase-0 probe (probes/opencode-v2-p0-plugin.ts):
 *   role:"tool"      -> content[i] = { type:"tool-result", id, name,
 *                                       result:{type:"content", value:[{type:"text",text}]} }
 *   role:"assistant" -> content[i] = { type:"tool-call", id, name, input }
 * A failed shell call still arrives as type:"content" with "Exited with code 3"
 * appended, so failure detection is textual — never prune what looks like a
 * failure (stripping error details makes the model assume success).
 *
 * keepTokens: 0 appears often because the default keep window (15k tokens ≈
 * 60KB) covers these short fixtures entirely; these tests target the other gates.
 */

import { describe, test, expect } from "vitest";
import { pruneToolResults, textOf, looksFailed } from "../../src/adapters/opencode/history-pruner.js";

const BIG = "x".repeat(9000);

function call(id: string, name: string, input: unknown) {
  return { role: "assistant", content: [{ type: "tool-call", id, name, input }] };
}
function result(id: string, name: string, text: string) {
  return {
    role: "tool",
    content: [{ type: "tool-result", id, name, result: { type: "content", value: [{ type: "text", text }] } }],
  };
}
function user(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Four consumed tool rounds + a trailing user turn; the first result is old and huge. */
function history(firstText = BIG) {
  return [
    user("build it"),
    call("c1", "shell", { command: "npm test" }),
    result("c1", "shell", firstText),
    call("c2", "shell", { command: "npm run lint" }),
    result("c2", "shell", BIG),
    call("c3", "shell", { command: "npm run build" }),
    result("c3", "shell", BIG),
    call("c4", "read", { path: "/tmp/a.ts" }),
    result("c4", "read", BIG),
    user("now fix the flaky test"),
  ];
}

describe("pruneToolResults", () => {
  test("prunes an old large result into an explicit, searchable pointer", () => {
    const out = pruneToolResults(history(), { keepRecentPairs: 3, keepTokens: 0, minBatchBytes: 0 });
    const pruned = textOf(out.messages[2]);
    expect(pruned).not.toContain("xxxxxxxx");
    expect(pruned).toContain("pruned"); // explicit, never silent
    expect(pruned).toContain("ctx_search");
    expect(pruned).toContain("npm test"); // what produced it stays visible
    expect(out.savedBytes).toBeGreaterThan(8000);
  });

  test("leaves the last keepRecentPairs results untouched", () => {
    const out = pruneToolResults(history(), { keepRecentPairs: 3, keepTokens: 0 });
    for (const i of [4, 6, 8]) expect(textOf(out.messages[i])).toContain("xxxxxxxx");
  });

  test("never prunes a result that looks like a failure", () => {
    const failing = history(`boom\n${BIG}\nExited with code 3`);
    const out = pruneToolResults(failing, { keepRecentPairs: 1, keepTokens: 0, minBatchBytes: 0 });
    expect(textOf(out.messages[2])).toContain("Exited with code 3");
    // a sibling in the same pass WAS pruned, so the failure rule is what saved it
    expect(textOf(out.messages[4])).not.toContain("xxxxxxxx");
    expect(looksFailed("boom\nExited with code 3")).toBe(true);
    expect(looksFailed("Test Files 1 passed\n0 failed")).toBe(false);
  });

  test("does not touch results inside the recent-token keep window", () => {
    // Old by pair count, young by byte distance from the tail: keepTokens protects it.
    const msgs = [
      user("go"),
      call("c1", "shell", { command: "make" }),
      result("c1", "shell", BIG),
      user("and now?"),
    ];
    const out = pruneToolResults(msgs, { keepRecentPairs: 0, keepTokens: 15000, minBatchBytes: 0 });
    expect(textOf(out.messages[2])).toContain("xxxxxxxx");
  });

  test("waits for a whole batch above clear_at_least before touching anything", () => {
    const msgs = [
      user("go"),
      call("c1", "shell", { command: "ls" }),
      result("c1", "shell", "y".repeat(6000)),
      user("next"),
    ];
    const out = pruneToolResults(msgs, { keepRecentPairs: 0, keepTokens: 0, minBatchBytes: 20000 });
    expect(out.pruned.length).toBe(0);
    expect(textOf(out.messages[2])).toContain("yyyy");
  });

  test("skips results below the per-result size threshold", () => {
    const msgs = [
      user("go"),
      call("c1", "shell", { command: "ls" }),
      result("c1", "shell", "tiny"),
      call("c2", "shell", { command: "pwd" }),
      result("c2", "shell", "tiny"),
      user("next"),
    ];
    const out = pruneToolResults(msgs, { keepRecentPairs: 0, keepTokens: 0, minBatchBytes: 0 });
    expect(out.pruned.length).toBe(0);
  });

  test("idempotent: a second pass over pruned messages changes nothing", () => {
    const once = pruneToolResults(history(), { keepRecentPairs: 1, keepTokens: 0 });
    const twice = pruneToolResults(once.messages, { keepRecentPairs: 1, keepTokens: 0, decided: once.decided });
    expect(twice.messages).toEqual(once.messages);
    expect(twice.pruned.length).toBe(0);
  });

  test("sticky decisions re-apply the identical placeholder after an un-pruned rebuild", () => {
    const opts = { keepRecentPairs: 1, keepTokens: 0, minBatchBytes: 20_000 };
    const first = pruneToolResults(history(), opts);
    const second = pruneToolResults(history(), opts);
    expect(textOf(second.messages[2])).toBe(textOf(first.messages[2]));
    // Even below the batch floor, an already-decided id stays pruned — otherwise
    // the prefix would flip back and the KV-cache would be invalidated again.
    const small = pruneToolResults(
      [user("go"), call("c9", "shell", { command: "ls" }), result("c9", "shell", "z".repeat(6000)), user("next")],
      { keepRecentPairs: 0, keepTokens: 0, minBatchBytes: 20_000, decided: new Set(["c9"]) },
    );
    expect(textOf(small.messages[2])).toContain("pruned");
  });

  test("returns a new array — V2 only adopts a wholesale reassignment", () => {
    const msgs = history();
    const out = pruneToolResults(msgs, { keepRecentPairs: 1, keepTokens: 0 });
    expect(out.messages).not.toBe(msgs);
    expect(out.pruned.map((p) => p.id)).toEqual(["c1", "c2", "c3"]);
  });

  test("read results point back at the file rather than at ctx_search", () => {
    const msgs = [
      user("go"),
      call("r1", "read", { path: "/src/handler.ts" }),
      result("r1", "read", BIG),
      call("c2", "shell", { command: "ls" }),
      result("c2", "shell", "ok"),
      user("next"),
    ];
    const out = pruneToolResults(msgs, { keepRecentPairs: 1, keepTokens: 0, minBatchBytes: 0 });
    expect(textOf(out.messages[2])).toContain("/src/handler.ts");
  });

  test("system entries injected by the harness are left alone", () => {
    const msgs = history();
    msgs.splice(1, 0, { role: "system", content: [{ type: "text", text: "catalog" }] });
    const out = pruneToolResults(msgs, { keepRecentPairs: 1, keepTokens: 0 });
    expect(out.messages[1].content[0].text).toBe("catalog");
  });
});
