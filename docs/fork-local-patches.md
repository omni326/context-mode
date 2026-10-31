# Fork-local install patches

This document is specific to **this fork deployment** and is intentionally kept
out of `README.md` — the README stays identical to upstream so it can be PR'd
without carrying fork-specific URLs or machine paths.

The OpenCode 2 plugin support itself (`src/adapters/opencode/plugin-v2.ts`,
subpath export `./plugin-v2`) is clean generic code — see the
"OpenCode 2 (V2 plugin API)" section in README. Upgrade source resolution
(section 1) is also tracked in source. What is left below are edits made to the
**installed package on this machine** only; every `npm pack && npm i -g`
reinstall reverts them, so re-apply after upgrading:

```sh
cd ~/AIM/context-mode && git pull && npm run build
npm pack --pack-destination /tmp && npm i -g /tmp/context-mode-*.tgz --allow-scripts=context-mode,better-sqlite3
# then re-apply patch 2 below
```

Never use `npm update -g context-mode` / `npm install -g context-mode@latest`
here: the npm package is upstream code with none of the fork's work, so it
replaces the fork build and OpenCode 2 loses its plugin entry (V1 plugin
implementations do not run in V2).

## 1. Upgrade endpoint → this fork (in source — no re-apply needed)

`src/util/upgrade-source.ts` is the single source of truth. Default is
`https://github.com/omni326/context-mode.git`, and everything that used to point
back at the npm package now routes through it:

- `cli.ts upgrade()` — the `git clone` (this is the command `ctx_upgrade`
  actually hands the agent, so the tool follows the fork too)
- `server.ts` `ctx_upgrade` inline fallback script — its own `git clone`
- `cli.ts` / `server.ts` `fetchLatestVersion()` — the npm registry is not
  consulted for a fork build, so no "vX outdated → `npm update -g`" nag and
  `doctor` reports the fork as the source instead of comparing against npm
- `util/plugin-cache-integrity.ts` + `scripts/plugin-cache-integrity.mjs` —
  partial-install fix hints say `context-mode upgrade`, not `npm install -g`

`upgrade()` also skips the "Already on latest" shortcut for a fork: the branch
tip moves without a `package.json` version bump, so it always rebuilds and
swaps files. Requires the local work to be **pushed** to `origin`, since the
upgrade path clones the remote rather than reading this working tree.

Override to get stock behaviour back: `CONTEXT_MODE_UPGRADE_REPO=https://github.com/mksglu/context-mode.git`.

## 2. Skill fallback root on OpenCode

The `ctx-doctor` / `ctx-upgrade` skills derive the plugin root by going up two
levels from the skill directory — correct when skills live inside
`node_modules/context-mode/`, but OpenCode loads user-level skills from
`~/.config/opencode/skills/`, so the fallback path (used only when the MCP call
fails) would resolve a wrong root. Name the install directory explicitly:

```sh
P=$(npm root -g)/context-mode
sed -i '' "s|Derive the \*\*plugin root\*\* from this skill's base directory.*|Use plugin root $P,|" "$P/skills/ctx-doctor/SKILL.md" "$P/skills/ctx-upgrade/SKILL.md"
```

## Other local state (not patches)

- OpenCode plugin entry: `~/AIM/plugins/context-mode-v2/` is a two-file wrapper
  directory re-exporting `$P/build/adapters/opencode/plugin-v2.js` (OpenCode
  only loads plugin *directories*, and the package default entry is still V1).
- The 7 standalone skills are symlinked into `~/.config/opencode/skills/`.
