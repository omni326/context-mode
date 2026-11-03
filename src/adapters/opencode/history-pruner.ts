/**
 * Virtual pruning of consumed tool results from the OUTGOING model request.
 *
 * Runs in the OpenCode 2 `context` hook, which sees the assembled provider
 * messages immediately before dispatch. Rewriting them changes only what the
 * model is sent — persisted history keeps the raw bytes (probe run 0.3: the
 * pruned placeholder reached the model while `session_message` still carried
 * the original sentinel).
 *
 * Message shapes are what the probe actually observed, not what the session
 * store looks like:
 *   role:"tool"      -> content[i] = { type:"tool-result", id, name,
 *                                      result:{type:"content", value:[{type:"text",text}]} }
 *   role:"assistant" -> content[i] = { type:"tool-call", id, name, input }
 *   role:"system"    -> entries injected by the harness; never touched.
 *
 * Rules (plan.md phase 3): keep the last N pairs, keep everything within
 * `keepTokens` of the tail (opencode compaction keeps 15k, this must not eat
 * that region), require a whole batch worth of savings before starting
 * (Anthropic `clear_at_least`), never prune a result that looks like a failure
 * (stripping error details makes the model assume success), and remember every
 * decision so a re-run reproduces the same bytes instead of un-pruning.
 */

/** ~4 bytes/token is a conservative floor for a byte-based keep window. */
const BYTES_PER_TOKEN = 4;
const PLACEHOLDER_MARK = "context-mode: ";

export interface PruneOpts {
  /** Tool results this close to the tail are never touched. Default 3. */
  keepRecentPairs?: number;
  /** Minimum size of one result before it is worth pruning. Default 4000 B. */
  minBytes?: number;
  /** Only start pruning once a whole batch this large can be reclaimed. Default 20000 B (~5000 tokens). */
  minBatchBytes?: number;
  /** Byte distance from the tail to protect. Default 15000 tokens. */
  keepTokens?: number;
  /** Sticky record of already-pruned call ids; they stay pruned regardless of the batch floor. */
  decided?: Set<string>;
}

export interface PrunedEntry {
  id: string;
  bytes: number;
}

export interface PruneResult {
  messages: unknown[];
  pruned: PrunedEntry[];
  savedBytes: number;
  decided: Set<string>;
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Flattens the visible text of a provider message (tool results included). */
export function textOf(msg: any): string {
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  const out: string[] = [];
  for (const p of parts) {
    if (p?.type === "tool-result") {
      const value = p?.result?.value;
      if (Array.isArray(value)) {
        for (const t of value) if (typeof t?.text === "string") out.push(t.text);
      } else if (typeof value === "string") {
        out.push(value);
      }
    } else if (typeof p?.text === "string") {
      out.push(p.text);
    }
  }
  return out.join("\n");
}

/**
 * A failed shell call still arrives as a plain content result with
 * "Exited with code N" appended, so failure has to be read off the text.
 * Deliberately narrow: matching the word "failed" alone would flag test logs
 * that legitimately report "0 failed".
 */
export function looksFailed(text: string): boolean {
  return (
    /Exited with code [1-9]\d*/.test(text) ||
    /^\s*(Error|✗)/.test(text) ||
    /Traceback \(most recent call last\)/.test(text)
  );
}

/** The tool-call input paired with a result id — the cheapest thing to point at. */
function pairedInput(messages: any[], id: string): unknown {
  for (const m of messages) {
    for (const p of Array.isArray(m?.content) ? m.content : []) {
      if (p?.type === "tool-call" && p?.id === id) return p.input;
    }
  }
  return undefined;
}

function placeholderFor(name: string, bytes: number, input: unknown): string {
  const kb = Math.max(1, Math.round(bytes / 1024));
  const args = input === undefined ? "" : JSON.stringify(input).slice(0, 200);
  if (/read/i.test(name) && args) {
    return `${PLACEHOLDER_MARK}${name} result pruned (${kb}KB, earlier turn). Input: ${args}. Re-run the tool if you still need it.`;
  }
  return (
    `${PLACEHOLDER_MARK}${name} result pruned (${kb}KB, earlier turn). Input: ${args}. ` +
    `Recall it with tools["context-mode"]["ctx_search"](queries: [...]) if it was indexed.`
  );
}

export function pruneToolResults(messages: any[], opts: PruneOpts = {}): PruneResult {
  const keepPairs = opts.keepRecentPairs ?? 3;
  const minBytes = opts.minBytes ?? 4000;
  const minBatchBytes = opts.minBatchBytes ?? 20_000;
  const keepBytes = (opts.keepTokens ?? 15_000) * BYTES_PER_TOKEN;
  const decided = opts.decided;

  // Walk from the tail: rank counts tool results seen so far, bytesFromEnd is
  // the distance to the tail (what the KV-cache still has warm).
  let rank = 0;
  let bytesFromEnd = 0;
  const candidates: Array<{ mi: number; pi: number; id: string; name: string; bytes: number; sticky: boolean }> = [];

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      if (p?.type !== "tool-result") continue;
      const id = String(p?.id ?? `${mi}:${pi}`);
      const text = textOf({ content: [p] });
      const bytes = byteLen(text);
      const sticky = decided?.has(id) ?? false;
      if (
        rank >= keepPairs &&
        bytesFromEnd >= keepBytes &&
        !text.startsWith(PLACEHOLDER_MARK) &&
        (sticky || (bytes >= minBytes && !looksFailed(text)))
      ) {
        candidates.push({ mi, pi, id, name: String(p?.name ?? "tool"), bytes, sticky });
      }
      rank++;
    }
    bytesFromEnd += byteLen(textOf(msg));
  }

  // Sticky decisions always re-apply; discretionary ones need to pay for the
  // invalidated cache prefix (Anthropic clear_at_least).
  const sticky = candidates.filter((c) => c.sticky);
  const discretionary = candidates.filter((c) => !c.sticky);
  const savings = (list: typeof candidates) => list.reduce((n, c) => n + c.bytes, 0);
  const chosen = savings(discretionary) + savings(sticky) >= minBatchBytes ? candidates : sticky;

  if (chosen.length === 0) {
    return { messages: [...messages], pruned: [], savedBytes: 0, decided: new Set(decided ?? []) };
  }

  const byMessage = new Map<number, typeof chosen>();
  for (const c of chosen) {
    const list = byMessage.get(c.mi) ?? [];
    list.push(c);
    byMessage.set(c.mi, list);
  }

  let savedBytes = 0;
  const pruned: PrunedEntry[] = [];
  const next = messages.map((msg, mi) => {
    const hits = byMessage.get(mi);
    if (!hits) return msg;
    const content = (Array.isArray(msg?.content) ? msg.content : []).map((p: any, pi: number) => {
      const hit = hits.find((h) => h.pi === pi);
      if (!hit) return p;
      savedBytes += hit.bytes;
      pruned.push({ id: hit.id, bytes: hit.bytes });
      const text = placeholderFor(hit.name, hit.bytes, pairedInput(messages, hit.id));
      savedBytes -= byteLen(text);
      return { ...p, result: { ...p.result, value: [{ type: "text", text }] } };
    });
    return { ...msg, content };
  });

  return { messages: next, pruned, savedBytes, decided: new Set([...(decided ?? []), ...pruned.map((p) => p.id)]) };
}
