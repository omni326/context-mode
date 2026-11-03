// Phase-0 runtime probe for context-mode fork plan (plan.md 阶段 0).
// Behaviour is selected by P0_MODE (comma list) and results are appended as JSON
// lines to P0_OUT. Verifies: before.input mutability (0.1), after.result
// rewrite (0.2), context.messages rewrite (0.3), system push vs reassign (0.4).
//
// HOW TO RUN — copy this file to a scratch project as .opencode/plugins/p0/index.ts, then:
//   P0_MODE=prune P0_SENTINEL=<token only present in a tool result> \
//   P0_OUT=$PWD/prune.log opencode run --standalone --auto --format json \
//     --model claude-code-router/aim04/qwen3.8-flash-next-q4_k_xl "<prompt that makes the model run the tool>"
//   # continue the same session with --session <ses_...>; grep the id out of --format json output.
// Modes: probe | modify | deny | after | http(useless, body is empty) | syspush |
//        sysassign | msg | prune (erase sentinel from request + deny shell) | prune_inplace
// Persistence check: sqlite3 the V2 db and filter by session_id — parts live in
// session_message.data, the session_part table is empty; never grep the whole db
// (the current session's own text produces false hits).
import { appendFileSync } from "node:fs";

const MODE = process.env.P0_MODE || "";
const OUT = process.env.P0_OUT || "";
const has = (s: string) => MODE.split(",").includes(s);
const log = (o: unknown) => {
  if (!OUT) return;
  try { appendFileSync(OUT, JSON.stringify(o) + "\n"); } catch { /* ignore */ }
};

const ZORP = "ZORPUSH";
const ZORPA = "ZORPASSIGN";
const MSG_TOKEN = "CTX_REWRITTEN_5Z";
const AFTER_TOKEN = "AFTER_REWRITTEN_7Q";

