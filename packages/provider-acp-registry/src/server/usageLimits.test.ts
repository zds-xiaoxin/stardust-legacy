import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import { isAcpUsageStatsUnsupportedError, parseAcpUsageStatsResponse } from "./usageLimits.ts";

const checkedAt = "2026-11-24T12:00:00.000Z";

describe("isAcpUsageStatsUnsupportedError", () => {
  it("recognizes JSON-RPC -32601 method-not-found errors only", () => {
    expect(
      isAcpUsageStatsUnsupportedError(
        EffectAcpErrors.AcpRequestError.methodNotFound("account/usage_stats"),
      ),
    ).toBe(true);
    expect(
      isAcpUsageStatsUnsupportedError(EffectAcpErrors.AcpRequestError.internalError("boom")),
    ).toBe(false);
    expect(isAcpUsageStatsUnsupportedError(new EffectAcpErrors.AcpInputStreamEndedError({}))).toBe(
      false,
    );
  });
});

describe("parseAcpUsageStatsResponse", () => {
  it("parses Proposal 0002 GLM standard plan windows and plan label", () => {
    const result = parseAcpUsageStatsResponse(
      {
        glm: {
          kind: "success",
          level: "pro",
          items: [
            {
              key: "token_5h",
              label: "5h",
              usedPercent: 18,
              leftPercent: 82,
              nextResetTime: 1795532548054,
            },
            {
              key: "token_week",
              label: "Week",
              usedPercent: 45,
              leftPercent: 55,
              nextResetTime: 1795964548054,
            },
            {
              key: "mcp",
              label: "MCP",
              usedPercent: 10,
              leftPercent: 90,
            },
          ],
        },
        opencode: { kind: "not_configured" },
        ollama: { kind: "not_configured" },
        zcode: { kind: "unavailable" },
      },
      checkedAt,
    );

    expect(result).toEqual({
      status: "supported",
      authLabel: "GLM Coding Plan · Pro",
      usageLimits: {
        checkedAt,
        windows: [
          {
            id: "glm:token_5h",
            kind: "session",
            label: "5-hour",
            usedPercent: 18,
            resetsAt: "2026-11-24T15:02:28.054Z",
            windowDurationMins: 300,
          },
          {
            id: "glm:token_week",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 45,
            resetsAt: "2026-11-29T15:02:28.054Z",
            windowDurationMins: 10_080,
          },
          {
            id: "glm:mcp",
            kind: "other",
            label: "MCP",
            usedPercent: 10,
          },
        ],
      },
    });
  });

  it("disambiguates duplicate GLM credit_limit keys with humanized labels and deterministic ids", () => {
    const result = parseAcpUsageStatsResponse(
      {
        glm: {
          kind: "success",
          level: "lite",
          items: [
            {
              key: "credit_limit",
              label: "CREDIT_LIMIT",
              usedPercent: 2,
              leftPercent: 98,
              usedCount: 222,
              totalCount: 10_000,
              nextResetTime: 1795681623959,
            },
            {
              key: "credit_limit",
              label: "CREDIT_LIMIT",
              usedPercent: 0,
              leftPercent: 100,
              usedCount: 2,
              totalCount: 2_000,
              nextResetTime: 1795532548054,
            },
          ],
        },
        opencode: { kind: "not_configured" },
        ollama: { kind: "not_configured" },
        zcode: { kind: "unavailable" },
      },
      checkedAt,
    );

    expect(result).toEqual({
      status: "supported",
      authLabel: "GLM Coding Plan · Lite",
      usageLimits: {
        checkedAt,
        windows: [
          {
            id: "glm:credit_limit:1",
            kind: "other",
            label: "Credit limit (2,000)",
            usedPercent: 0,
            resetsAt: "2026-11-24T15:02:28.054Z",
          },
          {
            id: "glm:credit_limit:2",
            kind: "other",
            label: "Credit limit (10,000)",
            usedPercent: 2,
            resetsAt: "2026-11-26T08:27:03.959Z",
          },
        ],
      },
    });

    const withoutDistinctCounts = parseAcpUsageStatsResponse(
      {
        glm: {
          kind: "success",
          items: [
            {
              key: "credit_limit",
              label: "CREDIT_LIMIT",
              usedPercent: 15,
              nextResetTime: 1795681623959,
            },
            {
              key: "credit_limit",
              label: "CREDIT_LIMIT",
              usedPercent: 5,
              nextResetTime: 1795532548054,
            },
          ],
        },
      },
      checkedAt,
    );
    expect(withoutDistinctCounts).toMatchObject({
      status: "supported",
      usageLimits: {
        windows: [
          { id: "glm:credit_limit:1", label: "Credit limit 1", usedPercent: 5 },
          { id: "glm:credit_limit:2", label: "Credit limit 2", usedPercent: 15 },
        ],
      },
    });
  });

  it("parses Proposal 0002 opencode, ollama, and zcode sections and prefixes multi-section labels", () => {
    const result = parseAcpUsageStatsResponse(
      {
        glm: { kind: "unavailable" },
        opencode: {
          kind: "success",
          windows: [
            { key: "rolling", label: "5h", usagePercent: 25, resetsAt: 1795532548054 },
            { key: "weekly", label: "Week", usagePercent: 60, resetsAt: 1795964548054 },
          ],
        },
        ollama: {
          kind: "success",
          usage: { plan: "Ollama Cloud Pro", usageUsd: 4.5, window: "30d" },
          windows: [{ key: "monthly", label: "Month", usagePercent: 30 }],
        },
        zcode: {
          kind: "success",
          planId: "zcode-v3-start-plan",
          planName: "ZCODE GLOBAL BUILD",
          windows: [
            {
              key: "ent-1",
              label: "ZCODE GLOBAL BUILD · GLM-5.3-Flash",
              modelIds: ["glm-5.3-flash"],
              usagePercent: 12,
              resetsAt: 1795964548054,
              oneTime: true,
            },
          ],
        },
      },
      checkedAt,
    );

    expect(result).toEqual({
      status: "supported",
      authLabel: "Ollama Cloud Pro",
      usageLimits: {
        checkedAt,
        windows: [
          {
            id: "opencode:rolling",
            kind: "session",
            label: "OpenCode · 5h",
            usedPercent: 25,
            resetsAt: "2026-11-24T15:02:28.054Z",
          },
          {
            id: "opencode:weekly",
            kind: "weekly",
            label: "OpenCode · Week",
            usedPercent: 60,
            resetsAt: "2026-11-29T15:02:28.054Z",
            windowDurationMins: 10_080,
          },
          {
            id: "ollama:monthly",
            kind: "monthly",
            label: "Ollama · Month",
            usedPercent: 30,
          },
          {
            id: "zcode:ent-1",
            kind: "other",
            label: "ZCODE GLOBAL BUILD · GLM-5.3-Flash",
            modelIds: ["glm-5.3-flash"],
            usedPercent: 12,
            resetsAt: "2026-11-29T15:02:28.054Z",
          },
        ],
      },
    });
  });

  it("maps unconfigured vs failing Proposal 0002 responses cleanly", () => {
    expect(
      parseAcpUsageStatsResponse(
        {
          glm: { kind: "not_configured" },
          opencode: { kind: "not_configured" },
          ollama: { kind: "none" },
        },
        checkedAt,
      ),
    ).toEqual({ status: "unsupported" });

    expect(
      parseAcpUsageStatsResponse(
        {
          glm: { kind: "auth_error" },
          opencode: { kind: "not_configured" },
        },
        checkedAt,
      ),
    ).toEqual({
      status: "failed",
      message: "Authentication is required to read ACP usage limits.",
    });

    expect(
      parseAcpUsageStatsResponse(
        {
          glm: { kind: "rate_limited" },
        },
        checkedAt,
      ),
    ).toEqual({
      status: "failed",
      message: "Usage limit request was rate limited by the provider.",
    });
  });

  it("supports generic direct windows payloads and rejects empty or unrelated payloads", () => {
    expect(
      parseAcpUsageStatsResponse(
        {
          plan: "Team Plan",
          windows: [
            {
              id: "daily",
              kind: "session",
              label: "Daily",
              leftPercent: 72,
              resetsAt: "2026-11-25T00:00:00.000Z",
              windowDurationMins: 1_440,
            },
            {
              key: "monthly_cap",
              label: "MONTHLY_CAP",
              usedPercent: 105,
              resetsAt: 1795964548,
              modelIds: ["model-x"],
            },
          ],
        },
        checkedAt,
      ),
    ).toEqual({
      status: "supported",
      authLabel: "Team Plan",
      usageLimits: {
        checkedAt,
        windows: [
          {
            id: "daily",
            kind: "session",
            label: "Daily",
            usedPercent: 28,
            resetsAt: "2026-11-25T00:00:00.000Z",
            windowDurationMins: 1_440,
          },
          {
            id: "monthly_cap",
            kind: "monthly",
            label: "Monthly cap",
            usedPercent: 100,
            resetsAt: "2026-11-29T15:02:28.000Z",
            modelIds: ["model-x"],
          },
        ],
      },
    });

    expect(parseAcpUsageStatsResponse({}, checkedAt)).toEqual({ status: "unsupported" });
    expect(parseAcpUsageStatsResponse(null, checkedAt)).toEqual({ status: "unsupported" });
    expect(parseAcpUsageStatsResponse([], checkedAt)).toEqual({ status: "unsupported" });
    expect(parseAcpUsageStatsResponse({ windows: [] }, checkedAt)).toEqual({
      status: "unsupported",
    });
    expect(parseAcpUsageStatsResponse({ status: "ok" }, checkedAt)).toEqual({
      status: "unsupported",
    });
  });
});
