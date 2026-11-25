import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { collectLimitAccounts, collectLimitPools, limitPoolId } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_QUOTA_PREFERENCES,
  quotaAccounts,
  createQuotaAccountsSelector,
  quotaPins,
  quotaShownIds,
  quotaState,
  quotaWindow,
  sortQuotaAccounts,
} from "./quotaTopbarModel";

const now = Date.parse("2026-10-24T12:00:00Z");
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "private@example.invalid" },
    checkedAt: new Date(now).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: new Date(now).toISOString(),
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "5h",
          usedPercent: 28,
          resetsAt: new Date(now + 3600000).toISOString(),
          windowDurationMins: 300,
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Week",
          usedPercent: 38,
          resetsAt: new Date(now + 86400000).toISOString(),
        },
      ],
    },
    ...overrides,
  };
}
function present(providers: readonly ServerProvider[], phase = "connected", environment = "env") {
  return new Map([
    [
      EnvironmentId.make(environment),
      { entry: { target: { label: "Test" } }, connection: { phase }, serverConfig: { providers } },
    ],
  ]);
}
describe("quota topbar data", () => {
  it("ignores provider probes/catalogs but refreshes quota, account and connection changes", () => {
    const select = createQuotaAccountsSelector();
    const original = provider();
    const first = select(present([original]));
    expect(select(present([{ ...original, checkedAt: "2026-10-24T13:00:00Z", models: [] }]))).toBe(
      first,
    );
    const limits = { ...original.usageLimits!, windows: [] };
    const changed = select(present([{ ...original, usageLimits: limits }]));
    expect(changed).not.toBe(first);
    expect(changed[0]!.limits).toBe(limits);
    const renamed = select(present([{ ...original, displayName: "Other" }]));
    expect(renamed[0]!.alias).toContain("Other");
    const disconnected = select(present([original], "disconnected"));
    expect(disconnected[0]!.connected).toBe(false);
    const unavailable = select(present([{ ...original, availability: "unavailable" }]));
    expect(unavailable).not.toBe(first);
    expect(select(present([]))).toEqual([]);
    expect(select(new Map())).toEqual([]);
  });
  it("does not hide an unreadable workspace behind another workspace on the same email", () => {
    const accounts = quotaAccounts(
      present([
        provider({
          instanceId: ProviderInstanceId.make("one"),
          auth: { status: "authenticated", email: "same@example.invalid", workspaceId: "one" },
        }),
        provider({
          instanceId: ProviderInstanceId.make("two"),
          auth: { status: "authenticated", email: "same@example.invalid", workspaceId: "two" },
          usageLimits: undefined,
        }),
      ]),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.filter((a) => !a.limits)).toHaveLength(1);
  });
  it("merges the same subscription across environments without exposing account identifiers", () => {
    const accounts = quotaAccounts(
      new Map([
        ...present([provider()], "connected", "a"),
        ...present([provider()], "connected", "b"),
      ]),
    );
    expect(accounts).toHaveLength(1);
    expect(JSON.stringify(accounts)).not.toContain("private@example.invalid");
    expect(quotaPins(DEFAULT_QUOTA_PREFERENCES, accounts)).toEqual([accounts[0]!.id]);
  });
  it("keeps separate accounts and workspaces", () => {
    const accounts = quotaAccounts(
      present([
        provider({
          instanceId: ProviderInstanceId.make("one"),
          auth: { status: "authenticated", email: "same@example.invalid", workspaceId: "one" },
        }),
        provider({
          instanceId: ProviderInstanceId.make("two"),
          auth: { status: "authenticated", email: "same@example.invalid", workspaceId: "two" },
        }),
      ]),
    );
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((a) => a.id)).size).toBe(2);
  });
  it("preserves selected windows and never silently substitutes a missing window", () => {
    const a = quotaAccounts(present([provider()]))[0]!;
    expect(quotaWindow(a, DEFAULT_QUOTA_PREFERENCES)?.kind).toBe("weekly");
    expect(
      quotaWindow(a, { ...DEFAULT_QUOTA_PREFERENCES, windows: { [a.id]: "session:primary" } })
        ?.usedPercent,
    ).toBe(28);
    expect(
      quotaWindow(a, { ...DEFAULT_QUOTA_PREFERENCES, windows: { [a.id]: "weekly:removed" } }),
    ).toBeNull();
  });
  it("keeps cached windows after probe failure, but clears unsupported quotas", () => {
    const base = provider();
    const a = quotaAccounts(
      present([
        { ...base, usageLimits: { ...base.usageLimits!, unavailable: { reason: "probeFailed" } } },
      ]),
    )[0]!;
    expect(a.failed).toBe(true);
    expect(quotaState(a, quotaWindow(a, DEFAULT_QUOTA_PREFERENCES), now)).toEqual({
      remaining: 62,
      state: "stale",
    });
    const unsupported = quotaAccounts(
      present([
        { ...base, usageLimits: { ...base.usageLimits!, unavailable: { reason: "unsupported" } } },
      ]),
    )[0]!;
    expect(
      quotaState(unsupported, quotaWindow(unsupported, DEFAULT_QUOTA_PREFERENCES), now),
    ).toEqual({ remaining: null, state: "unknown" });
  });
  it("labels offline and old snapshots without inventing a balance", () => {
    const a = quotaAccounts(present([provider()], "disconnected"))[0]!;
    expect(quotaState(a, quotaWindow(a, DEFAULT_QUOTA_PREFERENCES), now).state).toBe("stale");
    const live = { ...a, connected: true };
    // The top bar refreshes every 10 minutes while visible, so readings stay current for 30.
    expect(quotaState(live, quotaWindow(live, DEFAULT_QUOTA_PREFERENCES), now + 660000).state).toBe(
      "current",
    );
    expect(
      quotaState(live, quotaWindow(live, DEFAULT_QUOTA_PREFERENCES), now + 31 * 60_000).state,
    ).toBe("stale");
  });
  it("keeps expired values marked refresh-due instead of resetting to 100", () => {
    const a = quotaAccounts(present([provider()]))[0]!;
    const w = {
      ...quotaWindow(a, DEFAULT_QUOTA_PREFERENCES)!,
      resetsAt: new Date(now - 1).toISOString(),
    };
    expect(quotaState(a, w, now)).toEqual({ remaining: 62, state: "reset" });
  });
  it("keeps explicit empty pins and does not replace a temporarily missing pinned account", () => {
    const a = quotaAccounts(present([provider()]));
    expect(quotaPins({ ...DEFAULT_QUOTA_PREFERENCES, pinsEdited: true, pins: [] }, a)).toEqual([]);
    expect(
      quotaPins(
        {
          ...DEFAULT_QUOTA_PREFERENCES,
          pinsEdited: true,
          pins: ["gone", "gone", "a", "b", "c", "d"],
        },
        a,
      ),
    ).toEqual(["gone", "a", "b", "c"]);
  });
  it("includes unreadable enabled channels and excludes disabled ones", () => {
    const accounts = quotaAccounts(
      present([
        provider({ usageLimits: undefined }),
        provider({ instanceId: ProviderInstanceId.make("disabled"), enabled: false }),
      ]),
    );
    expect(accounts).toHaveLength(1);
    expect(quotaState(accounts[0]!, null, now)).toEqual({ remaining: null, state: "unknown" });
  });
  it("recomputes legacy automatic pins when another provider appears", () => {
    const accounts = quotaAccounts(present([provider()]));
    const base = accounts[0]!;
    const antigravity = {
      ...base,
      id: "new-google",
      driver: ProviderDriverKind.make("antigravity"),
    };
    const legacy = { ...DEFAULT_QUOTA_PREFERENCES, pins: [base.id], showNames: false };
    expect(quotaPins(legacy, [...accounts, antigravity])).toContain("new-google");
    expect(quotaPins({ ...legacy, pinsEdited: true }, [...accounts, antigravity])).toEqual([
      base.id,
    ]);
  });
  describe("two logins of one driver", () => {
    const claude = (instance: string, email: string, displayName?: string) =>
      provider({
        instanceId: ProviderInstanceId.make(instance),
        driver: ProviderDriverKind.make("claudeAgent"),
        auth: { status: "authenticated", email },
        ...(displayName ? { displayName } : {}),
      });
    const two = present([
      claude("claude-pro2", "a@example.invalid", "Claude 小号 Pro"),
      claude("claude-pro3", "b@example.invalid", "Claude 小号 3"),
    ]);

    it("titles each login by its instance name, and a lone login by its driver", () => {
      const accounts = quotaAccounts(two);
      expect(accounts.map((a) => a.title)).toEqual(["Claude 小号 Pro", "Claude 小号 3"]);
      expect(accounts.map((a) => a.label)).toEqual(["Claude", "Claude"]);
      expect(
        quotaAccounts(present([claude("claude-pro2", "a@example.invalid", "Mine")]))[0]!.title,
      ).toBe("Claude");
      const unnamed = quotaAccounts(
        present([claude("one", "a@example.invalid"), claude("two", "b@example.invalid", "Claude")]),
      );
      expect(unnamed.map((a) => a.title)).toEqual(["Claude 1", "Claude 2"]);
    });

    it("follows the open thread's login, only while it has quota and the setting is on", () => {
      const accounts = quotaAccounts(two);
      const [pro2, pro3] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
      const pinned = { ...DEFAULT_QUOTA_PREFERENCES, pinsEdited: true, pins: [pro2.id] };
      const on = (instanceId: string) => ({ environmentId: "env", instanceId });
      expect(quotaShownIds(pinned, accounts, on("claude-pro3"))).toEqual({
        ids: [pro3.id, pro2.id],
        followedId: pro3.id,
      });
      expect(quotaShownIds(pinned, accounts, on("claude-pro2"))).toEqual({
        ids: [pro2.id],
        followedId: pro2.id,
      });
      for (const current of [
        null,
        on("unknown"),
        { environmentId: "other", instanceId: "claude-pro3" },
      ])
        expect(quotaShownIds(pinned, accounts, current)).toEqual({
          ids: [pro2.id],
          followedId: null,
        });
      expect(
        quotaShownIds({ ...pinned, followSession: false }, accounts, on("claude-pro3")).followedId,
      ).toBeNull();
      const noQuota = quotaAccounts(
        present([
          claude("claude-pro2", "a@example.invalid"),
          { ...claude("claude-pro3", "b@example.invalid"), usageLimits: undefined },
        ]),
      );
      expect(quotaShownIds(pinned, noQuota, on("claude-pro3")).followedId).toBeNull();
    });

    it("gives each Claude login its own limits card instead of one averaged pool", () => {
      const accounts = collectLimitAccounts(two);
      const pooled = collectLimitPools(accounts, now);
      expect(pooled).toHaveLength(1);
      expect(pooled[0]!.accounts).toHaveLength(2);
      const separate = collectLimitPools(accounts, now, {
        separateDrivers: [ProviderDriverKind.make("claudeAgent")],
      });
      expect(
        separate.flatMap((pool) => pool.accounts.map((a) => a.displayName)).toSorted(),
      ).toEqual(["Claude 小号 3", "Claude 小号 Pro"]);
      expect(separate.every((pool) => pool.accounts.length === 1)).toBe(true);
      expect(new Set(separate.map(limitPoolId)).size).toBe(2);
      const lone = collectLimitPools(
        collectLimitAccounts(present([claude("a", "a@example.invalid")])),
        now,
        {
          separateDrivers: [ProviderDriverKind.make("claudeAgent")],
        },
      );
      expect(lone.map(limitPoolId)).toEqual(["claudeAgent"]);
    });

    it("gives each acpRegistry agent its own limits card instead of averaging", () => {
      const zcode = provider({
        instanceId: ProviderInstanceId.make("acpRegistry_zcode"),
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: "ZCode",
        auth: { status: "unknown" },
      });
      const kimi = provider({
        instanceId: ProviderInstanceId.make("acpRegistry_kimi"),
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: "Kimi",
        auth: { status: "unknown" },
      });
      const accounts = collectLimitAccounts(
        new Map([
          [
            EnvironmentId.make("env"),
            { entry: { target: { label: "Test" } }, serverConfig: { providers: [zcode, kimi] } },
          ],
        ]),
      );
      const separate = collectLimitPools(accounts, now, {
        separateDrivers: [ProviderDriverKind.make("acpRegistry")],
      });
      expect(separate.map((pool) => pool.accounts[0]?.displayName)).toEqual(["Kimi", "ZCode"]);
      expect(new Set(separate.map(limitPoolId)).size).toBe(2);
    });
  });
});

describe("quota topbar order", () => {
  it("puts the open thread's account first, then the most remaining quota, unreadable last", () => {
    const base = quotaAccounts(present([provider()]))[0]!;
    const withUsed = (id: string, used: number | null) => ({
      ...base,
      id,
      limits: {
        ...base.limits!,
        windows:
          used === null ? [] : base.limits!.windows.map((w) => ({ ...w, usedPercent: used })),
      },
    });
    const accounts = [withUsed("a", 90), withUsed("b", 20), withUsed("c", null), withUsed("d", 50)];
    const order = (followed: string | null) =>
      sortQuotaAccounts(accounts, DEFAULT_QUOTA_PREFERENCES, now, followed).map((a) => a.id);
    expect(order(null)).toEqual(["b", "d", "a", "c"]);
    expect(order("a")).toEqual(["a", "b", "d", "c"]);
  });
});
