/**
 * Secret redaction at the store boundary.
 *
 * Two layers, both needed: maskSecrets() catches the credential shapes, and
 * ContentStore.index() must actually call it — everything indexed is replayable
 * to the model through ctx_search, so a missed call site is a leak.
 */

import { describe, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { maskSecrets } from "../../src/security.js";
import { ContentStore } from "../../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function createStore(): ContentStore {
  return new ContentStore(
    join(tmpdir(), `context-mode-mask-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
  );
}

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const LLM_KEY = `sk-proj-${"b".repeat(24)}`;

describe("maskSecrets", () => {
  test("redacts known credential shapes", () => {
    const out = maskSecrets(`token=${GITHUB_TOKEN} aws=${AWS_KEY} llm=${LLM_KEY}`);
    assert.ok(!out.includes(GITHUB_TOKEN), "github token survived");
    assert.ok(!out.includes(AWS_KEY), "aws key survived");
    assert.ok(!out.includes(LLM_KEY), "llm key survived");
    assert.ok(out.includes("[REDACTED:github-token]"), "missing explicit marker");
  });

  test("redacts generic key=value and keeps the key name visible", () => {
    const out = maskSecrets('password: "Sup3rS3cretValue!" api_key = verylongvalue1234');
    assert.ok(!out.includes("Sup3rS3cretValue"), "password value survived");
    assert.ok(!out.includes("verylongvalue1234"), "api_key value survived");
    assert.match(out, /password\s*=\[REDACTED\]/);
    assert.match(out, /api_key\s*=\[REDACTED\]/);
  });

  test("leaves benign log text alone", () => {
    const benign =
      "FAIL src/auth.test.ts (0.4s)\n  expected token refresh to succeed in 5000ms\n  password field is required";
    assert.equal(maskSecrets(benign), benign);
  });

  test("is idempotent — markers never re-match", () => {
    const once = maskSecrets(`secret = ${GITHUB_TOKEN}`);
    assert.equal(maskSecrets(once), once);
  });
});

describe("ContentStore.index redaction", () => {
  test("indexed content never carries the secret, marker is searchable instead", () => {
    const store = createStore();
    const secret = "hunter2hunter2hunter2";
    const indexed = store.index({
      content: `# Deploy log\nExporting GITHUB_TOKEN: ${GITHUB_TOKEN}\npassword: ${secret}\n`,
      source: "mask-test",
    });
    assert.ok(indexed.totalChunks > 0, "nothing was indexed");

    const hits = store.search("Deploy", 5, "mask-test");
    const all = hits.map((h) => h.content).join("\n");
    assert.ok(all.includes("[REDACTED:github-token]"), "marker missing from stored chunk");
    assert.ok(!all.includes(GITHUB_TOKEN), "secret reachable through search");
    assert.ok(!all.includes(secret), "generic secret reachable through search");
    store.close();
  });

  test("file-backed staleness hash stays the RAW file hash", () => {
    // #refreshStaleSources() re-hashes the file on disk and compares. Hashing the
    // redacted text instead would mark every secret-bearing file stale forever.
    const file = join(__dirname, "fixtures-mask-secret.txt");
    const raw = `# config\napi_key: ${GITHUB_TOKEN}\n`;
    writeFileSync(file, raw);
    const store = createStore();
    store.index({ path: file });
    const meta = store.getSourceMeta(file);
    assert.equal(meta?.contentHash, createHash("sha256").update(raw).digest("hex"));
    const chunk = store.search("config", 5, file, "OR")[0]?.content ?? "";
    assert.ok(chunk.includes("[REDACTED"), `stored chunk must be redacted, got: ${JSON.stringify(chunk)}`);
    assert.ok(!chunk.includes(GITHUB_TOKEN), "secret must not be stored");
    unlinkSync(file);
    store.close();
  });
});
