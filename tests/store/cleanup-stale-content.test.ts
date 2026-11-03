/**
 * The content-DB sweeper must never delete a live database.
 *
 * `cleanupStaleContentDBs()` had a "zombie" branch: if a DB was not older than
 * `maxAgeDays` but its `-wal` was non-empty and untouched for >1h, it deleted
 * db+wal+shm. The comment claimed a PID check; there was none. That shape —
 * non-empty WAL, no writes for an hour — is the NORMAL state of an idle editor
 * window, because SQLite auto-checkpoints only at 1000 pages. So any other
 * project's server starting up could delete a live project's knowledge base
 * while that project kept writing to now-unlinked inodes.
 */

import { describe, test, expect } from "vitest";
import { mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupStaleContentDBs } from "../../src/store.js";

const HOUR = 3600;
const DAY = 86400;

function setup(): string {
  const dir = join(tmpdir(), `cm-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function touchOld(path: string, ageSeconds: number): void {
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(path, t, t);
}

describe("cleanupStaleContentDBs", () => {
  test("keeps a live idle DB whose WAL is non-empty but hour-stale", () => {
    const dir = setup();
    const db = join(dir, "live.db");
    writeFileSync(db, "header");                    // fresh mtime: project is alive
    writeFileSync(db + "-wal", "x".repeat(64));     // non-empty WAL
    touchOld(db + "-wal", 2 * HOUR);                // nobody wrote since lunch

    expect(cleanupStaleContentDBs(dir, 14)).toBe(0);
    expect(existsSync(db)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("deletes only databases past the age cutoff, with their wal/shm", () => {
    const dir = setup();
    const old = join(dir, "old.db");
    const live = join(dir, "live.db");
    writeFileSync(old, "header");
    writeFileSync(old + "-wal", "junk");
    writeFileSync(live, "header");
    touchOld(old, 20 * DAY);

    expect(cleanupStaleContentDBs(dir, 14)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(old + "-wal")).toBe(false);
    expect(existsSync(live)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a legacy sweep spares a recent DB (regression for the old maxAgeDays=0 call)", () => {
    const dir = setup();
    const db = join(dir, "still-in-use.db");
    writeFileSync(db, "header");
    expect(cleanupStaleContentDBs(dir, 14)).toBe(0);
    expect(existsSync(db)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
