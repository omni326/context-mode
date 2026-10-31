import "../setup-home";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setActiveFakeHome } from "../util/isolated-env-state.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";

const realCwd = process.cwd();
const dirs: string[] = [];

// Fake HOME (the suite mocks node:os homedir() through isolated-env-state) plus
// a chdir out of the repo, whose own opencode.json would otherwise win the
// adapter's config-path search.
function useFakeHome(body: string): string {
  const home = mkdtempSync(join(tmpdir(), "cm-opencode-cfg-"));
  dirs.push(home);
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode.jsonc");
  writeFileSync(file, body, "utf-8");
  setActiveFakeHome(home);
  process.chdir(home);
  return file;
}

afterEach(() => {
  process.chdir(realCwd);
  setActiveFakeHome(undefined);
  while (dirs.length) {
    const p = dirs.pop();
    if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

describe("OpenCodeAdapter on an OpenCode 2 (`plugins`) config", () => {
  it("counts a plugins entry as registered", () => {
    useFakeHome(JSON.stringify({ plugins: ["~/AIM/plugins/context-mode-v2"] }));

    const reg = new OpenCodeAdapter()
      .validateHooks("/plugin-root")
      .find((r) => r.check === "Plugin registration");

    expect(reg?.status).toBe("pass");
  });

  it("configureAllHooks leaves a V2 config byte-for-byte alone", () => {
    const file = useFakeHome(
      `{\n  // keep my comments\n  "plugins": ["~/AIM/plugins/context-mode-v2"]\n}\n`,
    );
    const before = readFileSync(file, "utf-8");

    new OpenCodeAdapter().configureAllHooks("/plugin-root");

    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("still registers the V1 plugin key for a V1 config", () => {
    const file = useFakeHome('{\n  "model": "x/y"\n}\n');

    const changes = new OpenCodeAdapter().configureAllHooks("/plugin-root");

    expect(changes).toContain("Added context-mode to plugin array");
    expect(JSON.parse(readFileSync(file, "utf-8")).plugin).toEqual(["context-mode"]);
  });

  it("does not rewrite a config that needs no change", () => {
    const file = useFakeHome('{\n  // keep my comments\n  "plugin": ["context-mode"]\n}\n');
    const before = readFileSync(file, "utf-8");

    new OpenCodeAdapter().configureAllHooks("/plugin-root");

    expect(readFileSync(file, "utf-8")).toBe(before);
  });
});
