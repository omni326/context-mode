/**
 * OpenCode 2 (V2) plugin entry point for context-mode.
 *
 * Why this file exists
 * --------------------
 * The V1 entry (`plugin.ts`) default-exports `{ id, server }` and returns its
 * hooks as a plain object keyed by V1 strings (`tool.execute.before`,
 * `experimental.chat.system.transform`, ...). OpenCode 2 does NOT run V1 plugin
 * implementations: it imports a definition shaped `{ id, setup(ctx) }` and
 * registers each hook on the domain that owns it (see
 * https://opencode.ai/v2/docs/build/plugins/migrate-v1).
 *
 * Rather than duplicate the routing / capture / snapshot business logic, this
 * adapter reuses the exact V1 factory (`createContextModePlugin`) and only
 * rewires its returned hooks onto the V2 context API:
 *
 *   tool.execute.before               -> ctx.tool.hook("execute.before")
 *   tool.execute.after                -> ctx.tool.hook("execute.after")
 *   chat.message                      -> ctx.session.hook("prompt")
 *   experimental.chat.system.transform-> ctx.session.hook("context")   [see shadowSystem]
 *   experimental.session.compacting   -> ctx.session.hook("compaction") -> event.result.summary
 *   event                             -> ctx.event.subscribe()
 *   tool map (ctx_* native tools)     -> ctx.tool.transform(editor.add)  [opt-in, see below]
 *
 * Two V1/V2 differences that are NOT a plain rename (both verified against a
 * running OpenCode 2):
 *
 *  1. The `context` hook only persists a WHOLESALE reassignment of
 *     `event.system`; in-place `splice`/`push` — which is all the V1 code does —
 *     is silently dropped. `shadowSystem` hands the V1 factory a real string[]
 *     it can mutate freely, then we assign the result back as content parts.
 *
 *  2. Registering the plugin's native `ctx_*` tools collides with the same-named
 *     MCP tools when context-mode is also wired up as an MCP server (the common
 *     setup): the tool list shows the name but dispatch fails with
 *     `No tool named "ctx_stats"`. So native tools are OFF by default; set
 *     CONTEXT_MODE_PLUGIN_TOOLS=1 to register them in-process instead.
 */
import { Plugin } from "@opencode/plugin";
import { createContextModePlugin } from "./plugin.js";

type ContentPart = { type: string; text?: string };

// V1 hooks read/write `system` as string[] and guard with Array.isArray, and
// systemHasRoutingInstructions() calls .join()/.includes() on it. We hand them a
// real string[] copy (so Array.isArray passes) whose elements are plain strings,
// then override join/includes to operate per-string. Mutations land on the copy;
// the caller assigns them back to event.system once the hook returns.
function shadowSystem(parts: readonly ContentPart[]): string[] {
  const textOf = (p: unknown) => (typeof p === "string" ? p : ((p as ContentPart)?.text ?? ""));
  const arr = parts.map(textOf);
  arr.join = function (this: string[], sep?: string) {
    return Array.prototype.join.call(this, sep ?? ",");
  };
  arr.includes = function (this: string[], s: string) {
    return Array.prototype.some.call(this, (x: string) => String(x).includes(s));
  };
  return arr;
}

// Normalize the shadow array (string[]) back into V2 content parts.
function toParts(arr: readonly string[]): ContentPart[] {
  return arr.map((x) => (typeof x === "string" ? { type: "text", text: x } : x));
}

