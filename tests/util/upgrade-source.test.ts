import { afterEach, describe, expect, it } from "vitest";
import {
  isForkSource,
  upgradeRepo,
  upgradeRepoLabel,
} from "../../src/util/upgrade-source.js";

const saved = process.env.CONTEXT_MODE_UPGRADE_REPO;

afterEach(() => {
  if (saved === undefined) delete process.env.CONTEXT_MODE_UPGRADE_REPO;
  else process.env.CONTEXT_MODE_UPGRADE_REPO = saved;
});

describe("upgrade-source", () => {
  it("defaults to this fork, never the npm package", () => {
    delete process.env.CONTEXT_MODE_UPGRADE_REPO;
    expect(upgradeRepo()).toBe("https://github.com/omni326/context-mode.git");
    expect(isForkSource()).toBe(true);
    expect(upgradeRepoLabel()).toBe("omni326/context-mode");
  });

  it("overriding back to upstream restores stock behaviour", () => {
    process.env.CONTEXT_MODE_UPGRADE_REPO =
      "https://github.com/mksglu/context-mode.git";
    expect(isForkSource()).toBe(false);
    expect(upgradeRepoLabel()).toBe("mksglu/context-mode");
  });

  it("ssh-style override still labels as owner/repo", () => {
    process.env.CONTEXT_MODE_UPGRADE_REPO =
      "git@github.com:omni326/context-mode.git";
    expect(upgradeRepoLabel()).toBe("omni326/context-mode");
    expect(isForkSource()).toBe(true);
  });

  it("blank override falls back to the fork instead of an empty clone URL", () => {
    process.env.CONTEXT_MODE_UPGRADE_REPO = "   ";
    expect(upgradeRepo()).toBe("https://github.com/omni326/context-mode.git");
  });
});
