import "./limitsV9.css";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  applyLimitCardOrder,
  moveLimitCard,
  readLimitCardOrder,
  saveLimitCardOrder,
} from "./limitCardOrder";
import { Link } from "@tanstack/react-router";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderDriverKind } from "@t3tools/contracts";
import { UsageLimitsCompass } from "./UsageLimitsCompass";
import {
  resetAffectedWindows,
  resetCreditChoices,
  resetEffectLabel,
  resetExpiry,
} from "./usageResetCreditPresentation";
import { t3LimitWindows } from "./usageQuotaPresentation";
import { uiText as copy } from "~/i18n";
import { UsageResetTimeline } from "./UsageResetTimeline";
import { StardustOrbitMeter, gapText, healthSentence } from "./UsageLimitsHealth";
import {
  poolHealth,
  resetAdvice,
  resetPreviewOutcome,
  groupByProvider,
  sortPoolsByRemaining,
  summarizeHealth,
  type PoolHealth,
  type ResetCardScope,
} from "./limitsHealthModel";
import { limitPoolTitles } from "./limitPoolTitle";
import { useTheme } from "../../hooks/useTheme";
import { UsageLimitRings, quotaStateText } from "./UsageLimitRings";
import {
  quotaReadingStale,
  quotaReadingLabel,
  quotaForecastState,
  quotaWindowLabel,
  quotaForecast,
} from "./usageQuotaPresentation";
import { CursorUsageHint } from "./CursorUsageHint";
import { useUiText } from "~/i18n/useUiText";
import { UsageCount } from "./UsageMotion";
import { readUiLocale } from "~/i18n";
import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitPools,
  limitPoolId,
  cursorUsageWindowDetails,
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  paceRemainingPercent,
  remainingPercent,
  type ResetCreditChoice,
} from "@t3tools/shared/usageLimits";
import { collectLimitNotices, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  AlertTriangleIcon,
  ClockIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
  TicketIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ResetCreditDialog, barColor, usePaceMark, useResetCredit } from "./UsageLimits";

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}
function AccountChip({ email }: { readonly email: string }) {
  const uiText = useUiText();
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={uiText("Account {0}", { "0": accountInitials(email) })}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}
function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          providerClients.get(account.driver)?.label ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}
function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}
function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const uiText = useUiText();
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">
        {uiText(label === "Plan" ? "Subscription plan" : label)}
      </span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}
