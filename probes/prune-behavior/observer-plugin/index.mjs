// Test observer: records what the OUTGOING request actually looks like, after
// every other `context` hook has had its say. Proves the pruner's placeholder
// reached the model (the persisted DB never shows it).
import { appendFileSync } from "node:fs";

const OUT = process.env.CM_OBSERVE_OUT || "observe.jsonl";

export default {
  id: "cm-observer",
  async setup(ctx) {
    const reg = await ctx.session.hook("context", async (event) => {
      const msgs = Array.isArray(event.messages) ? event.messages : [];
      const raw = JSON.stringify(msgs);
      appendFileSync(
        OUT,
        JSON.stringify({
          sessionID: event.sessionID ?? null,
          nMsg: msgs.length,
          bytes: raw.length,
          // The pruner's exact placeholder shape: "<tool> result pruned (<n>KB, earlier turn)".
          placeholders: (raw.match(/ result pruned \(/g) || []).length,
          hasValue: raw.includes(process.env.CM_VALUE || "__no_value_set__"),
        }) + "\n",
      );
    });
    return () => {
      void reg.dispose();
    };
  },
};
