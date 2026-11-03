/**
 * Unbounded Bash reroute (plan.md phase 2).
 *
 * Default off: an unbounded command gets the one-shot nudge and still runs
 * natively. With CONTEXT_MODE_BASH_REROUTE=1 the call is replaced with an
 * explicit redirect to ctx_batch_execute, so the output never enters context.
 * Structurally-bounded commands (#463) must stay untouched either way.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNBOUNDED = "find . -name '*.ts'";
const BOUNDED = "git status";

function withSentinel(): string {
  // mcpRedirect() only fires when a live MCP sentinel is visible; fake one for
  // this process (CONTEXT_MODE_MCP_SENTINEL_DIR is the test hook in mcp-ready.mjs).
  const dir = mkdtempSync(join(tmpdir(), "cm-sentinel-"));
  writeFileSync(join(dir, `context-mode-mcp-ready-${process.pid}`), String(process.pid));
  process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = dir;
  return dir;
}

describe("Bash reroute", () => {
  let dir: string;

  beforeEach(() => { dir = withSentinel(); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
    delete process.env.CONTEXT_MODE_BASH_REROUTE;
  });

  async function route(input: string) {
    const { routePreToolUse, resetGuidanceThrottle } = await import("../../hooks/core/routing.mjs");
    // Must pass the session id: without it, reset only clears the ppid-based dir
    // and a stale on-disk marker from a previous run silently kills the nudge.
    resetGuidanceThrottle("test-session");
    return routePreToolUse("Bash", { command: input }, process.cwd(), "opencode", "test-session");
  }

  it("leaves structurally-bounded commands alone even when reroute is on", async () => {
    process.env.CONTEXT_MODE_BASH_REROUTE = "1";
    expect(await route(BOUNDED)).toBeNull();
  });

  it("nudges without rerouting by default", async () => {
    const decision = await route(UNBOUNDED);
    expect(decision?.action).toBe("context");
    expect(JSON.stringify(decision)).not.toContain("ctx_batch_execute({commands");
  });

  it("reroutes unbounded commands to ctx_batch_execute when enabled", async () => {
    process.env.CONTEXT_MODE_BASH_REROUTE = "1";
    const decision = await route(UNBOUNDED);
    expect(decision?.action).toBe("modify");
    const cmd = String(decision?.updatedInput?.command ?? "");
    expect(cmd).toContain("ctx_batch_execute");
    expect(cmd).toContain("find . -name '*.ts'");   // original command survives verbatim
    expect(cmd).toContain("rerouted");                  // explicit, never silent
    expect(decision?.redirectMeta?.type).toBe("bash-redirected");
  });

  it("falls back to the nudge when MCP tools are unavailable", async () => {
    process.env.CONTEXT_MODE_BASH_REROUTE = "1";
    const { routePreToolUse, resetGuidanceThrottle } = await import("../../hooks/core/routing.mjs");
    resetGuidanceThrottle("s2");
    const decision = routePreToolUse("Bash", { command: UNBOUNDED }, process.cwd(), "opencode", "s2", {
      mcpToolsAvailable: false,
    });
    expect(decision?.action).toBe("context");
  });
});
