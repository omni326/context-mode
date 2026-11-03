/**
 * OpenCode 2 capture parity, found by reading the live database instead of the code.
 *
 * That host sends its own tool names (`read` / `write` / `subagent` …, counted out of
 * opencode.db: 549 `edit` and 113 `read` blocks in one db) and its file argument is
 * `path`, not `file_path`. Both had to line up for an event to be emitted, so file
 * edits, file reads and rule capture were silent on this fork's primary host: the
 * name never normalized and the path lookup came back empty.
 *
 * Same method as the `webfetch` alias fix (f8a98ae2): verify names against real data.
 */

import { describe, test, expect } from "vitest";
import { extractEvents } from "../../src/session/extract.js";

const types = (raw: Parameters<typeof extractEvents>[0]) =>
  extractEvents(raw).map((e) => `${e.type}:${e.data}`);

describe("OpenCode 2 tool names and `path` argument", () => {
  test("edit with `path` records the edited file", () => {
    expect(types({
      tool_name: "edit",
      tool_input: { path: "/repo/src/serve/tool_markup_salvage.h" },
      tool_response: "ok",
    })).toContain("file_edit:/repo/src/serve/tool_markup_salvage.h");
  });

  test("write with `path` records the written file", () => {
    expect(types({
      tool_name: "write",
      tool_input: { path: "/repo/notes.md" },
      tool_response: "ok",
    })).toContain("file_write:/repo/notes.md");
  });

  test("read with `path` records the read file and captures rule content", () => {
    const out = types({
      tool_name: "read",
      tool_input: { path: "/repo/AGENTS.md" },
      tool_response: "# Project rules",
    });
    expect(out).toContain("file_read:/repo/AGENTS.md");
    expect(out).toContain("rule:/repo/AGENTS.md");
    expect(out).toContain("rule_content:# Project rules");
  });

  test("file_path still works for the hosts that send it", () => {
    expect(types({
      tool_name: "Edit",
      tool_input: { file_path: "/repo/a.ts" },
      tool_response: "ok",
    })).toContain("file_edit:/repo/a.ts");
  });

  test("a tool with neither key yields no path rather than a bogus one", () => {
    const out = extractEvents({
      tool_name: "Edit",
      tool_input: { content: "no path here" },
      tool_response: "ok",
    });
    expect(out.every((e) => e.data === "")).toBe(true);
  });
});
