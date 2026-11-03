#!/bin/sh
# Behavioural test for CONTEXT_MODE_PRUNE_STALE (plan.md item 12).
#
# Question (the index-side recall probe cannot answer it): when a consumed tool
# result has been replaced IN THE OUTGOING REQUEST by a one-line pointer, does
# the model actually follow the pointer and get the bytes back?
#
# Fixture (identical script, two arms, same model):
#   T1 read ledger.txt (400 lines, ~28KB). Line 137 carries `FLUSH-7731 = <hex>`,
#      drawn by gen-ledger.js before the run. The value exists ONLY in the file
#      and in T1's read result.
#   T2 three small shell results -> give the read result rank >= keepRecentPairs.
#   T3 cat fill.txt (~87KB native shell result, never prunable) -> pushes the
#      read result past the 15k-token keep window.
#   T4 ask for the value.
#
# Verdict, arm ON (all must hold): T4's FIRST request shows placeholders > 0
# (pointer reached the model) and hasValue = false (bytes left the request);
# the answer still contains the exact hex (it came back); T4 issued a recovery
# tool call. Arm OFF is the control: placeholders == 0, hasValue = true, answer
# correct from context — i.e. the fixture really does put the value in context.
#
# HOW TO RUN
#   sh probes/prune-behavior/run-arm.sh on  ses_<id>      # pruner enabled
#   sh probes/prune-behavior/run-arm.sh off ses_<id>      # control
#   (needs a real model; each arm = 4 `opencode run --standalone` turns)
# The observer plugin (observer-plugin/) is loaded by a project opencode.json
# in this directory and records every OUTGOING request. V2 loads plugin
# entries as DIRECTORIES and the module must `export default {id, setup}` —
# a plain function export is rejected ("Plugin must export a default
# definition with an id and an effect or setup function").
#
# RESULT (2026-11-04, opencode v2.2.5, fork @ df5ffe29) — PASSED, arm ON:
#   T4 request #1: placeholders=1, hasValue=false (28KB read result replaced by
#   the pointer; the value was NOT in the request) and the answer was still the
#   exact hex — recovered in-turn via `grep -n 'FLUSH-7731' ledger.txt`, i.e.
#   the model followed the pointer's path. Its own words: "我上下文里那次
#   read ledger.txt 的原文已不在（工具回的是一个对象占位，400 行正文没进上下文），
#   所以这是从文件恢复的，不是凭记忆".
#   Arm OFF control: placeholders=0 in all 8 requests, hasValue=true from T1 on.
#   SIDE FINDING (host shape, not a pruner bug): on OpenCode V2 an MCP call is
#   persisted as tool `execute`, never as `ctx_search`, so the pruner's
#   store-backed `ctx_*` branch is inert on this host — only `read`-like
#   results are prunable here. `execute` results are deliberately NOT in the
#   whitelist: their stdout is not indexed into the content store, so pointing
#   at ctx_search for them would be data loss wearing a pointer.
set -u
D="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$D" || exit 1
ARM="$1"; SESS="$2"
OBS="$D/observe-$ARM.jsonl"; LOG="$D/turn-$ARM.log"
export CM_OBSERVE_OUT="$OBS"
if [ "$ARM" = "on" ]; then export CONTEXT_MODE_PRUNE_STALE=1; else unset CONTEXT_MODE_PRUNE_STALE; fi
: > "$OBS"; : > "$LOG"

# 87KB of noise: the native shell result that pushes the read result past the
# 15k-token keep window. Committed as nothing; regenerated here.
[ -s "$D/fill.txt" ] || node -e 'const c=require("crypto");let s="";for(let i=0;i<1600;i++)s+="fill row "+i+" "+c.randomBytes(20).toString("hex")+"\n";require("fs").writeFileSync(process.argv[1],s)' "$D/fill.txt"

export CM_VALUE=$(node "$D/gen-ledger.js")
echo "VALUE=$CM_VALUE" | tee -a "$LOG"

run() { # run <turn> ; prompt read from prompt-<turn>.txt
  echo "### $1" >> "$LOG"
  opencode run --standalone --auto --session "$SESS" "$(cat "$D/prompt-$1.txt")" >> "$LOG" 2>&1
  echo "  [observer after $1] $(tail -1 "$OBS")" >> "$LOG"
}

run T1; run T2; run T3; run T4

echo "--- observer ($ARM) ---"; cat "$OBS"
echo "--- T4 recovery evidence ($ARM) ---"
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.local/share/opencode/opencode.db",{readOnly:true});
const rows=db.prepare("select data from session_message where session_id = ? order by rowid").all(process.argv[1]);
// last user turn = the T4 question; everything after it is T4 behaviour.
let lastUser=-1;
rows.forEach((r,i)=>{const d=JSON.parse(r.data); if(d.text!==undefined && d.agent===undefined && d.outcome===undefined && d.description===undefined) lastUser=i;});
for(const r of rows.slice(lastUser+1)){
  const d=JSON.parse(r.data);
  for(const p of (Array.isArray(d.content)?d.content:[])){
    if(p.type==="tool") console.log("TOOL "+p.tool+" "+JSON.stringify(p.state?.input??p.input??{}).slice(0,160));
    if(p.type==="text"&&d.agent) console.log("TEXT "+String(p.text).replace(/\s+/g," ").slice(0,220));
  }
}
' "$SESS" | tail -12
echo "VALUE=$CM_VALUE"
