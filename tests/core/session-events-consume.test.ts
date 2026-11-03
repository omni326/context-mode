/**
 * Auto-capture must only consume the current project's event file.
 *
 * `maybeIndexSessionEvents()` used to readdir every `*-events.md` in the shared
 * sessions dir. Files are per-project (`<hash>-events.md`, written by hooks via
 * `getSessionEventsPath`), so that glob did two kinds of damage:
 *   1. project A's first tool call indexed and unlinked project B's pending
 *      events — B never sees them, and B's content lands in A's searchable
 *      index attributed to A's session;
 *   2. with two files present, each `index()` runs the label dedup
 *      (`DELETE … WHERE label='session-events'`) before inserting, so only the
 *      last file survived in the store while both were deleted from disk.
 * The fix consumes exactly the path the hook wrote: `resolveSessionPath` with
 * ext `-events.md`, the same resolver hooks import.
 */

import { describe, test, expect, beforeAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(tmpdir(), `cm-events-${Date.now()}`);
const dataDir = join(root, "data");
const sessionsDir = join(dataDir, "sessions");
const projectDir = join(root, "proj");
const siblingDir = join(root, "other-proj");

// CONTEXT_MODE_DIR is the server's single storage root (sessions/content/stats),
// and CONTEXT_MODE_PROJECT_DIR is how start.mjs pins the project. Both must be
// set before src/server.js computes any path.
process.env.CONTEXT_MODE_DIR = dataDir;
process.env.CONTEXT_MODE_PROJECT_DIR = projectDir;

const { maybeIndexSessionEvents } = await import("../../src/server.js");
const { ContentStore } = await import("../../src/store.js");
const { hashProjectDirCanonical } = await import("../../src/session/db.js");

let store: ContentStore;

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${hashProjectDirCanonical(projectDir)}-events.md`),
    "# own events\nALPHA_OWN_EVENT\n",
  );
  writeFileSync(
    join(sessionsDir, `${hashProjectDirCanonical(siblingDir)}-events.md`),
    "# sibling events\nBRAVO_SIBLING_EVENT\n",
  );
  store = new ContentStore(join(root, "context.db"));
});

describe("session-events auto-consume scope", () => {
  test("indexes the current project's events file", () => {
    maybeIndexSessionEvents(store);
    expect(store.search("ALPHA_OWN_EVENT", 3).some((h) => h.source === "session-events")).toBe(true);
  });

  test("leaves another project's events file on disk and out of this store", () => {
    const sibling = join(sessionsDir, `${hashProjectDirCanonical(siblingDir)}-events.md`);
    expect(existsSync(sibling)).toBe(true);
    expect(readFileSync(sibling, "utf8")).toContain("BRAVO_SIBLING_EVENT");
    expect(store.search("BRAVO_SIBLING_EVENT", 3).length).toBe(0);
  });

  test("is a no-op when there is nothing pending for this project", () => {
    expect(() => maybeIndexSessionEvents(store)).not.toThrow();
    expect(existsSync(join(sessionsDir, `${hashProjectDirCanonical(projectDir)}-events.md`))).toBe(false);
  });

  test("a failed index puts the file back instead of destroying it", () => {
    // The consume claims the file by renaming before indexing, so a second
    // server cannot index-then-unlink the same bytes. If indexing then fails,
    // the claim must be released — otherwise the events are simply gone.
    const own = join(sessionsDir, `${hashProjectDirCanonical(projectDir)}-events.md`);
    writeFileSync(own, "# retry\nCHARLIE_RETRY_EVENT\n");
    const dead = new ContentStore(join(root, "dead.db"));
    dead.close();
    maybeIndexSessionEvents(dead);
    expect(existsSync(own)).toBe(true);
    expect(readFileSync(own, "utf8")).toContain("CHARLIE_RETRY_EVENT");

    // and it is still consumable by a live store afterwards
    maybeIndexSessionEvents(store);
    expect(store.search("CHARLIE_RETRY_EVENT", 3).some((h) => h.source === "session-events")).toBe(true);
  });
});
