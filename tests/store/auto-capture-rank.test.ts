/**
 * Auto-capture demotion in search ranking (plan.md phase 1, item 3).
 *
 * Hook-captured session events (label "session-events") land in the same FTS5
 * index as deliberate ctx_* output. At equal match quality the deliberate
 * source must rank first, so recall noise cannot drown real work. The demotion
 * scales bm25 uniformly, so an explicit source filter still reaches the events.
 */

import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../../src/store.js";

function createStore(): ContentStore {
  return new ContentStore(
    join(tmpdir(), `context-mode-rank-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
  );
}

const TEXT = "# Deploy report\nalpha beta gamma delta\n";

describe("auto-capture search demotion", () => {
  test("deliberate output outranks auto-captured events at equal match quality", () => {
    const store = createStore();
    store.index({ content: TEXT, source: "session-events" });
    store.index({ content: TEXT, source: "ctx-batch-42" });
    const hits = store.search("alpha beta gamma delta", 2);
    expect(hits.map((h) => h.source)).toEqual(["ctx-batch-42", "session-events"]);
    store.close();
  });

  test("an explicit source filter still reaches auto-captured events", () => {
    const store = createStore();
    store.index({ content: TEXT, source: "session-events" });
    store.index({ content: TEXT, source: "ctx-batch-42" });
    const hits = store.search("alpha beta gamma delta", 5, "session-events");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.source).toBe("session-events");
    store.close();
  });
});
