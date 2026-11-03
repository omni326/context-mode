/**
 * A corrupt content DB must be renamed, not deleted.
 *
 * `ContentStore`'s constructor treated SQLITE_CORRUPT / "file is not a database"
 * by deleting db+wal+shm and reopening empty. That is the entire persistent
 * knowledge base of a project, gone with no forensic copy — and "file is not a
 * database" is also what a half-created file from a peer process that died
 * mid-create looks like, so one window's cold boot can destroy another's data.
 * `SQLiteBase` in the same repo already does this correctly (`renameCorruptDB`),
 * so the fix is to use the existing helper rather than invent one.
 *
 * The constructor also used to unlink stray -wal/-shm BEFORE opening, whenever
 * the .db was absent. A project with no DB yet, started in two windows at once,
 * had the second boot delete the WAL the first had just committed to. The
 * source-pin below keeps that pre-open call from coming back; the surviving
 * call sits after `renameCorruptDB`, where the file really is being discarded.
 */

import { describe, test, expect } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../../src/store.js";

describe("ContentStore corruption handling", () => {
  const dir = join(tmpdir(), `cm-corrupt-${Date.now()}`);
  const dbPath = join(dir, "context.db");

  test("a file that is not a database is preserved as .corrupt-<ts>, not deleted", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dbPath, "this is not a sqlite database at all");

    const store = new ContentStore(dbPath);
    store.close();

    const names = readdirSync(dir);
    expect(existsSync(join(dir, "context.db"))).toBe(true); // rebuilt fresh
    expect(names.some((n) => n.startsWith("context.db.corrupt-"))).toBe(true);
    expect(readFileSync(dbPath, "utf8")).not.toBe("this is not a sqlite database at all");
    rmSync(dir, { recursive: true, force: true });
  });

  test("no WAL/SHM cleanup happens before the open (cross-process race)", () => {
    // shortcut: a two-process open race is not scriptable in one vitest worker,
    // so this pins the source. Upgrade to a behavioural test if a second process
    // can be spawned deterministically against the same path.
    const src = readFileSync(new URL("../../src/store.ts", import.meta.url), "utf8");
    const ctor = src.slice(src.indexOf("constructor(dbPath?: string)"), src.indexOf("constructor(dbPath?: string)") + 1200);
    expect(ctor).not.toContain("cleanOrphanedWALFiles(");

    // Same rule for the shared base class (SessionDB consumers open the same
    // path from several processes — ADR 0001 says multi-writer is the contract).
    const base = readFileSync(new URL("../../src/db-base.ts", import.meta.url), "utf8");
    const baseCtor = base.slice(base.indexOf("constructor(dbPath: string)"), base.indexOf("constructor(dbPath: string)") + 1200);
    const openAt = baseCtor.indexOf("new Database(");
    const cleanAt = baseCtor.indexOf("cleanOrphanedWALFiles(");
    expect(cleanAt).toBeGreaterThan(openAt); // recovery path only, never pre-open
  });
});
