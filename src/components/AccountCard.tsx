import { useState, useRef, useEffect } from "react";
import type { AccountWithUsage } from "../types";
import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  DeleteIcon,
  HourglassIcon,
  RefreshIcon,
  RunningIcon,
  SpinnerIcon,
  SwitchIcon,
  WarmupIcon,
  iconButtonBaseClass,
} from "./accountCardIcons";
import { UsageBar } from "./UsageBar";

/**
 * Props used to render and operate one account card.
 *
 * @property account - Required account data and current quota state shown in the card.
 * @property onSwitch - Required callback that switches the active Codex account to this account.
 * @property onWarmup - Required callback that sends a minimal warm-up request for this account.
 * @property onDelete - Required callback that removes this account after confirmation.
 * @property onRefresh - Required callback that reloads quota for this account.
 * @property onRename - Required callback that persists a new account display name.
 * @property switching - Optional flag indicating this account is currently being switched to.
 * @property switchDisabled - Optional flag disabling manual switch when Codex processes are active.
 * @property warmingUp - Optional flag indicating warm-up is running for this account.
 * @property masked - Optional flag blurring account name and email; defaults to `false`.
 * @property onToggleMask - Optional callback that toggles masking for this account.
 * @property autoWarmupEnabled - Optional flag showing whether auto warm-up is enabled.
 * @property autoWarmupManagedByAll - Optional flag disabling per-account auto warm-up control
 * when global auto warm-up is enabled.
 * @property autoWarmupLabel - Optional label for the auto warm-up toggle.
 * @property onToggleAutoWarmup - Optional callback that toggles per-account auto warm-up.
 * @property priorityQuotaEnabled - Optional flag showing whether this account is preferred for
 * automatic quota switching.
 * @property onTogglePriorityQuota - Optional callback that toggles priority quota switching for
 * this account.
 */
interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onWarmup: () => Promise<void>;
  onDelete: () => void;
  onRefresh: () => Promise<unknown>;
  onRename: (newName: string) => Promise<void>;
  switching?: boolean;
  switchDisabled?: boolean;
  warmingUp?: boolean;
  masked?: boolean;
  onToggleMask?: () => void;
  autoWarmupEnabled?: boolean;
  autoWarmupManagedByAll?: boolean;
  autoWarmupLabel?: string;
  onToggleAutoWarmup?: () => void;
  priorityQuotaEnabled?: boolean;
  onTogglePriorityQuota?: () => void;
}

/**
 * Formats the last successful quota refresh timestamp for compact display.
 *
 * Purpose:
 *   Converts a refresh timestamp into a short relative label suitable for tooltips and compact
 *   account metadata.
 * Inputs:
 *   date - Required `Date` value for the refresh timestamp, or `null` when no successful refresh
 *   has been recorded for the card.
 * Output:
 *   Returns a human-readable string such as `Just now`, `12s ago`, `4m ago`, or `Never`.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   Reads the current system clock.
 */
function formatLastRefresh(date: Date | null): string {
  if (!date) return "Never";
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString();
}

/**
 * Builds the subscription status text and color class for one account.
 *
 * Purpose:
 *   Converts a subscription expiry timestamp into a concise tooltip label and visual severity
 *   class for the account metadata icon.
 * Inputs:
 *   timestamp - Optional ISO-like timestamp string from account metadata. Missing values produce
 *   an unavailable status.
 * Output:
 *   Returns an object with `label` for user-facing text and `className` for Tailwind color
 *   classes.
 * Errors:
 *   Does not throw intentionally for missing data. Invalid date strings may be formatted by the
 *   browser runtime as invalid date text.
 * Side Effects:
 *   Reads the current system clock and browser locale formatting settings.
 */
function getSubscriptionStatus(timestamp: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!timestamp) {
    return {
      label: "Expiry unavailable",
      className: "text-gray-400 dark:text-gray-500",
    };
  }

  const expiryDate = new Date(timestamp);
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiryDate);

  const remainingMs = expiryDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return {
      label: `Expired ${formattedDate}`,
      className: "text-red-500 dark:text-red-400",
    };
  }

  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-red-500 dark:text-red-400",
    };
  }

  if (remainingMs <= 7 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-amber-500 dark:text-amber-400",
    };
  }

  return {
    label: `Until ${formattedDate}`,
    className: "text-gray-400 dark:text-gray-500",
  };
}

