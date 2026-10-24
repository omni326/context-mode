# Fork-local install patches

This document is specific to **this fork deployment** and is intentionally kept
out of `README.md` — the README stays identical to upstream so it can be PR'd
without carrying fork-specific URLs or machine paths.

The OpenCode 2 plugin support itself (`src/adapters/opencode/plugin-v2.ts`,
subpath export `./plugin-v2`) is clean generic code — see the
"OpenCode 2 (V2 plugin API)" section in README. What follows are edits made to
the **installed package on this machine** only; every `npm pack && npm i -g`
reinstall reverts them, so re-apply after upgrading:

```sh
cd ~/AIM/context-mode && git pull && npm run build
npm pack --pack-destination /tmp && npm i -g /tmp/context-mode-*.tgz --allow-scripts=context-mode,better-sqlite3
# then re-apply the two patches below
```

## 1. Upgrade endpoint → this fork

The `ctx_upgrade` MCP tool (and the `ctx-upgrade` skill) return an upgrade
command that clones `https://github.com/mksglu/context-mode.git`, which would
silently replace the fork build with upstream:

```sh
P=$(npm root -g)/context-mode
sed -i '' 's|https://github.com/mksglu/context-mode.git|https://github.com/omni326/context-mode.git|g' "$P/server.bundle.mjs"
```

(Upstreamable shape, if ever desired: make the upgrade repo a config/env
override such as `CONTEXT_MODE_UPGRADE_REPO`, defaulting to upstream.)

## 2. Skill fallback root on OpenCode

The `ctx-doctor` / `ctx-upgrade` skills derive the plugin root by going up two
levels from the skill directory — correct when skills live inside
`node_modules/context-mode/`, but OpenCode loads user-level skills from
`~/.config/opencode/skills/`, so the fallback path (used only when the MCP call
fails) would resolve a wrong root. Name the install directory explicitly:

```sh
sed -i '' "s|Derive the \*\*plugin root\*\* from this skill's base directory.*|Use plugin root $P,|" "$P/skills/ctx-doctor/SKILL.md" "$P/skills/ctx-upgrade/SKILL.md"
```

## Other local state (not patches)

- OpenCode plugin entry: `~/AIM/plugins/context-mode-v2/` is a two-file wrapper
  directory re-exporting `$P/build/adapters/opencode/plugin-v2.js` (OpenCode
  only loads plugin *directories*, and the package default entry is still V1).
- The 7 standalone skills are symlinked into `~/.config/opencode/skills/`.
