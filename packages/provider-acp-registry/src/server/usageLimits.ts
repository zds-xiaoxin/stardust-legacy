import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as EffectAcpErrors from "effect-acp/errors";

import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

export const ACP_ACCOUNT_USAGE_STATS_METHOD = "account/usage_stats";

const WEEKLY_DURATION_MINS = 7 * 24 * 60;
const SESSION_5H_DURATION_MINS = 5 * 60;
const PRESERVED_ACRONYMS = new Set(["MCP", "API", "USD", "TPM", "RPM"]);
const FAILURE_SECTION_KINDS = new Set(["auth_error", "rate_limited", "unavailable"]);
const PROPOSAL_SECTION_KEYS = ["glm", "opencode", "ollama", "zcode"] as const;

export type AcpUsageStatsParseResult =
  | {
      readonly status: "supported";
      readonly usageLimits: ServerProviderUsageLimits;
      readonly authLabel?: string;
    }
  | { readonly status: "unsupported" }
  | { readonly status: "failed"; readonly message?: string };

export function isAcpUsageStatsUnsupportedError(error: EffectAcpErrors.AcpError): boolean {
  return error._tag === "AcpRequestError" && error.code === -32601;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => trimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return items.length > 0 ? items : undefined;
}

function capitalizeWord(word: string): string {
  if (word.length === 0) return word;
  return `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function humanizeLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Quota";
  if (/^[A-Z0-9_]+$/u.test(trimmed) && /[A-Z]{2,}/u.test(trimmed)) {
    const parts = trimmed.split("_").filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts
        .map((part, index) => {
          if (PRESERVED_ACRONYMS.has(part)) return part;
          return index === 0 ? capitalizeWord(part) : part.toLowerCase();
        })
        .join(" ");
    }
  }
  return trimmed;
}

function sanitizeKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "_");
  return normalized.length > 0 ? normalized : "window";
}

function parseIsoOrEpochResetsAt(value: unknown): string | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined && numeric > 0) {
    // Support both epoch ms (Proposal 0002) and epoch seconds in generic payloads.
    const epochMs = numeric >= 1e11 ? numeric : numeric >= 1e9 ? numeric * 1000 : Number.NaN;
    if (!Number.isFinite(epochMs)) return undefined;
    const parsed = DateTime.make(epochMs);
    return parsed._tag === "Some" ? DateTime.formatIso(parsed.value) : undefined;
  }
  const text = trimmedString(value);
  if (text === undefined) return undefined;
  const parsed = DateTime.make(text);
  return parsed._tag === "Some" ? DateTime.formatIso(parsed.value) : undefined;
}

function parseWindowKind(value: unknown): ServerProviderUsageWindow["kind"] | undefined {
  if (value === "session" || value === "weekly" || value === "monthly" || value === "other") {
    return value;
  }
  return undefined;
}

function inferWindowKind(hint: string): ServerProviderUsageWindow["kind"] {
  const normalized = hint.toLowerCase();
  if (
    normalized === "token_5h" ||
    normalized === "rolling" ||
    normalized === "session" ||
    /(?:^|[_:\s-])(?:5h|hour|rolling|session|daily)(?:$|[_:\s-])/u.test(normalized)
  ) {
    return "session";
  }
  if (
    /(?:^|[_:\s-])(?:week|weekly|7d|token_week)(?:$|[_:\s-])/u.test(normalized) ||
    normalized.includes("week")
  ) {
    return "weekly";
  }
  if (
    /(?:^|[_:\s-])(?:month|monthly|30d)(?:$|[_:\s-])/u.test(normalized) ||
    normalized.includes("month")
  ) {
    return "monthly";
  }
  return "other";
}

function extractUsedPercent(obj: Record<string, unknown>): number | undefined {
  const direct = finiteNumber(obj.usedPercent) ?? finiteNumber(obj.usagePercent);
  if (direct !== undefined) return clampPercent(direct);
  const left = finiteNumber(obj.leftPercent);
  if (left !== undefined) return clampPercent(100 - left);
  return undefined;
}

function deduplicateWindowIds(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const counts = new Map<string, number>();
  for (const window of windows) {
    counts.set(window.id, (counts.get(window.id) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const usedIds = new Set<string>();
  return windows.map((window) => {
    if ((counts.get(window.id) ?? 0) <= 1 && !usedIds.has(window.id)) {
      usedIds.add(window.id);
      return window;
    }
    let ordinal = (seen.get(window.id) ?? 0) + 1;
    let candidate = `${window.id}:${ordinal}`;
    while (usedIds.has(candidate)) {
      ordinal += 1;
      candidate = `${window.id}:${ordinal}`;
    }
    seen.set(window.id, ordinal);
    usedIds.add(candidate);
    return { ...window, id: candidate };
  });
}

function parseGenericWindowsResponse(
  obj: Record<string, unknown>,
  checkedAt: string,
): AcpUsageStatsParseResult {
  const rawWindows = obj.windows;
  if (!Array.isArray(rawWindows)) return { status: "unsupported" };
  const parsed: Array<ServerProviderUsageWindow> = [];
  for (let index = 0; index < rawWindows.length; index++) {
    const entry = rawWindows[index];
    if (!isRecord(entry)) continue;
    const usedPercent = extractUsedPercent(entry);
    if (usedPercent === undefined) continue;
    const rawId = trimmedString(entry.id) ?? trimmedString(entry.key) ?? `window_${index + 1}`;
    const rawLabel = trimmedString(entry.label) ?? rawId;
    const kind = parseWindowKind(entry.kind) ?? inferWindowKind(`${rawId} ${rawLabel}`);
    const resetsAt = parseIsoOrEpochResetsAt(entry.resetsAt ?? entry.nextResetTime);
    const windowDurationMins = finiteNumber(entry.windowDurationMins);
    const modelIds = stringArray(entry.modelIds);
    const providerIds = stringArray(entry.providerIds);
    parsed.push({
      id: sanitizeKey(rawId),
      kind,
      label: humanizeLabel(rawLabel),
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowDurationMins !== undefined &&
      Number.isInteger(windowDurationMins) &&
      windowDurationMins >= 0
        ? { windowDurationMins }
        : {}),
      ...(modelIds !== undefined ? { modelIds } : {}),
      ...(providerIds !== undefined ? { providerIds } : {}),
    });
  }
  if (parsed.length === 0) return { status: "unsupported" };
  const authLabel = trimmedString(obj.planName) ?? trimmedString(obj.plan);
  return {
    status: "supported",
    usageLimits: makeUsageLimits({ checkedAt, windows: deduplicateWindowIds(parsed) }),
    ...(authLabel !== undefined ? { authLabel } : {}),
  };
}

interface ParsedGlmItem {
  readonly baseId: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly baseLabel: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
  readonly totalCount?: number;
  readonly nextResetTime?: number;
}

function parseGlmSection(section: Record<string, unknown>): {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly authLabel?: string;
} {
  const level = trimmedString(section.level);
  const authLabel = level !== undefined ? `GLM Coding Plan · ${capitalizeWord(level)}` : undefined;
  const rawItems = Array.isArray(section.items) ? section.items : [];
  const parsed: Array<ParsedGlmItem> = [];
  for (const item of rawItems) {
    if (!isRecord(item)) continue;
    const usedPercent = extractUsedPercent(item);
    if (usedPercent === undefined) continue;
    const key = trimmedString(item.key) ?? "quota";
    const rawLabel = trimmedString(item.label) ?? key;
    const nextResetTime = finiteNumber(item.nextResetTime);
    const resetsAt = parseIsoOrEpochResetsAt(nextResetTime);
    const totalCount = finiteNumber(item.totalCount);

    let kind: ServerProviderUsageWindow["kind"];
    let baseLabel: string;
    let windowDurationMins: number | undefined;
    if (key === "token_5h") {
      kind = "session";
      baseLabel = "5-hour";
      windowDurationMins = SESSION_5H_DURATION_MINS;
    } else if (key === "token_week") {
      kind = "weekly";
      baseLabel = "Weekly";
      windowDurationMins = WEEKLY_DURATION_MINS;
    } else if (key === "mcp") {
      kind = "other";
      baseLabel = "MCP";
    } else {
      baseLabel = humanizeLabel(rawLabel);
      kind = inferWindowKind(`${key} ${rawLabel}`);
    }

    parsed.push({
      baseId: `glm:${sanitizeKey(key)}`,
      kind,
      baseLabel,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
      ...(totalCount !== undefined ? { totalCount } : {}),
      ...(nextResetTime !== undefined ? { nextResetTime } : {}),
    });
  }

  // Group by baseId because credit-based GLM plans emit multiple windows under `credit_limit`.
  const grouped = new Map<string, Array<ParsedGlmItem>>();
  for (const item of parsed) {
    const group = grouped.get(item.baseId);
    if (group) group.push(item);
    else grouped.set(item.baseId, [item]);
  }

  const windows: Array<ServerProviderUsageWindow> = [];
  for (const [baseId, group] of grouped) {
    if (group.length === 1) {
      const only = group[0]!;
      windows.push({
        id: baseId,
        kind: only.kind,
        label: only.baseLabel,
        usedPercent: only.usedPercent,
        ...(only.resetsAt !== undefined ? { resetsAt: only.resetsAt } : {}),
        ...(only.windowDurationMins !== undefined
          ? { windowDurationMins: only.windowDurationMins }
          : {}),
      });
      continue;
    }

    const sorted = [...group].toSorted(
      (left, right) =>
        (left.totalCount ?? Number.POSITIVE_INFINITY) -
          (right.totalCount ?? Number.POSITIVE_INFINITY) ||
        (left.nextResetTime ?? Number.POSITIVE_INFINITY) -
          (right.nextResetTime ?? Number.POSITIVE_INFINITY),
    );
    const counts = sorted.map((entry) => entry.totalCount);
    const useTotalCountLabels =
      counts.every((count): count is number => count !== undefined && count > 0) &&
      new Set(counts).size === sorted.length;

    for (let index = 0; index < sorted.length; index++) {
      const entry = sorted[index]!;
      const label = useTotalCountLabels
        ? `${entry.baseLabel} (${entry.totalCount!.toLocaleString("en-US")})`
        : `${entry.baseLabel} ${index + 1}`;
      windows.push({
        id: `${baseId}:${index + 1}`,
        kind: entry.kind,
        label,
        usedPercent: entry.usedPercent,
        ...(entry.resetsAt !== undefined ? { resetsAt: entry.resetsAt } : {}),
        ...(entry.windowDurationMins !== undefined
          ? { windowDurationMins: entry.windowDurationMins }
          : {}),
      });
    }
  }

  return { windows, ...(authLabel !== undefined ? { authLabel } : {}) };
}

function parseSectionedWindows(
  prefix: "opencode" | "ollama",
  section: Record<string, unknown>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const rawWindows = Array.isArray(section.windows) ? section.windows : [];
  const windows: Array<ServerProviderUsageWindow> = [];
  for (let index = 0; index < rawWindows.length; index++) {
    const entry = rawWindows[index];
    if (!isRecord(entry)) continue;
    const usedPercent = extractUsedPercent(entry);
    if (usedPercent === undefined) continue;
    const key = trimmedString(entry.key) ?? `window_${index + 1}`;
    const resetsAt = parseIsoOrEpochResetsAt(entry.resetsAt);
    let kind: ServerProviderUsageWindow["kind"];
    let windowDurationMins: number | undefined;
    if (key === "rolling" || key === "session") {
      kind = "session";
    } else if (key === "weekly") {
      kind = "weekly";
      windowDurationMins = WEEKLY_DURATION_MINS;
    } else if (key === "monthly") {
      kind = "monthly";
    } else {
      kind = inferWindowKind(key);
    }
    const rawLabel = trimmedString(entry.label);
    const defaultLabel =
      kind === "weekly"
        ? "Weekly"
        : kind === "monthly"
          ? "Monthly"
          : key === "session"
            ? "Session"
            : humanizeLabel(key);
    windows.push({
      id: `${prefix}:${sanitizeKey(key)}`,
      kind,
      label: rawLabel !== undefined ? humanizeLabel(rawLabel) : defaultLabel,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    });
  }
  return windows;
}

function parseZcodeSection(section: Record<string, unknown>): {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly authLabel?: string;
} {
  const authLabel = trimmedString(section.planName);
  const rawWindows = Array.isArray(section.windows) ? section.windows : [];
  const windows: Array<ServerProviderUsageWindow> = [];
  for (let index = 0; index < rawWindows.length; index++) {
    const entry = rawWindows[index];
    if (!isRecord(entry)) continue;
    const usedPercent = extractUsedPercent(entry);
    if (usedPercent === undefined) continue;
    const key = trimmedString(entry.key) ?? `grant_${index + 1}`;
    const label = trimmedString(entry.label) ?? authLabel ?? key;
    const resetsAt = parseIsoOrEpochResetsAt(entry.resetsAt);
    const modelIds = stringArray(entry.modelIds);
    windows.push({
      id: `zcode:${sanitizeKey(key)}`,
      kind: "other",
      label,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(modelIds !== undefined ? { modelIds } : {}),
    });
  }
  return { windows, ...(authLabel !== undefined ? { authLabel } : {}) };
}

function failureMessageForSection(kind: string, section: Record<string, unknown>): string {
  const custom = trimmedString(section.message) ?? trimmedString(section.error);
  if (custom !== undefined) return custom;
  switch (kind) {
    case "auth_error":
      return "Authentication is required to read ACP usage limits.";
    case "rate_limited":
      return "Usage limit request was rate limited by the provider.";
    default:
      return "ACP usage limits are currently unavailable.";
  }
}

function parseProposal0002Response(
  obj: Record<string, unknown>,
  checkedAt: string,
): AcpUsageStatsParseResult {
  const hasProposalSection = PROPOSAL_SECTION_KEYS.some(
    (key) => isRecord(obj[key]) && typeof obj[key].kind === "string",
  );
  if (!hasProposalSection) return { status: "unsupported" };

  let hadFailure = false;
  let failureMessage: string | undefined;

  const inspectKind = (section: Record<string, unknown> | undefined) => {
    if (!section || typeof section.kind !== "string") return false;
    if (section.kind === "success") return true;
    if (FAILURE_SECTION_KINDS.has(section.kind)) {
      hadFailure = true;
      failureMessage ??= failureMessageForSection(section.kind, section);
    }
    return false;
  };

  const glmSection = isRecord(obj.glm) ? obj.glm : undefined;
  const opencodeSection = isRecord(obj.opencode) ? obj.opencode : undefined;
  const ollamaSection = isRecord(obj.ollama) ? obj.ollama : undefined;
  const zcodeSection = isRecord(obj.zcode) ? obj.zcode : undefined;

  const glmParsed = inspectKind(glmSection) ? parseGlmSection(glmSection!) : undefined;
  const opencodeWindows = inspectKind(opencodeSection)
    ? parseSectionedWindows("opencode", opencodeSection!)
    : [];
  const ollamaSuccess = inspectKind(ollamaSection);
  const ollamaWindows = ollamaSuccess ? parseSectionedWindows("ollama", ollamaSection!) : [];
  const zcodeParsed = inspectKind(zcodeSection) ? parseZcodeSection(zcodeSection!) : undefined;

  const sectionBuckets: Array<{
    readonly prefix?: string;
    readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  }> = [];
  if (glmParsed && glmParsed.windows.length > 0) {
    sectionBuckets.push({ windows: glmParsed.windows });
  }
  if (opencodeWindows.length > 0) {
    sectionBuckets.push({ prefix: "OpenCode", windows: opencodeWindows });
  }
  if (ollamaWindows.length > 0) {
    sectionBuckets.push({ prefix: "Ollama", windows: ollamaWindows });
  }
  if (zcodeParsed && zcodeParsed.windows.length > 0) {
    sectionBuckets.push({ windows: zcodeParsed.windows });
  }

  const multipleSections = sectionBuckets.length > 1;
  const allWindows = sectionBuckets.flatMap((bucket) => {
    if (!multipleSections || bucket.prefix === undefined) return bucket.windows;
    const prefix = bucket.prefix;
    return bucket.windows.map((window) =>
      window.label.toLowerCase().startsWith(prefix.toLowerCase())
        ? window
        : { ...window, label: `${prefix} · ${window.label}` },
    );
  });

  if (allWindows.length === 0) {
    return hadFailure
      ? {
          status: "failed",
          ...(failureMessage !== undefined ? { message: failureMessage } : {}),
        }
      : { status: "unsupported" };
  }

  const ollamaUsagePlan =
    ollamaSuccess && ollamaSection && isRecord(ollamaSection.usage)
      ? trimmedString(ollamaSection.usage.plan)
      : undefined;
  const authLabel = glmParsed?.authLabel ?? ollamaUsagePlan ?? zcodeParsed?.authLabel;

  return {
    status: "supported",
    usageLimits: makeUsageLimits({ checkedAt, windows: deduplicateWindowIds(allWindows) }),
    ...(authLabel !== undefined ? { authLabel } : {}),
  };
}

export function parseAcpUsageStatsResponse(
  response: unknown,
  checkedAt: string,
): AcpUsageStatsParseResult {
  if (!isRecord(response)) return { status: "unsupported" };
  if (Array.isArray(response.windows)) {
    return parseGenericWindowsResponse(response, checkedAt);
  }
  return parseProposal0002Response(response, checkedAt);
}