export default Plugin.define({
  id: "context-mode",
  async setup(ctx) {
    // The V1 factory only uses ctx.directory (falls back to cwd) and
    // ctx.client.app.log (its safeLog already swallows errors, so logging just
    // no-ops under V2 where there is no client). directory comes from location.
    const h = await createContextModePlugin({
      directory: ctx.location?.directory ?? process.cwd(),
      // V2 exposes MCP tools through the Code Mode `execute` catalog; guidance
      // text must name tools["context-mode"]["ctx_*"], not context-mode_ctx_*.
      namingPlatform: "opencode-v2",
    } as never);

    const disposers: Array<() => void> = [];

    // ── Native ctx_* tools → V2 tool transform (opt-in) ──────────────
    // Off by default: collides with the MCP-provided ctx_* tools in the common
    // MCP+plugin setup. See file header for the failure mode.
    if (process.env.CONTEXT_MODE_PLUGIN_TOOLS === "1" && h.tool && Object.keys(h.tool).length > 0) {
      const z = await import("zod/v4").then((m) => (m as { default?: unknown }).default ?? m).catch(() => null);
      const toJsonSchema = (argsShape: unknown) => {
        if (!z || !argsShape || typeof argsShape !== "object") return undefined;
        try {
          const zod = z as { object: (s: unknown) => { toJSONSchema?: unknown } };
          const json = (zod.object(argsShape) as { toJSONSchema?: (o: unknown) => Record<string, unknown> })
            .toJSONSchema?.({ io: "input", target: "draft-2020-12" });
          if (json) delete json.$schema;
          return json ?? undefined;
        } catch {
          return undefined;
        }
      };
      const reg = await ctx.tool.transform((editor) => {
        for (const [name, t] of Object.entries(h.tool as Record<string, {
          description?: string; args?: unknown;
          execute: (a: never, c: never) => Promise<unknown>;
        }>)) {
          editor.add({
            name,
            description: t.description ?? "",
            input: toJsonSchema(t.args) ?? { type: "object", properties: {}, additionalProperties: true },
            execute: async (input: unknown, c: { sessionID?: string; messageID?: string; agent?: string; directory?: string; signal?: AbortSignal }) => {
              const out = (await t.execute(input as never, {
                sessionID: c?.sessionID,
                messageID: c?.messageID,
                agent: c?.agent ?? "",
                directory: c?.directory ?? ctx.location?.directory ?? process.cwd(),
                abort: c?.signal,
                metadata: () => {},
              } as never)) as string | { output?: string };
              const text = typeof out === "string" ? out : (out?.output ?? JSON.stringify(out ?? ""));
              return { content: [{ type: "text", text }] };
            },
          } as never);
        }
      });
      disposers.push(() => void reg.dispose());
    }

    // ── tool.execute.before / after → ctx.tool.hook ──────────────────
    if (h["tool.execute.before"]) {
      const reg = await ctx.tool.hook("execute.before", async (event) => {
        // Pass args by reference: V1 "modify" decisions rewrite output.args, which
        // is exactly V2's mutable event.input. V2 identifies the call via event.id.
        await h["tool.execute.before"](
          { tool: event.tool, sessionID: event.sessionID, callID: event.id },
          { args: event.input } as never,
        );
      });
      disposers.push(() => void reg.dispose());
    }
    if (h["tool.execute.after"]) {
      const reg = await ctx.tool.hook("execute.after", async (event) => {
        // V2 hands the tool result as event.result.content (string | Content[]);
        // the V1 after-hook only consumes output.output (the response text).
        const content = (event.status === "completed" ? event.result?.content : undefined) ?? "";
        const output = typeof content === "string"
          ? content
          : content.map((c: { type?: string; text?: string }) => c?.text ?? "").join("\n");
        await h["tool.execute.after"](
          { tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input ?? {} } as never,
          { title: "", output, metadata: {} } as never,
        );
      });
      disposers.push(() => void reg.dispose());
    }

    // ── chat.message → ctx.session.hook("prompt") ────────────────────
    if (h["chat.message"]) {
      const reg = await ctx.session.hook("prompt", async (event) => {
        await h["chat.message"](
          { sessionID: event.sessionID },
          { message: event.prompt, parts: [{ type: "text", text: event.prompt?.text ?? "" }] } as never,
        );
      });
      disposers.push(() => void reg.dispose());
    }

    // ── experimental.chat.system.transform → ctx.session.hook("context") ──
    if (h["experimental.chat.system.transform"]) {
      const reg = await ctx.session.hook("context", async (event) => {
        if (!Array.isArray(event.system)) return;
        const origLen = event.system.length;
        const shadow = shadowSystem(event.system);
        await h["experimental.chat.system.transform"](
          { sessionID: event.sessionID, model: event.model } as never,
          { system: shadow } as never,
        );
        // V2 only persists a whole-array reassignment (in-place edits are dropped).
        if (shadow.length !== origLen) {
          event.system = toParts(shadow) as never;
        }
      });
      disposers.push(() => void reg.dispose());
    }

    // ── experimental.session.compacting → ctx.session.hook("compaction") ──
    if (h["experimental.session.compacting"]) {
      const reg = await ctx.session.hook("compaction", async (event) => {
        const out: { context: string[]; prompt?: string } = { context: [] };
        const snapshot = await h["experimental.session.compacting"](
          { sessionID: event.sessionID }, out as never,
        );
        const summary = typeof snapshot === "string" && snapshot ? snapshot : out.context.join("\n\n");
        // V2: recording result.summary performs the compaction ourselves and skips the model call.
        if (summary) event.result = { summary } as never;
      });
      disposers.push(() => void reg.dispose());
    }

    // ── event → ctx.event.subscribe() ────────────────────────────────
    if (h.event) {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            await h.event({ event: ev } as never);
          }
        } catch {
          // Subscription aborted on cleanup — nothing to do.
        }
      })();
      disposers.push(() => controller.abort());
    }

    return () => {
      for (const d of disposers) {
        try { d(); } catch { /* best effort */ }
      }
    };
  },
});