function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: (choice: ResetCreditChoice) => void;
}) {
  const uiText = useUiText();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = formatResetsIn(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const choices =
    redeem && account.redeem && account.limits.resetCredits?.availableCount
      ? resetCreditChoices(account.limits.resetCredits, account.redeem.input, now, true)
      : [];
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Left">{remaining}%</Row>
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {timeLeft !== null ? (
          <Row label="Even pace">
            {timeLeft}
            {uiText("% left by now")}
          </Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="Restores">
            +{reset.restoresPercent}
            {uiText("% of pool")}
          </Row>
        ) : null}
      </div>
      {choices.length > 0 && redeem ? (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5 text-muted-foreground">
          {choices.map((choice) => (
            <span key={choice.key} className="flex items-center gap-3">
              <span className="tabular-nums">{choice.summary}</span>
              {choice.availableCount > 0 ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={redeem.busy || !redeem.canManageProviders}
                  className="ms-auto"
                  onClick={() => onRedeem(choice)}
                >
                  {redeem.busy ? uiText("Using…") : choice.actionLabel}
                </Button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
/**
 * Every segment on the page shares one popover, so hovering or clicking another
 * segment moves it instead of opening a second one. The payload is the segment
 * it currently describes.
 */
type SegmentPayload = Omit<Parameters<typeof SegmentPopover>[0], "now" | "onRedeem">;
const SegmentPopoverContext = createContext<ReturnType<
  typeof PopoverCreateHandle<SegmentPayload>
> | null>(null);
function ActiveSegmentPopover({
  handle,
  actions,
  payload,
  pools,
  now,
}: {
  readonly handle: ReturnType<typeof PopoverCreateHandle<SegmentPayload>>;
  readonly actions: RefObject<PopoverPrimitive.Root.Actions | null>;
  readonly payload: SegmentPayload;
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  const available = pools.some((pool) =>
    displayLimitWindows(pool).some((window) =>
      window.members.some(
        (member) =>
          member.account.key === payload.account.key &&
          member.window.id === payload.window.id &&
          member.window.kind === payload.window.kind &&
          Boolean(member.account.redeem) === Boolean(payload.redeem),
      ),
    ),
  );
  // The trigger is gone, so the popup has nothing to anchor to: an exit transition would
  // slide it to the viewport origin. Unmount it outright, which also clears Base UI's
  // active-trigger bookkeeping so the segment can open again when it comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover handle and unmounts the Base UI popup before paint when its trigger is gone
  useLayoutEffect(() => {
    if (available) return;
    handle.close();
    actions.current?.unmount();
  }, [available, handle, actions]);
  return (
    <PopoverPopup data-usage-portal side="top" sideOffset={6}>
      <SegmentPopover
        {...payload}
        now={now}
        onRedeem={(choice) => {
          handle.close();
          payload.redeem?.confirm(choice);
        }}
      />
    </PopoverPopup>
  );
}
/**
 * The confirm is a sibling of the popover, not a child: dialogs stack under
 * popovers, and the popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  ...props
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  return account.redeem ? (
    <RedeemableSegment account={account} redeemAt={account.redeem} {...props} />
  ) : (
    <SegmentTriggers account={account} redeem={null} {...props} />
  );
}
function RedeemableSegment({
  redeemAt,
  ...props
}: Omit<Parameters<typeof SegmentTriggers>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const credits = props.account.limits.resetCredits;
  const choices = credits ? resetCreditChoices(credits, redeemAt.input, props.now, true) : [];
  const redeem = useResetCredit(redeemAt.environmentId, credits?.availableCount);
  return (
    <>
      <SegmentTriggers redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        choices={choices}
        onChoice={redeem.confirm}
        credits={credits}
        windows={props.account.limits.windows}
        provider={providerClients.get(props.account.driver)?.label ?? props.account.driver}
        now={props.now}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so progress and the outcome need a home outside it. */}
      {redeem.busy || redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={props.account} className="font-medium text-foreground" />{" "}
          {redeem.busy ? copy("Applying quota reset…") : redeem.status}
        </span>
      ) : null}
    </>
  );
}
function SegmentTriggers({
  account,
  window,
  reset,
  redeem,
  color,
  now,
  index,
  showAccountName,
}: SegmentPayload & {
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  const uiText = useUiText();
  const popover = use(SegmentPopoverContext) ?? undefined;
  const payload: SegmentPayload = { account, window, reset, redeem };
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const [segmentRef] = usePaceMark(timeLeft);
  const resetsIn = formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <>
      <PopoverTrigger
        handle={popover}
        payload={payload}
        openOnHover
        render={
          <button
            ref={segmentRef}
            type="button"
            style={{ gridColumn: index, gridRow: 1 }}
            aria-label={`${account.displayName ?? (account.email ? accountInitials(account.email) : account.driver)}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}${timeLeft === null ? "" : `, ${timeLeft}% of the window left`}${credits ? `, ${credits} reset ${credits === 1 ? "credit" : "credits"} banked` : ""}`}
            className="relative h-5 min-w-0 cursor-pointer rounded-md bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-border @2xl/pool:h-8"
          />
        }
      >
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
          {/* Clipped inside the rounded clip so the bar's own corners keep their antialiasing. */}
          <div className="absolute inset-0">
            <div
              aria-hidden
              className="usage-grow absolute inset-y-0 left-0 rounded-md opacity-35"
              style={{ width: `${100 - remaining}%`, backgroundColor: color }}
            />
          </div>
        </div>
        {timeLeft !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            data-usage-pace
            style={{ left: `${100 - timeLeft}%` }}
          />
        ) : null}
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md text-3xs leading-none font-semibold text-foreground/80 tabular-nums @2xl/pool:hidden"
        >
          {index}
        </span>
        <div className="relative hidden h-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-xs @2xl/pool:flex">
          {showAccountName ? (
            <AccountName
              account={account}
              className="min-w-0 truncate font-medium text-foreground"
            />
          ) : null}
          {/* A single-account bar repeats the headline percentage. */}
          {showAccountName ? (
            <span className="shrink-0 font-semibold text-foreground tabular-nums">
              {remaining}%
            </span>
          ) : null}
          {resetsIn || credits ? (
            <span className="ms-auto flex min-w-0 items-center gap-1.5 overflow-hidden rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs whitespace-nowrap text-foreground tabular-nums">
              {resetsIn?.replace("resets in ", uiText("Resets in ")) ?? ""}
              {credits ? (
                <>
                  {resetsIn ? (
                    <span aria-hidden className="text-muted-foreground">
                      {"\u00B7"}
                    </span>
                  ) : null}
                  <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold">
                    <TicketIcon className="size-3" aria-hidden />
                    {credits}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </PopoverTrigger>
      <LegendRow payload={payload} color={color} now={now} index={index} />
    </>
  );
}
function LegendRow({
  payload,
  color,
  now,
  index,
}: {
  readonly payload: SegmentPayload;
  readonly color: string;
  readonly now: number;
  readonly index: number;
}) {
  const uiText = useUiText();
  const popover = use(SegmentPopoverContext) ?? undefined;
  const { account, window } = payload;
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <PopoverTrigger
      handle={popover}
      payload={payload}
      style={{ gridColumn: "1 / -1", gridRow: index + 1 }}
      render={<Button variant="ghost" size="compact" />}
      className="min-w-0 @2xl/pool:hidden"
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-3xs leading-none font-semibold text-foreground/80 tabular-nums">
        <span
          aria-hidden
          className="absolute inset-0 rounded-sm opacity-35"
          style={{ backgroundColor: color }}
        />
        <span className="sr-only">{uiText("Segment")}</span>
        <span className="relative">{index}</span>
      </span>
      <AccountName account={account} className="min-w-0 truncate font-medium text-foreground" />
      <span className="shrink-0 font-semibold text-foreground tabular-nums">
        {remaining}
        {"%"}
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground tabular-nums">
        {resetsIn?.replace("resets in ", uiText("Resets in ")) ?? ""}
        {credits ? (
          <>
            {resetsIn ? <span aria-hidden>{"\u00B7"}</span> : null}
            <span
              aria-hidden
              className="inline-flex items-center gap-0.5 font-semibold text-foreground"
            >
              <TicketIcon className="size-3" aria-hidden />
              {credits}
            </span>
            <span className="sr-only">
              {credits}
              {uiText("reset")}
              {credits === 1 ? uiText("credit") : uiText("credits")}
              {uiText("banked")}
            </span>
          </>
        ) : null}
      </span>
    </PopoverTrigger>
  );
}
function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const uiText = useUiText();
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  return (
    <div className="@container/pool min-w-0">
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((member, position) =>
          member.window ? (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              reset={restores.get(member.account.key)}
              refillPercent={member.refillPercent}
              color={normalizeProviderAccentColor(member.account.accentColor) ?? color}
              now={now}
              index={position + 1}
              showAccountName={pool.columns.length > 1}
            />
          ) : pool.kind === "monthly" && member.account.limits.zeroSpendCap ? (
            <div
              key={member.account.key}
              style={{ gridColumn: position + 1, gridRow: 1 }}
              className="flex h-5 min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-dashed border-border text-3xs whitespace-nowrap text-muted-foreground @2xl/pool:h-8 @2xl/pool:justify-start @2xl/pool:px-2 @2xl/pool:text-xs"
            >
              <AccountName
                account={member.account}
                className="hidden min-w-0 truncate @2xl/pool:inline-flex"
              />
              {uiText("$0 cap")}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
function PoolWindowCard({
  pool,
  color,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label?: string | null | undefined;
  readonly description?: string | undefined;
}) {
  const uiText = useUiText();
  const nextRefill = pool.resets.find((reset) => reset.at > now);
  const elapsed = pool.members.map((m) => paceRemainingPercent(m.window, now));
  const timeUsed =
    elapsed.length && elapsed.every((v) => v !== null)
      ? 100 - elapsed.reduce<number>((sum, v) => sum + (v ?? 0), 0) / elapsed.length
      : null;
  const ahead = timeUsed === null ? null : Math.round(pool.usedPercent - timeUsed);
  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        {label !== null ? (
          <span className="text-muted-foreground">
            {quotaWindowLabel(label ?? pool.label, readUiLocale() === "zh-CN")}
          </span>
        ) : null}
        <strong className="text-base tabular-nums">
          <UsageCount value={pool.remainingPercent} format={formatLimitPercent} />
        </strong>
        <span>{uiText("left")}</span>
        {nextRefill ? (
          <span className="ml-auto text-muted-foreground">
            {uiText("Resets {time}", {
              time: new Date(nextRefill.at).toLocaleString(readUiLocale(), {
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        ) : null}
      </div>
      <div
        className="relative h-2 rounded-full bg-muted"
        role="img"
        aria-label={uiText("Used {used}%", { used: pool.usedPercent })}
      >
        <div
          className="usage-grow h-full rounded-full"
          style={{ width: `${pool.usedPercent}%`, background: color }}
        />
        {timeUsed !== null ? (
          <span
            data-usage-pace
            className="absolute -top-0.5 h-3 w-px bg-foreground"
            style={{ left: `${timeUsed}%` }}
          />
        ) : null}
      </div>
      {ahead !== null ? (
        <p className="text-2xs text-muted-foreground">
          {ahead > 0
            ? uiText("{percent}% ahead of elapsed time", { percent: ahead })
            : uiText("Within the elapsed-time budget")}
        </p>
      ) : null}
      {pool.columns.length > 1 ? <PoolBar pool={pool} color={color} now={now} /> : null}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}
function formatLimitPercent(n: number) {
  return `${Math.round(n)}%`;
}

function PoolResetButton({
  account,
  now,
}: {
  readonly account: LimitAccount & { redeem: NonNullable<LimitAccount["redeem"]> };
  readonly now: number;
}) {
  const uiText = useUiText();
  const redeem = useResetCredit(
    account.redeem.environmentId,
    account.limits.resetCredits?.availableCount,
  );
  const credits = account.limits.resetCredits;
  const choices = credits ? resetCreditChoices(credits, account.redeem.input, now) : [];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <TicketIcon className="size-3.5" />
      <span>
        {uiText("{count} reset credits available", { count: credits?.availableCount ?? 0 })}
      </span>
      <Button
        size="xs"
        variant="ghost"
        disabled={
          redeem.busy || !redeem.canManageProviders || !choices.some((c) => c.availableCount > 0)
        }
        onClick={() => {
          const first = choices.find((c) => c.availableCount > 0);
          if (first) redeem.confirm(first);
        }}
      >
        {redeem.busy ? uiText("Using…") : uiText("Use reset now")}
      </Button>
      {redeem.status ? <span role="status">{redeem.status}</span> : null}
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        choices={choices}
        onChoice={redeem.confirm}
        credits={credits}
        windows={account.limits.windows}
        provider={providerClients.get(account.driver)?.label ?? account.driver}
        now={now}
        onConfirm={() => void redeem.redeem()}
        disabled={redeem.busy || !redeem.canManageProviders}
      />
    </div>
  );
}
function choiceScope(
  optionLabel: string | undefined,
  affected: readonly { readonly kind: string }[],
): ResetCardScope {
  if (optionLabel === "Weekly reset" || optionLabel === "Full reset") return "weekly";
  if (optionLabel === "5-hour reset") return "session";
  if (affected.some((w) => w.kind === "weekly")) return "weekly";
  if (affected.some((w) => w.kind === "session")) return "session";
  return "other";
}

function formatTimingStamp(at: number, now: number): string {
  const stamp = new Date(at);
  const today = new Date(now);
  const day =
    stamp.toLocaleDateString(readUiLocale()) === today.toLocaleDateString(readUiLocale())
      ? copy("Today")
      : stamp.toLocaleDateString(readUiLocale(), { weekday: "short" });
  const time = stamp.toLocaleTimeString(readUiLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${day} ${time}`;
}

function PoolResetTray({
  pool,
  health,
  title,
  account,
  now,
  selectedKey,
  onSelectKey,
  onClose,
}: {
  readonly pool: LimitPool;
  readonly health: PoolHealth | undefined;
  readonly title: string;
  readonly account: LimitAccount & { redeem: NonNullable<LimitAccount["redeem"]> };
  readonly now: number;
  readonly selectedKey: string | null;
  readonly onSelectKey: (key: string) => void;
  readonly onClose: () => void;
}) {
  const uiText = useUiText();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const credits = account.limits.resetCredits;
  const choices = credits ? resetCreditChoices(credits, account.redeem.input, now) : [];
  const availableChoices = choices.filter((c) => c.availableCount > 0);
  const cardsMeta = availableChoices.map((choice) => {
    const option = credits?.options?.find((o) => o.creditId === choice.key);
    const affected = resetAffectedWindows(choice, credits, account.limits.windows);
    const scope = choiceScope(option?.label, affected);
    const rawExpiry = option?.expiresAt ?? credits?.nextExpiresAt;
    const expiresAt =
      rawExpiry && Number.isFinite(Date.parse(rawExpiry)) ? Date.parse(rawExpiry) : null;
    const expiresDays =
      expiresAt !== null ? Math.max(0, Math.ceil((expiresAt - now) / 86_400_000)) : null;
    const label = resetEffectLabel(option?.label ?? choice.actionLabel);
    return { choice, option, affected, scope, rawExpiry, expiresAt, expiresDays, label };
  });
  const advice = resetAdvice({
    cards: cardsMeta.map((m) => ({
      key: m.choice.key,
      scope: m.scope,
      expiresAt: m.expiresAt,
      count: m.choice.availableCount,
    })),
    gapMs: health?.gapMs ?? null,
    remaining: health?.lowest ?? null,
    now,
  });
  const selectedMeta =
    cardsMeta.find((m) => m.choice.key === selectedKey) ??
    cardsMeta.find((m) => m.choice.key === advice.bestKey) ??
    cardsMeta[0] ??
    null;
  const selected = selectedMeta?.choice ?? null;
  const redeem = useResetCredit(account.redeem.environmentId, credits?.availableCount);
  const preview = selectedMeta
    ? resetPreviewOutcome(selectedMeta.scope, health?.gapMs ?? null)
    : null;
  const totalCount = credits?.availableCount ?? 0;
  const plan = health?.plans.join(" / ") || account.plan || "";

  const previewSummary = (() => {
    if (!preview || !selectedMeta) return null;
    if (preview.kind === "weekly-gap") {
      return uiText("Preview: {label} fills the dry gap before reset", {
        label: selectedMeta.label,
      });
    }
    if (preview.kind === "session-gap") {
      return uiText("Preview: refills 5-hour window only; weekly gap stays");
    }
    return uiText("Preview: refills {count} quota window(s) to 100%", {
      count: Math.max(1, selectedMeta.affected.length),
    });
  })();

  const adviceTone = advice.kind === "gap" ? "urgent" : advice.kind === "calm" ? "calm" : "";
  const timingNodes: Array<{ readonly text: string; readonly best: boolean }> = (() => {
    const resetStamp = health?.gapResetAt ? formatTimingStamp(health.gapResetAt, now) : null;
    const runOutStamp = health?.gapRunOutAt ? formatTimingStamp(health.gapRunOutAt, now) : null;
    if (advice.kind === "gap") {
      return [
        { text: uiText("Use now (best value)"), best: true },
        ...(runOutStamp
          ? [{ text: uiText("Est. run-out · {time}", { time: runOutStamp }), best: false }]
          : []),
        ...(resetStamp
          ? [{ text: uiText("Natural reset · {time}", { time: resetStamp }), best: false }]
          : []),
      ];
    }
    if (advice.kind === "expiring") {
      return [
        { text: uiText("Now (not urgent)"), best: false },
        { text: uiText("Before heavy load (recommended)"), best: true },
        ...(advice.soonestDays !== null
          ? [
              {
                text: uiText("Card expires · in {days}d", { days: advice.soonestDays }),
                best: false,
              },
            ]
          : []),
      ];
    }
    return [
      { text: uiText("Now (early)"), best: false },
      { text: uiText("Below 15% or 5h limit (recommended)"), best: true },
      ...(resetStamp
        ? [{ text: uiText("Natural reset · {time}", { time: resetStamp }), best: false }]
        : []),
    ];
  })();

  return (
    <div
      data-usage-reset-tray
      data-lv9="rc-tray"
      role="region"
      aria-label={uiText("{provider} · Reset credits", { provider: title })}
    >
      <div data-lv9="rc-tray-head">
        <span data-lv9="logo-slot">
          <ProviderInstanceIcon
            driverKind={pool.driver}
            displayName={title}
            className="size-3.5"
            iconClassName="size-3.5"
          />
        </span>
        <b>{uiText("{provider} · Reset credits", { provider: title })}</b>
        <span data-lv9="badge muted">
          {plan
            ? uiText("Matched by {plan} · {count} left", { plan, count: totalCount })
            : uiText("{count} remaining", { count: totalCount })}
        </span>
        {previewSummary && preview ? (
          <span data-lv9={preview.fillsGap ? "badge ok" : "badge muted"}>{previewSummary}</span>
        ) : null}
        <span data-lv9="sp" />
        <button
          type="button"
          data-lv9="chip-btn"
          onClick={() => {
            setConfirmingKey(null);
            onClose();
          }}
        >
          {uiText("Collapse")}
        </button>
      </div>

      <div data-lv9={adviceTone ? `rc-advice ${adviceTone}` : "rc-advice"}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
        </svg>
        <div>
          {advice.kind === "gap"
            ? uiText(
                "Recommended now: quota may run out before natural reset. Spending one credit bridges the gap.",
              )
            : advice.kind === "expiring"
              ? uiText(
                  "A reset credit expires in {days} day(s). Use it before heavy work so it does not go to waste.",
                  { days: advice.soonestDays ?? 0 },
                )
              : uiText(
                  "Balance is still healthy (≥{percent}%). Waiting until quota drops lower makes this credit go further.",
                  { percent: Math.round(health?.lowest ?? 50) },
                )}
        </div>
      </div>

      <div data-lv9="rc-cards-grid">
        {cardsMeta.map((meta) => {
          const isSelected = selected?.key === meta.choice.key;
          const isRecommended = meta.choice.key === advice.bestKey;
          const expiryDate = resetExpiry(meta.rawExpiry);
          const soon = meta.expiresDays !== null && meta.expiresDays <= 4;
          const scopeLabel =
            meta.scope === "session"
              ? uiText("5h window")
              : meta.scope === "weekly"
                ? uiText("Weekly 100%")
                : uiText("All windows");
          return (
            <button
              key={meta.choice.key}
              type="button"
              data-lv9={isSelected ? "rc-card sel" : "rc-card"}
              data-pick-card={meta.choice.key}
              data-selected={isSelected || undefined}
              onClick={() => {
                setConfirmingKey(null);
                onSelectKey(meta.choice.key);
              }}
            >
              <div data-lv9="rc-card-top">
                <span data-lv9="rc-card-title">
                  <TicketIcon aria-hidden="true" />
                  <span>{meta.label}</span>
                </span>
                <span data-lv9="rc-card-badges">
                  {isRecommended ? (
                    <span data-lv9={advice.kind === "gap" ? "badge warn" : "badge ok"}>
                      {advice.kind === "gap" ? uiText("Top pick") : uiText("Best match")}
                    </span>
                  ) : null}
                  <span data-lv9="badge muted num">×{meta.choice.availableCount}</span>
                </span>
              </div>
              <div data-lv9="rc-card-desc">
                {meta.affected.length > 0
                  ? meta.affected
                      .map(
                        (w) =>
                          `${quotaWindowLabel(w.label, readUiLocale() === "zh-CN")} ${remainingPercent(w)}% → 100%`,
                      )
                      .join(" · ")
                  : meta.choice.confirmDescription}
              </div>
              <div data-lv9="rc-card-meta">
                <span data-lv9={soon ? "rc-exp soon" : "rc-exp"}>
                  {meta.expiresDays !== null
                    ? uiText("Expires in {days}d ({date})", {
                        days: meta.expiresDays,
                        date: expiryDate,
                      })
                    : uiText("Earliest expiry {date}", { date: expiryDate })}
                </span>
                <span>{scopeLabel}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div data-lv9="rc-foot">
        {redeem.status ? (
          <span role="status" className="text-xs text-muted-foreground">
            {redeem.status}
          </span>
        ) : (
          <div data-lv9="rc-timing">
            <span data-lv9="rc-timing-lead">
              <ClockIcon aria-hidden="true" />
              <span>{uiText("Timing")}</span>
            </span>
            {timingNodes.map((node, index) => (
              <Fragment key={node.text}>
                {index > 0 ? <span data-lv9="rc-arrow">→</span> : null}
                <span data-lv9={node.best ? "rc-node best" : "rc-node"}>{node.text}</span>
              </Fragment>
            ))}
          </div>
        )}
        {selected && selectedMeta ? (
          confirmingKey === selected.key ? (
            <div data-lv9="rc-confirm-bar">
              <span>
                {uiText("Confirm spending 1 {label}? This cannot be undone.", {
                  label: selectedMeta.label,
                })}
              </span>
              <button type="button" data-lv9="chip-btn" onClick={() => setConfirmingKey(null)}>
                {uiText("Cancel")}
              </button>
              <button
                type="button"
                data-lv9="rc-btn-danger"
                disabled={redeem.busy || !redeem.canManageProviders}
                onClick={() => {
                  setConfirmingKey(null);
                  void redeem.redeemChoice(selected);
                }}
              >
                {redeem.busy ? uiText("Using…") : uiText("Confirm reset now")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-lv9="rc-btn-primary"
              disabled={redeem.busy || !redeem.canManageProviders}
              onClick={() => setConfirmingKey(selected.key)}
            >
              <TicketIcon aria-hidden="true" />
              <span>{uiText("Use {label}", { label: selectedMeta.label })}</span>
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * V14: a limit card the user can drag within the grid (after a 6px move, so clicks still work).
 * The others slide aside with the spring; Esc cancels; ⌥← / ⌥→ moves it from the keyboard.
 */
function SortableLimitCard({
  id,
  onStep,
  children,
}: {
  readonly id: string;
  readonly onStep: (delta: -1 | 1) => void;
  readonly children: React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    transition: { duration: 280, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)" },
  });
  return (
    <div
      ref={setNodeRef}
      data-limit-sortable={id}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
      onKeyDown={(event) => {
        if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        onStep(event.key === "ArrowLeft" ? -1 : 1);
      }}
    >
      {children}
    </div>
  );
}

function PoolSection({
  pool,
  health,
  title,
  now,
  highlighted,
  flashHighlighted,
  resetTrayOpen,
  onToggleResetTray,
  onHoverStart,
  onHoverEnd,
  previewAffectedWindowIds,
}: {
  readonly pool: LimitPool;
  readonly health?: PoolHealth | undefined;
  readonly title: string;
  readonly now: number;
  readonly highlighted?: boolean;
  readonly flashHighlighted?: boolean;
  readonly resetTrayOpen?: boolean;
  readonly onToggleResetTray?: () => void;
  readonly onHoverStart?: (() => void) | undefined;
  readonly onHoverEnd?: (() => void) | undefined;
  readonly previewAffectedWindowIds?: ReadonlySet<string> | undefined;
}) {
  const uiText = useUiText();
  const { theme } = useTheme();
  const color = barColor(pool.driver);
  const label = title;
  const driverLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const fullLabel =
    pool.id === undefined || label === driverLabel ? label : `${label} · ${driverLabel}`;
  const windows = t3LimitWindows(pool);
  const state = quotaForecastState(
    windows.flatMap((w) => w.members.map((m) => m.window)),
    now,
  );
  const totalCredits = pool.accounts.reduce(
    (sum, account) =>
      sum + (account.redeem ? (account.limits.resetCredits?.availableCount ?? 0) : 0),
    0,
  );
  const recommendReset = Boolean(
    !resetTrayOpen &&
    (health?.gapMs !== null ? (health?.gapMs ?? 0) > 0.35 * 86_400_000 : state === "early"),
  );
  if (theme === "apple")
    return (
      <section
        data-usage-card
        className="usage-limit-ring-card"
        data-highlighted={highlighted || undefined}
        id={`usage-limit-${limitPoolId(pool)}`}
      >
        <UsageLimitRings
          pool={pool}
          poolId={limitPoolId(pool)}
          now={now}
          label={label}
          fullLabel={fullLabel}
          flashHighlighted={flashHighlighted}
          runsOutToday={health?.runsOutToday ?? false}
          gapMs={health?.gapMs ?? null}
          onHoverStart={onHoverStart}
          onHoverEnd={onHoverEnd}
          previewAffectedWindowIds={previewAffectedWindowIds}
        >
          {totalCredits > 0 && onToggleResetTray ? (
            <button
              type="button"
              data-lv9={
                resetTrayOpen ? "rc-pill open" : recommendReset ? "rc-pill recommend" : "rc-pill"
              }
              data-open={resetTrayOpen || undefined}
              data-recommend={recommendReset || undefined}
              onClick={(event) => {
                event.stopPropagation();
                onToggleResetTray();
              }}
            >
              <TicketIcon aria-hidden="true" />
              <span data-lv9="num">{uiText("Reset ×{count}", { count: totalCredits })}</span>
              {recommendReset ? (
                <>
                  <span data-lv9="rc-dot" aria-hidden="true" />
                  <span data-lv9="rc-suggest">{uiText("Suggested now")}</span>
                </>
              ) : null}
            </button>
          ) : null}
        </UsageLimitRings>
      </section>
    );
  return (
    <section
      data-usage-card
      id={`usage-limit-${limitPoolId(pool)}`}
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
    >
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate" />}>{label}</TooltipTrigger>
          <TooltipPopup data-usage-portal side="top">
            {fullLabel}
          </TooltipPopup>
        </Tooltip>
        {windows.length ? (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs">
            {copy(quotaStateText[state])}
          </span>
        ) : null}
      </h2>
      {pool.accounts.map((account) =>
        account.redeem && (account.limits.resetCredits?.availableCount ?? 0) > 0 ? (
          <PoolResetButton
            key={account.key}
            account={{ ...account, redeem: account.redeem }}
            now={now}
          />
        ) : null,
      )}
      {windows.map((window) => {
        const details =
          pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            color={color}
            now={now}
            label={details?.label}
            description={details?.description}
          />
        );
      })}
    </section>
  );
}
/** 限额页结论：找出本周用得比时间快最多的一家（真实读数），给出用完与重置时间。 */
function limitsHeadline(
  pools: ReturnType<typeof collectLimitPools>,
  titles: ReadonlyMap<string, string>,
  now: number,
): { readonly lead: string; readonly figure?: string; readonly detail: string } | null {
  const fmt = (at: number) => {
    const date = new Date(at);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const days = Math.floor((date.getTime() - today.getTime()) / 86_400_000);
    const time = date.toLocaleTimeString(readUiLocale(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const day =
      days === 0
        ? copy("Today")
        : days === 1
          ? copy("Tomorrow")
          : date.toLocaleDateString(readUiLocale(), { weekday: "short" });
    return `${day} ${time}`;
  };
  let best: {
    label: string;
    ahead: number;
    used: number;
    runOutAt: number | null;
    resetAt: number | null;
    elapsedHours: number;
  } | null = null;
  for (const pool of pools) {
    const label = titles.get(limitPoolId(pool)) ?? String(pool.driver);
    for (const window of t3LimitWindows(pool).flatMap((w) => w.members.map((m) => m.window))) {
      if (window.kind !== "weekly") continue;
      const resetAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      if (Number.isFinite(resetAt) && resetAt <= now) continue;
      const { elapsed, runOutAt } = quotaForecast(window, now);
      if (elapsed === null || elapsed <= 0.05) continue;
      const ahead = window.usedPercent - elapsed * 100;

      if (best === null || ahead > best.ahead) {
        best = {
          label,
          ahead,
          used: window.usedPercent,
          runOutAt,
          resetAt: Number.isFinite(resetAt) ? resetAt : null,
          elapsedHours: Math.max(1, Math.round((elapsed * (window.windowDurationMins ?? 0)) / 60)),
        };
      }
    }
  }
  if (best === null) return null;
  const detail = copy(
    "Based on average usage over the last {hours} hours · Quota from official sources",
    {
      hours: best.elapsedHours,
    },
  );
  if (best.ahead > 5)
    return {
      lead:
        best.runOutAt !== null && best.resetAt !== null && best.runOutAt < best.resetAt
          ? copy("At this pace, {provider} runs out at {runOut} and resets at {reset}", {
              provider: best.label,
              runOut: fmt(best.runOutAt),
              reset: fmt(best.resetAt),
            })
          : copy("At this pace, {provider} lasts until the reset", { provider: best.label }),
      detail,
    };
  return { lead: copy("Weekly quota is on track"), detail };
}

// Claude logins and ACP Registry agents are separate subscriptions; averaging them hides which one is nearly spent.
const SEPARATE_LIMIT_DRIVERS = [
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("acpRegistry"),
];

export function UsageLimitsPooled({
  presentations,
  now,
  refreshControl,
}: {
  readonly refreshControl?: React.ReactNode;
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  const uiText = useUiText();
  const { theme } = useTheme();
  const apple = theme === "apple";
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [flashPoolId, setFlashPoolId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the 800ms highlight-flash timeout on unmount
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );
  const [openResetPoolId, setOpenResetPoolId] = useState<string | null>(null);
  const [selectedResetChoiceKey, setSelectedResetChoiceKey] = useState<string | null>(null);
  const [segmentPopover] = useState(() => PopoverCreateHandle<SegmentPayload>());
  const segmentPopoverActions = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const collected = collectLimitPools(collectLimitAccounts(presentations), now, {
    separateDrivers: SEPARATE_LIMIT_DRIVERS,
  });
  const titles = limitPoolTitles(collected);
  const healthOf = (pool: LimitPool) =>
    poolHealth(pool, titles.get(limitPoolId(pool)) ?? String(pool.driver), now);
  // V11/V14: most quota left first, one provider's accounts side by side, then the user's own drag
  // order on top (kept on this device). Cards, chips and lanes share the one order.
  const [savedOrder, setSavedOrder] = useState(() => readLimitCardOrder());
  const providerOf = (pool: LimitPool) => String(pool.driver);
  const pools = applyLimitCardOrder(
    groupByProvider(sortPoolsByRemaining(collected, healthOf), providerOf),
    savedOrder,
    limitPoolId,
    providerOf,
  );
  const poolIds = pools.map(limitPoolId);
  const reorderCards = (next: readonly string[] | null) => {
    setSavedOrder(next);
    saveLimitCardOrder(next);
  };
  const cardSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const handleCardDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = poolIds.indexOf(String(active.id));
    const to = poolIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    reorderCards(arrayMove(poolIds, from, to));
  };
  const health = pools.map(healthOf);
  const healthById = new Map(health.map((entry) => [entry.id, entry]));
  const activeResetPool = apple
    ? (pools.find((p) => limitPoolId(p) === openResetPoolId) ?? null)
    : null;
  const activeResetHealth = activeResetPool
    ? healthById.get(limitPoolId(activeResetPool))
    : undefined;
  const activeResetAccount =
    activeResetPool?.accounts.find(
      (account): account is LimitAccount & { redeem: NonNullable<LimitAccount["redeem"]> } =>
        Boolean(account.redeem) && (account.limits.resetCredits?.availableCount ?? 0) > 0,
    ) ?? null;
  const activeResetChoices =
    activeResetAccount && activeResetAccount.limits.resetCredits
      ? resetCreditChoices(
          activeResetAccount.limits.resetCredits,
          activeResetAccount.redeem.input,
          now,
        ).filter((c) => c.availableCount > 0)
      : [];
  const activeResetBestKey =
    activeResetAccount && activeResetChoices.length > 0
      ? resetAdvice({
          cards: activeResetChoices.map((choice) => {
            const option = activeResetAccount.limits.resetCredits?.options?.find(
              (o) => o.creditId === choice.key,
            );
            const affected = resetAffectedWindows(
              choice,
              activeResetAccount.limits.resetCredits,
              activeResetAccount.limits.windows,
            );
            const rawExp =
              option?.expiresAt ?? activeResetAccount.limits.resetCredits?.nextExpiresAt;
            return {
              key: choice.key,
              scope: choiceScope(option?.label, affected),
              expiresAt: rawExp && Number.isFinite(Date.parse(rawExp)) ? Date.parse(rawExp) : null,
              count: choice.availableCount,
            };
          }),
          gapMs: activeResetHealth?.gapMs ?? null,
          remaining: activeResetHealth?.lowest ?? null,
          now,
        }).bestKey
      : null;
  const activeResetChoice =
    activeResetChoices.find((c) => c.key === selectedResetChoiceKey) ??
    activeResetChoices.find((c) => c.key === activeResetBestKey) ??
    activeResetChoices[0] ??
    null;
  const activeResetAffected =
    activeResetAccount && activeResetChoice
      ? resetAffectedWindows(
          activeResetChoice,
          activeResetAccount.limits.resetCredits,
          activeResetAccount.limits.windows,
        )
      : [];
  const previewAffectedWindowIds =
    activeResetPool && activeResetAffected.length > 0
      ? new Set(activeResetAffected.map((w) => w.id))
      : undefined;
  const resetPreview =
    activeResetPool && activeResetAccount && activeResetChoice
      ? (() => {
          const option = activeResetAccount.limits.resetCredits?.options?.find(
            (o) => o.creditId === activeResetChoice.key,
          );
          const scope = choiceScope(option?.label, activeResetAffected);
          const outcome = resetPreviewOutcome(scope, activeResetHealth?.gapMs ?? null);
          return {
            poolId: limitPoolId(activeResetPool),
            fillsGap: outcome.fillsGap,
            label: resetEffectLabel(option?.label ?? activeResetChoice.actionLabel),
          };
        })()
      : null;
  const staleAccount = pools
    .flatMap((p) => p.accounts)
    .find((a) => quotaReadingStale(a.limits, now));
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  const headline = limitsHeadline(pools, titles, now);
  const healthSummary = summarizeHealth(health);
  const sentence = healthSentence(uiText, healthSummary);
  const showHealthHero =
    apple && !staleAccount && (sentence.alert !== null || sentence.rest !== null);
  const focusPool = (poolId: string) => {
    setHighlighted(poolId);
    setFlashPoolId(poolId);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setFlashPoolId((cur) => (cur === poolId ? null : cur));
      flashTimerRef.current = null;
    }, 800);
    document
      .getElementById(`usage-limit-${poolId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const missing = [
    ...new Set(
      [...presentations].flatMap(([, p]) =>
        (p.serverConfig?.providers ?? [])
          .filter(
            (provider) =>
              ["codex", "claudeAgent", "grok", "antigravity", "cursor"].includes(provider.driver) ||
              provider.status === "ready",
          )
          .map((provider) => provider.driver),
      ),
    ),
  ].filter((driver) => !pools.some((pool) => pool.driver === driver));

  if (apple) {
    const trayOpen = Boolean(activeResetPool && activeResetAccount);
    return (
      <div data-usage-limit-page data-lv9-root="">
        <div data-lv9="risk-hero">
          {savedOrder !== null ? (
            <button
              type="button"
              data-lv9="chip-btn restore-order"
              data-usage-restore-order
              onClick={() => reorderCards(null)}
            >
              <RotateCcwIcon aria-hidden="true" />
              {uiText("Restore auto order")}
            </button>
          ) : null}
          <div>
            <div data-lv9="risk-eyebrow">
              {showHealthHero
                ? uiText(
                    pools.length === 1
                      ? "Quota health · {count} subscription"
                      : "Quota health · {count} subscriptions",
                    { count: pools.length },
                  )
                : pools.length > 0
                  ? copy(
                      pools.length === 1
                        ? "{count} subscription · Quota from official sources"
                        : "{count} subscriptions · Quota from official sources",
                      { count: pools.length },
                    )
                  : copy("Quota from official sources")}
            </div>
            <div data-lv9="risk-headline">
              {staleAccount ? (
                quotaReadingLabel(staleAccount.limits)
              ) : showHealthHero ? (
                <span data-usage-health-headline>
                  {sentence.alert ? <em>{sentence.alert}</em> : null}
                  {sentence.alert && sentence.rest ? uiText("; ") : null}
                  {sentence.alert ? (
                    sentence.rest
                  ) : sentence.rest ? (
                    <em data-lv9="ok">{sentence.rest}</em>
                  ) : null}
                </span>
              ) : headline ? (
                <>
                  {headline.lead}
                  {headline.figure ? <em>{headline.figure}</em> : null}
                </>
              ) : pools.length === 0 ? (
                uiText("Quota is not available yet")
              ) : (
                uiText("Weekly quota and reset times")
              )}
            </div>
            {pools.length > 0 ? (
              <div data-lv9="risk-chips" role="group" aria-label={uiText("Account status")}>
                {health.map((entry) => {
                  // V13: the chip shares its card's verdict; only warn/bad are tinted.
                  const chipTone =
                    entry.tone === "bad" ? "bad" : entry.tone === "warn" ? "warn" : null;
                  const parts: string[] = [];
                  if (entry.gapMs !== null) parts.push(gapText(uiText, entry.gapMs));
                  if ((entry.credits ?? 0) > 0) {
                    parts.push(
                      uiText(entry.credits === 1 ? "{count} card" : "{count} cards", {
                        count: entry.credits,
                      }),
                    );
                  }
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      data-lv9={chipTone ? `risk-chip ${chipTone}` : "risk-chip"}
                      data-jump-card={entry.id}
                      data-state={entry.state}
                      data-active={highlighted === entry.id || undefined}
                      onClick={() => focusPool(entry.id)}
                    >
                      {entry.label}
                      {entry.lowest !== null ? ` ${Math.round(entry.lowest)}%` : ""}
                      {parts.length ? ` · ${parts.join(" · ")}` : ""}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        {pools.length === 0 && externalLinks.length === 0 ? (
          <div
            data-usage-limits-empty
            className="flex min-h-56 flex-col items-center justify-center gap-2 text-center"
          >
            <h2 className="text-sm font-medium">{uiText("No quota data yet")}</h2>
            <p className="text-xs text-muted-foreground">
              {uiText("Enable a provider and sign in to view its quota here.")}
            </p>
          </div>
        ) : null}

        <div
          data-usage-limit-grid
          data-lv9="limit-4grid"
          data-highlighted={highlighted ?? undefined}
        >
          <SegmentPopoverContext value={segmentPopover}>
            <DndContext
              sensors={cardSensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToParentElement]}
              onDragEnd={handleCardDragEnd}
            >
              <SortableContext items={poolIds} strategy={rectSortingStrategy}>
                {pools.map((pool) => {
                  const poolId = limitPoolId(pool);
                  const isResetOpen =
                    activeResetPool !== null && limitPoolId(activeResetPool) === poolId;
                  return (
                    <SortableLimitCard
                      key={poolId}
                      id={poolId}
                      onStep={(delta) =>
                        reorderCards(
                          moveLimitCard(poolIds, poolId, poolIds.indexOf(poolId) + delta),
                        )
                      }
                    >
                      <PoolSection
                        pool={pool}
                        health={healthById.get(poolId)}
                        title={titles.get(poolId) ?? String(pool.driver)}
                        now={now}
                        highlighted={highlighted === poolId || isResetOpen}
                        flashHighlighted={flashPoolId === poolId}
                        resetTrayOpen={isResetOpen}
                        onToggleResetTray={() => {
                          setSelectedResetChoiceKey(null);
                          setOpenResetPoolId((cur) => (cur === poolId ? null : poolId));
                        }}
                        onHoverStart={() => setHighlighted(poolId)}
                        onHoverEnd={() => setHighlighted((cur) => (cur === poolId ? null : cur))}
                        previewAffectedWindowIds={
                          isResetOpen ? previewAffectedWindowIds : undefined
                        }
                      />
                    </SortableLimitCard>
                  );
                })}
              </SortableContext>
            </DndContext>
          </SegmentPopoverContext>
          {pools.length > 0 ? (
            <UsageLimitsCompass
              pools={pools}
              health={health}
              presentations={presentations}
              onFocusPool={focusPool}
            />
          ) : null}
          <Popover handle={segmentPopover} actionsRef={segmentPopoverActions}>
            {({ payload }) =>
              payload ? (
                <ActiveSegmentPopover
                  handle={segmentPopover}
                  actions={segmentPopoverActions}
                  payload={payload}
                  pools={pools}
                  now={now}
                />
              ) : null
            }
          </Popover>
          {externalLinks.map((link) => (
            <section
              key={link.url}
              data-lv9="lv9-external"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {link.url === CHATGPT_USAGE_URL ? (
                  <OpenAI className="size-5 shrink-0" aria-hidden="true" />
                ) : null}
                <div className="min-w-0 space-y-1">
                  <h2 className="text-sm font-medium">{link.label}</h2>
                  <p className="text-xs break-words text-muted-foreground">
                    {link.accounts.join(", ")}
                  </p>
                  {link.url === CHATGPT_USAGE_URL ? (
                    <p className="text-xs text-muted-foreground">
                      {uiText("View usage in ChatGPT with your connected account.")}
                    </p>
                  ) : link.message ? (
                    <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
                  ) : null}
                </div>
              </div>
              <Button
                variant="ghost-muted"
                size="xs"
                onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
              >
                {uiText("Manage usage")}
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </section>
          ))}
          {missing.filter((driver) => driver !== "cursor").length ? (
            <div data-usage-no-reading className="usage-limit-missing">
              {uiText("No quota reported by {names}. Usage is still available.", {
                names: missing
                  .filter((driver) => driver !== "cursor")
                  .map((driver) => providerClients.get(driver)?.label ?? driver)
                  .join(copy(", ")),
              })}
            </div>
          ) : null}
        </div>

        <div
          data-lv9={trayOpen ? "rc-tray-shell open" : "rc-tray-shell"}
          data-usage-reset-tray-shell
          data-open={trayOpen || undefined}
        >
          <div data-lv9="rc-tray-clip">
            {activeResetPool && activeResetAccount ? (
              <PoolResetTray
                pool={activeResetPool}
                health={activeResetHealth}
                title={titles.get(limitPoolId(activeResetPool)) ?? String(activeResetPool.driver)}
                account={activeResetAccount}
                now={now}
                selectedKey={activeResetChoice?.key ?? null}
                onSelectKey={setSelectedResetChoiceKey}
                onClose={() => {
                  setOpenResetPoolId(null);
                  setSelectedResetChoiceKey(null);
                }}
              />
            ) : null}
          </div>
        </div>

        <UsageResetTimeline
          pools={pools}
          now={now}
          v9
          highlighted={highlighted}
          openResetPoolId={openResetPoolId}
          onHighlight={setHighlighted}
          resetPreview={resetPreview}
          onOpenResetPool={(poolId) => {
            setSelectedResetChoiceKey(null);
            setOpenResetPoolId(poolId);
          }}
        />

        {pools.length > 0 ? <StardustOrbitMeter pools={health} onFocusPool={focusPool} /> : null}
        {missing.some((driver) => driver === "cursor") ? (
          <div data-usage-cursor-notice>
            <CursorUsageHint />
          </div>
        ) : null}
        <LimitNotices notices={notices} />
      </div>
    );
  }

  return (
    <div data-usage-limit-page className="space-y-3">
      <div className="usage-limits-eyebrow">
        <span>
          {pools.length > 0
            ? copy(
                pools.length === 1
                  ? "{count} subscription · Quota from official sources"
                  : "{count} subscriptions · Quota from official sources",
                { count: pools.length },
              )
            : copy("Quota from official sources")}
        </span>
      </div>
      <div className="usage-limits-heading">
        <h2 className="usage-limits-conclusion">
          {staleAccount ? (
            quotaReadingLabel(staleAccount.limits)
          ) : headline ? (
            <>
              {headline.lead}
              {headline.figure ? <em>{headline.figure}</em> : null}
            </>
          ) : pools.some(
              (p) =>
                quotaForecastState(
                  t3LimitWindows(p).flatMap((w) => w.members.map((m) => m.window)),
                  now,
                ) === "early",
            ) ? (
            uiText("Some quota may run out before it resets")
          ) : pools.length === 0 ? (
            uiText("Quota is not available yet")
          ) : (
            uiText("Weekly quota and reset times")
          )}
        </h2>
        {refreshControl}
      </div>
      {pools.length === 0 && !staleAccount ? null : (
        <p className="text-xs text-muted-foreground">
          {!staleAccount && headline
            ? headline.detail
            : uiText("Official quota data · Bars show used quota; markers show elapsed time.")}
        </p>
      )}
      {pools.length === 0 && externalLinks.length === 0 ? (
        <div
          data-usage-limits-empty
          className="flex min-h-56 flex-col items-center justify-center gap-2 text-center"
        >
          <h2 className="text-sm font-medium">{uiText("No quota data yet")}</h2>
          <p className="text-xs text-muted-foreground">
            {uiText("Enable a provider and sign in to view its quota here.")}
          </p>
        </div>
      ) : null}
      <div
        data-usage-limit-grid
        className="grid grid-cols-1 gap-4 lg:grid-cols-2"
        data-highlighted={highlighted ?? undefined}
      >
        <SegmentPopoverContext value={segmentPopover}>
          {pools.map((pool) => {
            const poolId = limitPoolId(pool);
            return (
              <Fragment key={poolId}>
                <PoolSection
                  pool={pool}
                  health={healthById.get(poolId)}
                  title={titles.get(poolId) ?? String(pool.driver)}
                  now={now}
                  highlighted={highlighted === poolId}
                />
              </Fragment>
            );
          })}
        </SegmentPopoverContext>
        <Popover handle={segmentPopover} actionsRef={segmentPopoverActions}>
          {({ payload }) =>
            payload ? (
              <ActiveSegmentPopover
                handle={segmentPopover}
                actions={segmentPopoverActions}
                payload={payload}
                pools={pools}
                now={now}
              />
            ) : null
          }
        </Popover>
        {externalLinks.map((link) => (
          <section
            key={link.url}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {link.url === CHATGPT_USAGE_URL ? (
                <OpenAI className="size-5 shrink-0" aria-hidden="true" />
              ) : null}
              <div className="min-w-0 space-y-1">
                <h2 className="text-sm font-medium">{link.label}</h2>
                <p className="text-xs break-words text-muted-foreground">
                  {link.accounts.join(", ")}
                </p>
                {link.url === CHATGPT_USAGE_URL ? (
                  <p className="text-xs text-muted-foreground">
                    {uiText("View usage in ChatGPT with your connected account.")}
                  </p>
                ) : link.message ? (
                  <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
                ) : null}
              </div>
            </div>
            <Button
              variant="ghost-muted"
              size="xs"
              onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
            >
              {uiText("Manage usage")}
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </Button>
          </section>
        ))}
        {missing.filter((driver) => driver !== "cursor").length ? (
          <div data-usage-no-reading className="usage-limit-missing">
            {uiText("No quota reported by {names}. Usage is still available.", {
              names: missing
                .filter((driver) => driver !== "cursor")
                .map((driver) => providerClients.get(driver)?.label ?? driver)
                .join(copy(", ")),
            })}
          </div>
        ) : null}
        <UsageResetTimeline pools={pools} now={now} onHighlight={setHighlighted} />
      </div>
      {missing.some((driver) => driver === "cursor") ? (
        <div data-usage-cursor-notice>
          <CursorUsageHint />
        </div>
      ) : null}
      <LimitNotices notices={notices} />
    </div>
  );
}
function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  const text = useUiText();
  if (notices.length === 0) return null;
  return (
    <div className="space-y-2">
      {notices.map((notice) => {
        const provider = notice.split(": ", 1)[0] ?? "";
        const needsLogin = /not authenticated|sign[ -]?in|log[ -]?in|unauthorized/i.test(notice);
        return (
          <Alert key={notice} variant="warning" controlAlignment="first-line">
            <AlertTriangleIcon />
            <AlertTitle className="break-words">
              {text(
                needsLogin
                  ? "{provider} needs you to sign in to read its quota."
                  : "{provider} could not report quota.",
                { provider },
              )}
            </AlertTitle>
            {/* Alert sorts unknown children into its 16px icon slot; the details must be a description. */}
            <AlertDescription>
              <details className="min-w-0 text-xs">
                <summary className="cursor-pointer">{text("Technical details")}</summary>
                <pre className="mt-2 whitespace-pre-wrap break-all">{notice}</pre>
              </details>
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" render={<Link to="/settings/providers" />}>
                {text(needsLogin ? "Sign in" : "How to fix")}
              </Button>
            </AlertAction>
          </Alert>
        );
      })}
    </div>
  );
}
