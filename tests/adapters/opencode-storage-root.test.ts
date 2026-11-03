/**
 * Storage-root guard (plan.md phase 1, item 2).
 *
 * OpenCode exports no OPENCODE_* env into its MCP stdio child, so detection can
 * only key off MCP clientInfo.name. If that mapping is lost, detection falls
 * through to config-dir probing and roots an OpenCode session under ~/.claude —
 * splitting state away from the in-process V2 plugin, which writes under
 * ~/.config/opencode. These two assertions lock that fix in place.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPlatform } from "../../src/adapters/detect.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";

const saved = { xdg: process.env.XDG_CONFIG_HOME, data: process.env.CONTEXT_MODE_DATA_DIR };
let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.xdg;
  if (saved.data === undefined) delete process.env.CONTEXT_MODE_DATA_DIR;
  else process.env.CONTEXT_MODE_DATA_DIR = saved.data;
});

describe("OpenCode storage root", () => {
  it("detects opencode from clientInfo.name alone (no env in the MCP child)", () => {
    const signal = detectPlatform({ name: "opencode", version: "2.2.5" });
    expect(signal.platform).toBe("opencode");
    expect(signal.confidence).toBe("high");
  });

  it("roots OpenCode sessions under the opencode config dir, never ~/.claude", () => {
    dir = mkdtempSync(join(tmpdir(), "cm-root-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.CONTEXT_MODE_DATA_DIR;
    const sessionDir = new OpenCodeAdapter("opencode").getSessionDir();
    expect(sessionDir.startsWith(join(dir, "opencode"))).toBe(true);
    expect(sessionDir).not.toContain(".claude");
  });
});
