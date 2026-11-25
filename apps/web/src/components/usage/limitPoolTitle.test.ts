import { ProviderDriverKind } from "@t3tools/contracts";
import type { LimitAccount, LimitPool } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { limitPoolTitles } from "./limitPoolTitle";

function pool(overrides: Partial<LimitPool> & { readonly displayName?: string | null }): LimitPool {
  const driver = overrides.driver ?? ProviderDriverKind.make("acpRegistry");
  const account = {
    key: overrides.id ?? "env:instance",
    driver,
    displayName: overrides.displayName ?? null,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: "2026-11-24T12:00:00.000Z", windows: [] },
  } satisfies LimitAccount;
  return {
    driver,
    ...(overrides.id === undefined ? {} : { id: overrides.id }),
    accounts: overrides.accounts ?? [account],
    windows: [],
  };
}

describe("limitPoolTitles", () => {
  it("titles single and multiple acpRegistry pools by displayName with fallback", () => {
    const titles = limitPoolTitles([
      pool({ displayName: "ZCode" }),
      pool({ id: "acpRegistry:kimi", displayName: "Kimi" }),
      pool({ id: "acpRegistry:unnamed", displayName: null }),
    ]);

    expect(titles.get("acpRegistry")).toBe("ZCode");
    expect(titles.get("acpRegistry:kimi")).toBe("Kimi");
    expect(titles.get("acpRegistry:unnamed")).toBe("ACP Registry 2");
  });
});