export default {
  id: "p0",
  async setup(ctx: any) {
    log({ ev: "setup", mode: MODE });

    // ── dispatch probe: which hook domains actually fire (P0_MODE=probe) ──
    if (has("probe")) {
      await ctx.tool.hook("execute.before", async (e: any) => {
        log({ ev: "probe.before", tool: e.tool, keys: Object.keys(e ?? {}) });
      });
      await ctx.tool.hook("execute.after", async (e: any) => {
        log({ ev: "probe.after", tool: e.tool, status: e.status, keys: Object.keys(e ?? {}) });
      });
      await ctx.session.hook("context", async (e: any) => {
        log({ ev: "probe.context", msgCount: Array.isArray(e?.messages) ? e.messages.length : null });
      });
    }

    // ── 0.1 before: in-place input mutation + deny-by-throw ──────────
    if (has("modify") || has("deny")) {
      await ctx.tool.hook("execute.before", async (e: any) => {
        const cmd = e?.input?.command;
        log({
          ev: "before",
          tool: e.tool,
          cmd: typeof cmd === "string" ? cmd : null,
          frozen: Object.isFrozen(e?.input ?? {}),
          keys: Object.keys(e?.input ?? {}),
        });
        if (has("deny") && typeof cmd === "string" && cmd.includes("echo denied")) {
          throw new Error("P0_DENY blocked by test plugin");
        }
        if (has("modify") && typeof cmd === "string" && cmd.includes("echo hello")) {
          try {
            e.input.command = "echo MODIFIED_BY_HOOK";
            log({ ev: "modify_inplace", cmd: e.input.command });
          } catch (err) {
            log({ ev: "modify_inplace_threw", msg: String(err) });
          }
        }
      });
    }

    // ── 0.2 after: whole-object result assignment ────────────────────
    if (has("after")) {
      await ctx.tool.hook("execute.after", async (e: any) => {
        log({
          ev: "after",
          tool: e.tool,
          status: e.status,
          resultShape: e.status === "completed"
            ? { keys: Object.keys(e.result ?? {}), json: JSON.stringify(e.result ?? {}).slice(0, 400) }
            : { error: JSON.stringify(e.error ?? {}).slice(0, 300) },
        });
        if (e.status === "completed") {
          e.result = {
            output: AFTER_TOKEN,
            content: [{ type: "text", text: AFTER_TOKEN }],
            metadata: e.result?.metadata ?? {},
          };
          log({ ev: "after_rewritten" });
        }
      });
    }

    // ── wire probe: what actually leaves to the provider (P0_MODE adds http) ──
    if (has("http")) {
      await ctx.session.hook("http.request", async (e: any) => {
        let text = "";
        try { text = typeof e.request?.body === "string" ? e.request.body : JSON.stringify(e.request?.body ?? ""); } catch { /* ignore */ }
        log({
          ev: "http",
          kind: e.kind,
          bytes: text.length,
          hasToken: text.includes(MSG_TOKEN),
          hasHello: text.includes("hello"),
          window: text.includes("tool") ? text.slice(Math.max(0, text.indexOf("\"tool\"") - 80), text.indexOf("\"tool\"") + 500) : null,
        });
      });
    }

    // ── 0.3 prune direction: erase the sentinel from the outgoing request ──
    // The sentinel lives only in the tool result (never in the prompt), so a model
    // that still answers with it is reading un-pruned history. Shell is denied in
    // this mode so the model cannot re-run the command to recover it.
    const SENT = process.env.P0_SENTINEL || "SENTINEL_K7Q";
    if (has("prune") || has("prune_inplace")) {
      await ctx.tool.hook("execute.before", async (e: any) => {
        if (typeof e?.input?.command === "string") throw new Error("P0_PRUNE_DENY: no re-running, answer from history");
      });
      await ctx.session.hook("context", async (e: any) => {
        const msgs = Array.isArray(e.messages) ? e.messages : [];
        const hit = (x: any) => JSON.stringify(x).includes(SENT);
        const scrub = (x: any): any => {
          if (typeof x === "string") return hit(x) ? "[P0_PRUNED]" : x;
          if (Array.isArray(x)) return x.map(scrub);
          if (x && typeof x === "object") { for (const k of Object.keys(x)) x[k] = scrub(x[k]); return x; }
          return x;
        };
        log({ ev: "prune", inplace: has("prune_inplace"), msgCount: msgs.length, hits: msgs.filter(hit).length });
        if (has("prune_inplace")) { msgs.forEach(scrub); }
        else { e.messages = msgs.map((m: any) => (hit(m) ? scrub({ ...m }) : m)); }
      });
    }

    // ── 0.3 / 0.4 context hook ───────────────────────────────────────
    if (has("syspush") || has("sysassign") || has("msg")) {
      await ctx.session.hook("context", async (e: any) => {
        log({
          ev: "context",
          sysLen: Array.isArray(e.system) ? e.system.length : null,
          msgCount: Array.isArray(e.messages) ? e.messages.length : null,
        });

        if (has("syspush")) {
          try {
            e.system.push({ type: "text", text: `Begin your final reply with the exact token ${ZORP} on its own line.` });
            log({ ev: "syspush", len: e.system.length });
          } catch (err) { log({ ev: "syspush_threw", msg: String(err) }); }
        }

        if (has("sysassign")) {
          try {
            e.system = [...(Array.isArray(e.system) ? e.system : []), { type: "text", text: `Begin your final reply with the exact token ${ZORPA} on its own line.` }];
            log({ ev: "sysassign", len: e.system.length });
          } catch (err) { log({ ev: "sysassign_threw", msg: String(err) }); }
        }

        if (has("msg")) {
          log({
            ev: "session",
            sessionID: e.sessionID,
            shape: (Array.isArray(e.messages) ? e.messages : []).map((m: any) => ({
              role: m?.role ?? m?.type ?? null,
              keys: Object.keys(m ?? {}),
              kinds: Array.isArray(m?.content)
                ? m.content.map((c: any) => c?.type ?? typeof c)
                : Array.isArray(m?.parts) ? m.parts.map((p: any) => p?.type ?? typeof p) : null,
            })),
          });
          const hits: string[] = [];
          const replaceIn = (node: any, path: string): any => {
            if (typeof node === "string") {
              if (node.includes("hello")) { hits.push(path); return node.replaceAll("hello", MSG_TOKEN); }
              return node;
            }
            if (Array.isArray(node)) return node.map((x, i) => replaceIn(x, `${path}[${i}]`));
            if (node && typeof node === "object") {
              const out: any = {};
              for (const k of Object.keys(node)) out[k] = replaceIn(node[k], `${path}.${k}`);
              return out;
            }
            return node;
          };
          // Only touch non-user messages so the prompt itself is never rewritten.
          const next = (Array.isArray(e.messages) ? e.messages : []).map((m: any, mi: number) =>
            m?.role === "user" ? m : replaceIn(m, `m${mi}`),
          );
          e.messages = next;
          log({ ev: "msg_rewrite", hits });
        }
      });
    }
  },
};
