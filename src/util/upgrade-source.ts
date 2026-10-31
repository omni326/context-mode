// Fork-local patch — single source of truth for where upgrades come from.
//
// Stock behaviour resolves upgrades to the npm package: `ctx_upgrade` and
// `context-mode upgrade` clone mksglu/context-mode, and the outdated-version
// hint says `npm update -g context-mode`. On a fork deployment both are
// destructive: the npm build carries no fork-only code, so one upgrade
// silently removes it (on OpenCode 2 that kills the plugin entry outright —
// V1 plugin implementations do not run in V2).
//
// So the default here is this fork. Set CONTEXT_MODE_UPGRADE_REPO to the
// upstream URL to get stock behaviour back.
// shortcut: the fork publishes no npm package; if it ever does, drop
// isForkSource() from the version checks and keep only the repo override.

const UPSTREAM_REPO = "https://github.com/mksglu/context-mode.git";
const FORK_REPO = "https://github.com/omni326/context-mode.git";

export function upgradeRepo(): string {
  return process.env.CONTEXT_MODE_UPGRADE_REPO?.trim() || FORK_REPO;
}

// True unless pointed back at upstream. npm's `context-mode` dist-tag then says
// nothing about what is installed, so registry version checks and npm-based
// upgrade hints must stay off.
export function isForkSource(): boolean {
  return upgradeRepo() !== UPSTREAM_REPO;
}

// "owner/repo" for log lines and fix hints.
export function upgradeRepoLabel(): string {
  return upgradeRepo().replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
}
