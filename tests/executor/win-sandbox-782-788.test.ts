import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  PolyglotExecutor,
  rewriteWindowsBuildTools,
  cleanupStaleSandboxDirs,
  OS_TMPDIR,
} from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";

// ─────────────────────────────────────────────────────────────────────
// Cluster C3 — Windows ctx_execute sandbox.
//
// #782: Maven (mvn) fails on Windows in the ctx_execute sandbox because
//   Git Bash's `mvn` shell script takes the mingw=true branch and leaves
//   CLASSWORLDS_JAR as a POSIX path that native java.exe can't resolve.
//   The third-way fix (Option C in the issue) rewrites a bare `mvn`
//   invocation to `mvn.cmd` on Windows — the native launcher that uses
//   Windows paths — WITHOUT re-enabling global MSYS path-conversion
//   suppression that #826/#791 deliberately removed for native git.
//
// #788: Two sub-bugs:
//   (a) Non-shell ctx_execute runtimes (python/js/ts/…) ran with cwd set
//       to the .ctx-mode-* sandbox tmpDir, so repo-relative checks like
//       `package.json` exists() failed. They must run in the project root
//       (or per-call cwd override) like shell does. The script FILE still
//       lives in the sandbox; only the process cwd changes.
//   (b) `.ctx-mode-*` temp dirs leaked on Windows when they contained
//       SQLite -wal/-shm files with lingering handles — the single rmSync
//       threw EBUSY/EPERM and the silent catch{} swallowed it. Cleanup
//       must retry.
// ─────────────────────────────────────────────────────────────────────

const runtimes = detectRuntimes();

describe("#782 — Windows mvn path-conversion (rewriteWindowsBuildTools)", () => {
  it("rewrites a bare `mvn` invocation to `mvn.cmd` on win32", () => {
    expect(rewriteWindowsBuildTools("mvn clean install", "win32")).toBe(
      "mvn.cmd clean install",
    );
  });

  it("rewrites `mvn` after a shell operator (&&, |, ;, newline)", () => {
    expect(
      rewriteWindowsBuildTools("cd app && mvn -version", "win32"),
    ).toBe("cd app && mvn.cmd -version");
    expect(rewriteWindowsBuildTools("mvn test; echo done", "win32")).toBe(
      "mvn.cmd test; echo done",
    );
    expect(rewriteWindowsBuildTools("echo a\nmvn package", "win32")).toBe(
      "echo a\nmvn.cmd package",
    );
  });

  it("does NOT touch mvn on non-Windows platforms", () => {
    expect(rewriteWindowsBuildTools("mvn clean install", "linux")).toBe(
      "mvn clean install",
    );
    expect(rewriteWindowsBuildTools("mvn clean install", "darwin")).toBe(
      "mvn clean install",
    );
  });

  it("does NOT double-rewrite an already-.cmd invocation", () => {
    expect(rewriteWindowsBuildTools("mvn.cmd clean install", "win32")).toBe(
      "mvn.cmd clean install",
    );
  });

  it("does NOT rewrite a wrapper (mvnw) or a substring like `mvnd`/`mymvn`", () => {
    expect(rewriteWindowsBuildTools("./mvnw clean", "win32")).toBe(
      "./mvnw clean",
    );
    expect(rewriteWindowsBuildTools("mymvn run", "win32")).toBe("mymvn run");
    expect(rewriteWindowsBuildTools("mvnd build", "win32")).toBe("mvnd build");
  });
});

describe.runIf(runtimes.python)(
  "#788(a) — non-shell ctx_execute runs in project root",
  () => {
    it("python sees the project root as cwd, not the sandbox tmpDir", async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "ctx-proj-py-"));
      try {
        const executor = new PolyglotExecutor({
          runtimes,
          projectRoot: () => projectDir,
        });
        const result = await executor.execute({
          language: "python",
          code: "import os; print(os.path.basename(os.getcwd()))",
        });
        expect(result.exitCode).toBe(0);
        // cwd basename must be the project dir, NOT a `.ctx-mode-*` tmp dir.
        expect(result.stdout.trim()).toBe(basename(projectDir));
        expect(result.stdout).not.toContain(".ctx-mode-");
      } finally {
        try {
          rmSync(projectDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("python honors a per-call cwd override", async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "ctx-proj-wrong-"));
      const overrideDir = mkdtempSync(join(tmpdir(), "ctx-proj-override-"));
      try {
        const executor = new PolyglotExecutor({
          runtimes,
          projectRoot: () => projectDir,
        });
        const result = await executor.execute({
          language: "python",
          code: "import os; print(os.path.basename(os.getcwd()))",
          cwd: overrideDir,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(basename(overrideDir));
      } finally {
        try {
          rmSync(projectDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        try {
          rmSync(overrideDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });
  },
);

describe("#788(b) — sandbox temp dir is cleaned up after run", () => {
  it("removes the exact dir the run used", async () => {
    const executor = new PolyglotExecutor({ runtimes });
    const lang = runtimes.python ? "python" : "shell";
    const code = lang === "python" ? "print('hi')" : "echo hi";
    const result = await executor.execute({ language: lang, code });
    expect(result.exitCode).toBe(0);

    // The old version diffed the whole tmpdir for `.ctx-mode-*` names, which two
    // things broke: other tests running the executor concurrently appeared as
    // leaks (flaky red on a full suite), and the executor resolves its own temp
    // root — on macOS `getconf DARWIN_USER_TEMP_DIR` with TMPDIR deliberately
    // stripped (executor.ts:99), not `tmpdir()` — so a mismatch made the test
    // blind and permanently green.
    expect(result.tmpDir, "execute() must report the dir it used").toBeTruthy();
    expect(existsSync(result.tmpDir!)).toBe(false);
  });

  it("cleanupStaleSandboxDirs reaps aged dirs and spares young ones", () => {
    // The #788 case in the wild: cleanupTmpDir fails on a lingering handle and the
    // catch is silent, so nothing else ever removed them — 52 `.ctx-mode-*` dirs had
    // piled up in one machine's /var/folders, which macOS never reclaims.
    const stale = mkdtempSync(join(OS_TMPDIR, ".ctx-mode-"));
    const fresh = mkdtempSync(join(OS_TMPDIR, ".ctx-mode-"));
    writeFileSync(join(stale, "out.txt"), "x", "utf-8");
    const old = Date.now() / 1000 - 8 * 86400;
    utimesSync(stale, old, old);

    try {
      expect(cleanupStaleSandboxDirs()).toBeGreaterThanOrEqual(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true); // a backgrounded run may still be writing
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