/**
 * Renders text with optional blur masking.
 *
 * Purpose:
 *   Hides account identity fields while preserving layout width when the user enables masking.
 * Inputs:
 *   children - Required React content to display or blur.
 *   blur - Required boolean flag indicating whether the content should be visually obscured.
 * Output:
 *   Returns a span containing the provided content with optional blur styling.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
function BlurredText({ children, blur }: { children: React.ReactNode; blur: boolean }) {
  return (
    <span
      className={`transition-all duration-200 select-none ${blur ? "blur-sm" : ""}`}
      style={blur ? { userSelect: "none" } : undefined}
    >
      {children}
    </span>
  );
}

/**
 * Renders one account card with quota, account actions, and automation toggles.
 *
 * Purpose:
 *   Displays account identity, quota state, switch controls, warm-up controls, masking, and
 *   priority quota switching in the main account list.
 * Inputs:
 *   props - Required `AccountCardProps` containing the account model and callbacks for all card
 *   actions.
 * Output:
 *   Returns the React element for one account card.
 * Errors:
 *   Does not throw intentionally; async callback failures are handled by local state or callers.
 * Side Effects:
 *   Invokes callback props in response to user actions and mutates local edit/refresh state.
 */
export function AccountCard({
  account,
  onSwitch,
  onWarmup,
  onDelete,
  onRefresh,
  onRename,
  switching,
  switchDisabled,
  warmingUp,
  masked = false,
  onToggleMask,
  autoWarmupEnabled = false,
  autoWarmupManagedByAll = false,
  autoWarmupLabel,
  onToggleAutoWarmup,
  priorityQuotaEnabled = false,
  onTogglePriorityQuota,
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.usage && !account.usage.error ? new Date() : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  /**
   * Refreshes the quota information for this card.
   *
   * Purpose:
   *   Runs the account-specific refresh callback and updates the local last-refresh timestamp.
   * Inputs:
   *   None.
   * Output:
   *   Returns a promise that resolves after the refresh callback finishes.
   * Errors:
   *   Propagates failures from `onRefresh` to the caller.
   * Side Effects:
   *   Mutates local refreshing state and last-refresh state, and invokes the provided refresh
   *   callback.
   */
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
      setLastRefresh(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  /**
   * Persists a changed account display name.
   *
   * Purpose:
   *   Validates the local edit buffer, calls the rename callback when the name changed, and exits
   *   edit mode.
   * Inputs:
   *   None.
   * Output:
   *   Returns a promise that resolves after rename handling completes.
   * Errors:
   *   Catches rename callback failures and restores the previous account name locally.
   * Side Effects:
   *   Invokes `onRename` when needed and mutates local edit state.
   */
  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  /**
   * Handles keyboard shortcuts while renaming an account.
   *
   * Purpose:
   *   Commits the rename on Enter and cancels the edit on Escape.
   * Inputs:
   *   e - Required React keyboard event emitted by the rename input.
   * Output:
   *   Returns nothing.
   * Errors:
   *   Does not throw intentionally; rename failures are handled by `handleRename`.
   * Side Effects:
   *   May invoke rename persistence or reset local edit state.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const planDisplay = account.plan_type
    ? account.plan_type.charAt(0).toUpperCase() + account.plan_type.slice(1)
    : account.auth_mode === "api_key"
      ? "API Key"
      : "Unknown";

  const planColors: Record<string, string> = {
    pro: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700",
    plus: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
    team: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
    enterprise: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
    free: "bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
    api_key: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
  };

  const planKey = account.plan_type?.toLowerCase() || "api_key";
  const planColorClass = planColors[planKey] || planColors.free;
  const showSubscriptionStatus = account.auth_mode === "chat_g_p_t";
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at);
  const autoWarmupStatus = autoWarmupLabel ?? `Auto: ${autoWarmupEnabled ? "on" : "off"}`;
  const isWaitingWeeklyReset = autoWarmupStatus === "Waiting weekly reset";
  const showAutoWarmupAsRunning = autoWarmupStatus === "Warming...";
  const switchTitle = switchDisabled
    ? "Codex is running. Close all Codex processes before switching."
    : switching
      ? "Switching account..."
      : "Switch to this account";


  return (
    <div
      className={`relative rounded-xl border p-5 transition-all duration-200 ${
        account.is_active
          ? "bg-white dark:bg-gray-900 border-emerald-400 shadow-sm"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {account.is_active && (
              <span className="flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRename}
                onKeyDown={handleKeyDown}
                className="font-semibold text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 focus:outline-none focus:border-gray-500 dark:focus:border-gray-500 w-full"
              />
            ) : (
              <h3
                className="font-semibold text-gray-900 dark:text-gray-100 truncate cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
                onClick={() => {
                  if (masked) return;
                  setEditName(account.name);
                  setIsEditing(true);
                }}
                title={masked ? undefined : "Click to rename"}
              >
                <BlurredText blur={masked}>{account.name}</BlurredText>
              </h3>
            )}
          </div>
          {account.email && (
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
              <BlurredText blur={masked}>{account.email}</BlurredText>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Eye toggle */}
          {onToggleMask && (
            <button
              onClick={onToggleMask}
              className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title={masked ? "Show info" : "Hide info"}
            >
              {masked ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
            </button>
          )}
          {/* Plan badge */}
          <span
            className={`px-2.5 py-1 text-xs font-medium rounded-full border ${planColorClass}`}
          >
            {planDisplay}
          </span>
        </div>
      </div>

      {/* Usage */}
      <div className="mb-3">
        <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled
          className={`${iconButtonBaseClass()} bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500 cursor-default`}
          title={`Last updated: ${formatLastRefresh(lastRefresh)}`}
          aria-label={`Last updated: ${formatLastRefresh(lastRefresh)}`}
        >
          <ClockIcon />
        </button>
        {showSubscriptionStatus && (
          <button
            type="button"
            disabled
            className={`${iconButtonBaseClass()} bg-gray-50 dark:bg-gray-800 cursor-default ${subscriptionStatus.className}`}
            title={subscriptionStatus.label}
            aria-label={subscriptionStatus.label}
          >
            <CalendarIcon />
          </button>
        )}
        {account.is_active ? (
          <button
            disabled
            className={`${iconButtonBaseClass()} bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800 cursor-default`}
            title="Active account"
            aria-label="Active account"
          >
            <CheckIcon />
          </button>
        ) : (
          <button
            onClick={onSwitch}
            disabled={switching || switchDisabled}
            className={`${iconButtonBaseClass()} disabled:opacity-70 ${
              switchDisabled
                ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed"
                : "bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900"
            }`}
            title={switchTitle}
            aria-label={switchTitle}
          >
            {switching ? <SpinnerIcon /> : switchDisabled ? <RunningIcon /> : <SwitchIcon />}
          </button>
        )}
        <button
          onClick={() => {
            void onWarmup();
          }}
          disabled={warmingUp}
          className={`${iconButtonBaseClass()} ${
            warmingUp
              ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500 dark:text-amber-300"
              : "bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300"
          }`}
          title={warmingUp ? "Sending warm-up request..." : "Send minimal warm-up request"}
          aria-label={warmingUp ? "Sending warm-up request" : "Send minimal warm-up request"}
        >
          {warmingUp ? <SpinnerIcon /> : <WarmupIcon />}
        </button>
        {onTogglePriorityQuota && (
          <button
            onClick={onTogglePriorityQuota}
            className={`${iconButtonBaseClass()} ${
              priorityQuotaEnabled
                ? "bg-sky-100 text-sky-700 ring-1 ring-sky-200 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-200 dark:ring-sky-700"
                : "bg-gray-50 text-gray-300 ring-1 ring-gray-100 hover:bg-gray-100 hover:text-gray-400 dark:bg-gray-900 dark:text-gray-600 dark:ring-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-500"
            }`}
            title={
              priorityQuotaEnabled
                ? "Disable priority quota switching for this account"
                : "Enable priority quota switching for this account"
            }
            aria-label={
              priorityQuotaEnabled
                ? "Disable priority quota switching for this account"
                : "Enable priority quota switching for this account"
            }
          >
            ★
          </button>
        )}
        {onToggleAutoWarmup && (
          <button
            onClick={onToggleAutoWarmup}
            disabled={autoWarmupManagedByAll}
            className={`${iconButtonBaseClass()} ${
              isWaitingWeeklyReset
                ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300"
                : autoWarmupEnabled
                  ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300"
                : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
            } disabled:opacity-60`}
            title={
              autoWarmupManagedByAll
                ? "Auto warm-up is enabled for all accounts"
                : isWaitingWeeklyReset
                  ? "Waiting weekly reset"
                  : autoWarmupEnabled
                  ? "Disable auto warm-up for this account"
                : "Enable auto warm-up for this account"
            }
            aria-label={
              autoWarmupManagedByAll
                ? "Auto warm-up is enabled for all accounts"
                : isWaitingWeeklyReset
                  ? "Waiting weekly reset"
                  : autoWarmupEnabled
                    ? "Disable auto warm-up for this account"
                    : "Enable auto warm-up for this account"
            }
          >
            {showAutoWarmupAsRunning ? (
              <SpinnerIcon />
            ) : isWaitingWeeklyReset ? (
              <HourglassIcon />
            ) : (
              <WarmupIcon />
            )}
          </button>
        )}
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className={`${iconButtonBaseClass()} ${
            isRefreshing
              ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
              : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
          }`}
          title="Refresh usage"
          aria-label="Refresh usage"
        >
          {isRefreshing ? <SpinnerIcon /> : <RefreshIcon />}
        </button>
        <button
          onClick={onDelete}
          className={`${iconButtonBaseClass()} bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-600 dark:text-red-300`}
          title="Remove account"
          aria-label="Remove account"
        >
          <DeleteIcon />
        </button>
      </div>
    </div>
  );
}
