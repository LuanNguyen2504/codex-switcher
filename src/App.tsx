import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAccounts, type RefreshUsageSummary } from "./hooks/useAccounts";
import {
  QUOTA_REPORT_RELOAD_INTERVAL_MS,
  useQuotaReport,
  type QuotaReportEntry,
} from "./hooks/useQuotaReport";
import {
  AccountCard,
  AddAccountModal,
  QuotaReportModal,
  TrayQuotaPopup,
  UpdateChecker,
} from "./components";
import type { AccountWithUsage, CodexProcessInfo, UsageInfo } from "./types";
import { selectQuotaSwitchAccount } from "./lib/quotaAccountSelection";
import {
  exportFullBackupFile,
  importFullBackupFile,
  isTauriRuntime,
  invokeBackend,
  listenBackendEvent,
} from "./lib/platform";
import { updateMenuBarQuotaSnapshot } from "./lib/menuBarQuota";
import "./App.css";

const THEME_STORAGE_KEY = "codex-switcher-theme";
const AUTO_WARMUP_ALL_STORAGE_KEY = "codex-switcher-auto-warmup-all";
const AUTO_WARMUP_ACCOUNTS_STORAGE_KEY = "codex-switcher-auto-warmup-accounts";
const AUTO_WARMUP_LEDGER_STORAGE_KEY = "codex-switcher-auto-warmup-last-success";
const PRIORITY_QUOTA_ACCOUNTS_STORAGE_KEY = "codex-switcher-priority-quota-accounts";
const AUTO_WARMUP_CHECK_INTERVAL_MS = 30 * 1000;
const AUTO_WARMUP_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES = 5;
const DEFAULT_PRIMARY_WINDOW_MINUTES = 300;
const LIMIT_FULL_THRESHOLD = 99.5;
type ThemeMode = "light" | "dark";
/**
 * Options used by the shared quota reload workflow.
 *
 * @property accountList - Optional explicit account list to reload. When omitted, the latest
 * account list from UI state is used.
 * @property refreshMetadata - Optional flag indicating account metadata should be refreshed before
 * quota requests. Defaults to `false`.
 */
interface SharedQuotaReloadOptions {
  accountList?: AccountWithUsage[];
  refreshMetadata?: boolean;
}

/**
 * Payload emitted by the native menu bar after a quick account switch succeeds.
 *
 * @property account_id - Required account ID that became active in backend storage.
 */
interface TrayAccountSwitchedEvent {
  account_id: string;
}

/**
 * Payload emitted by the native menu bar when an action fails.
 *
 * @property message - Required human-readable error message.
 */
interface TrayErrorEvent {
  message: string;
}

/**
 * Payload emitted by the custom HTML tray popup when a row requests manual switching.
 *
 * @property account_id - Required account ID selected in the popup.
 */
interface TrayPopupSwitchRequestedEvent {
  account_id: string;
}

type AutoWarmupLedger = Record<
  string,
  {
    lastSuccessfulWarmupAt?: number;
  }
>;
const isMacOs =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);
const appWindow = isTauriRuntime() ? getCurrentWindow() : null;

/**
 * Detects whether the current webview should render the tray popup UI.
 *
 * Purpose:
 *   Lets Tauri open a small secondary window using the same Vite entrypoint while avoiding the
 *   full main application shell.
 * Inputs:
 *   None.
 * Output:
 *   Returns `true` when the URL contains `view=tray-popup`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   Reads `window.location.search`.
 */
function isTrayPopupView(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("view") === "tray-popup";
}

function readStoredStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readStoredAutoWarmupLedger(): AutoWarmupLedger {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_WARMUP_LEDGER_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([accountId, value]) => {
          const timestamp =
            value &&
            typeof value === "object" &&
            "lastSuccessfulWarmupAt" in value &&
            typeof value.lastSuccessfulWarmupAt === "number"
              ? value.lastSuccessfulWarmupAt
              : undefined;
          return timestamp ? [accountId, { lastSuccessfulWarmupAt: timestamp }] : null;
        })
        .filter((entry): entry is [string, { lastSuccessfulWarmupAt: number }] => Boolean(entry))
    );
  } catch {
    return {};
  }
}

function isLimitFull(usedPercent: number | null | undefined): boolean {
  return usedPercent !== null && usedPercent !== undefined && usedPercent >= LIMIT_FULL_THRESHOLD;
}

function getPrimaryWindowMinutes(usage: UsageInfo): number {
  return usage.primary_window_minutes ?? DEFAULT_PRIMARY_WINDOW_MINUTES;
}

function getPrimaryRemainingMs(usage: UsageInfo): number | null {
  if (!usage.primary_resets_at) return null;
  return usage.primary_resets_at * 1000 - Date.now();
}

function isPrimaryFullWindow(usage: UsageInfo): boolean {
  const remainingMs = getPrimaryRemainingMs(usage);
  if (remainingMs === null) return false;

  const thresholdMinutes = Math.max(
    0,
    getPrimaryWindowMinutes(usage) - AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES
  );
  return remainingMs >= thresholdMinutes * 60 * 1000;
}

function getLastSuccessfulWarmupAt(
  ledger: AutoWarmupLedger,
  accountId: string
): number | undefined {
  return ledger[accountId]?.lastSuccessfulWarmupAt;
}

/**
 * Builds a menu-bar-ready account list after a shared quota reload.
 *
 * Purpose:
 *   Lets scheduled and manual all-account reloads update the native menu bar immediately with the
 *   exact fresh usage payloads returned by the reload instead of waiting for React state propagation.
 * Inputs:
 *   currentAccounts - Required account list that was targeted by the reload.
 *   summary - Required reload summary containing fresh usage data and per-account failures.
 * Output:
 *   Returns account rows with successful usage replaced and failed rows marked with preserved
 *   quota plus the latest error message.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
function buildAccountsAfterUsageSummary(
  currentAccounts: AccountWithUsage[],
  summary: RefreshUsageSummary
): AccountWithUsage[] {
  const attemptedIds = new Set(summary.attemptedAccountIds);
  const failedIds = new Set(summary.failedAccountIds);

  return currentAccounts.map((account) => {
    if (!attemptedIds.has(account.id)) return account;

    const freshUsage = summary.usageByAccountId[account.id];
    if (freshUsage) {
      return { ...account, usage: freshUsage, usageLoading: false };
    }

    if (failedIds.has(account.id)) {
      return {
        ...account,
        usage: buildUsageErrorFromAccount(
          account,
          summary.errorsByAccountId[account.id] ?? "Usage refresh failed"
        ),
        usageLoading: false,
      };
    }

    return { ...account, usageLoading: false };
  });
}

/**
 * Builds an account usage error while preserving previous quota fields.
 *
 * Purpose:
 *   Keeps the menu bar and reports honest about reload failures while retaining the last known
 *   quota numbers for coordination.
 * Inputs:
 *   account - Required account row whose prior usage should be preserved.
 *   message - Required failure message from the quota reload.
 * Output:
 *   Returns a `UsageInfo` object with previous quota fields and the latest error message.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
function buildUsageErrorFromAccount(account: AccountWithUsage, message: string): UsageInfo {
  return {
    account_id: account.id,
    plan_type: account.usage?.plan_type ?? account.plan_type ?? null,
    primary_used_percent: account.usage?.primary_used_percent ?? null,
    primary_window_minutes: account.usage?.primary_window_minutes ?? null,
    primary_resets_at: account.usage?.primary_resets_at ?? null,
    secondary_used_percent: account.usage?.secondary_used_percent ?? null,
    secondary_window_minutes: account.usage?.secondary_window_minutes ?? null,
    secondary_resets_at: account.usage?.secondary_resets_at ?? null,
    has_credits: account.usage?.has_credits ?? null,
    unlimited_credits: account.usage?.unlimited_credits ?? null,
    credits_balance: account.usage?.credits_balance ?? null,
    error: message,
  };
}

/**
 * Renders the Codex Switcher application shell.
 *
 * Purpose:
 *   Coordinates account management, quota display, automatic warm-up, quota reporting, import and
 *   export workflows, and desktop window controls.
 * Inputs:
 *   None. Application state is loaded from backend commands, local storage, and browser runtime
 *   APIs.
 * Output:
 *   Returns the root React element for the application.
 * Errors:
 *   Does not throw intentionally; operation-specific failures are shown through stateful toasts or
 *   modal errors.
 * Side Effects:
 *   Calls Tauri or web backend commands, uses local storage, starts timers, and updates document
 *   theme classes.
 */
function App() {
  if (isTrayPopupView()) {
    return <TrayQuotaPopup />;
  }

  const {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isQuotaReportOpen, setIsQuotaReportOpen] = useState(false);
  const [configModalMode, setConfigModalMode] = useState<"slim_export" | "slim_import">(
    "slim_export"
  );
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [processInfo, setProcessInfo] = useState<CodexProcessInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [warmupToast, setWarmupToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [autoWarmupAllEnabled, setAutoWarmupAllEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AUTO_WARMUP_ALL_STORAGE_KEY) === "true";
  });
  const [autoWarmupAccountIds, setAutoWarmupAccountIds] = useState<Set<string>>(
    () => new Set(readStoredStringArray(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY))
  );
  const [autoWarmupLedger, setAutoWarmupLedger] =
    useState<AutoWarmupLedger>(() => readStoredAutoWarmupLedger());
  const [autoWarmupRunningIds, setAutoWarmupRunningIds] = useState<Set<string>>(
    new Set()
  );
  const [priorityQuotaAccountIds, setPriorityQuotaAccountIds] = useState<Set<string>>(
    () => new Set(readStoredStringArray(PRIORITY_QUOTA_ACCOUNTS_STORAGE_KEY))
  );
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [otherAccountsSort, setOtherAccountsSort] = useState<
    | "deadline_asc"
    | "deadline_desc"
    | "remaining_desc"
    | "remaining_asc"
    | "subscription_asc"
    | "subscription_desc"
  >("deadline_asc");
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      return saved === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const accountsRef = useRef(accounts);
  const processInfoRef = useRef(processInfo);
  const priorityQuotaAccountIdsRef = useRef(priorityQuotaAccountIds);
  const processedQuotaSwitchReportIdRef = useRef<string | null>(null);
  const quotaReloadRunningRef = useRef(false);
  const autoWarmupAccountIdsRef = useRef(autoWarmupAccountIds);
  const autoWarmupLedgerRef = useRef(autoWarmupLedger);
  const autoWarmupRunningIdsRef = useRef(autoWarmupRunningIds);
  const autoWarmupRetryAfterRef = useRef<Record<string, number>>({});
  const quotaReport = useQuotaReport({ accounts });
  const {
    recordReload: recordQuotaReportReload,
    recordReloadError: recordQuotaReportReloadError,
    setNextReloadAt: setQuotaReportNextReloadAt,
  } = quotaReport;

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    processInfoRef.current = processInfo;
  }, [processInfo]);

  useEffect(() => {
    priorityQuotaAccountIdsRef.current = priorityQuotaAccountIds;
  }, [priorityQuotaAccountIds]);

  useEffect(() => {
    autoWarmupAccountIdsRef.current = autoWarmupAccountIds;
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    autoWarmupRunningIdsRef.current = autoWarmupRunningIds;
  }, [autoWarmupRunningIds]);

  useEffect(() => {
    if (loading || error) return;

    const validAccountIds = new Set(accounts.map((account) => account.id));

    setAutoWarmupAccountIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validAccountIds.has(id)));
      return next.size === prev.size ? prev : next;
    });

    setAutoWarmupLedger((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([accountId]) => validAccountIds.has(accountId))
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });

    setPriorityQuotaAccountIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validAccountIds.has(id)));
      return next.size === prev.size ? prev : next;
    });

    for (const accountId of Object.keys(autoWarmupRetryAfterRef.current)) {
      if (!validAccountIds.has(accountId)) {
        delete autoWarmupRetryAfterRef.current[accountId];
      }
    }
  }, [accounts, error, loading]);

  useEffect(() => {
    autoWarmupLedgerRef.current = autoWarmupLedger;
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_LEDGER_STORAGE_KEY,
        JSON.stringify(autoWarmupLedger)
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupLedger]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ALL_STORAGE_KEY,
        String(autoWarmupAllEnabled)
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupAllEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(Array.from(autoWarmupAccountIds))
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PRIORITY_QUOTA_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(Array.from(priorityQuotaAccountIds))
      );
    } catch {
      // Ignore storage errors; priority quota switching still works for the current session.
    }
  }, [priorityQuotaAccountIds]);

  const handleTitlebarDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isTauriRuntime() || event.button !== 0) return;
      void appWindow?.startDragging();
    },
    []
  );

  const handleTitlebarDoubleClick = useCallback(() => {
    if (!isTauriRuntime()) return;
    void appWindow?.toggleMaximize();
  }, []);

  const toggleMask = (accountId: string) => {
    setMaskedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const allMasked =
    accounts.length > 0 && accounts.every((account) => maskedAccounts.has(account.id));

  const toggleMaskAll = () => {
    setMaskedAccounts((prev) => {
      const shouldMaskAll = !accounts.every((account) => prev.has(account.id));
      const next = shouldMaskAll ? new Set(accounts.map((account) => account.id)) : new Set<string>();
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const checkProcesses = useCallback(async () => {
    try {
      const info = await invokeBackend<CodexProcessInfo>("check_codex_processes");
      setProcessInfo((prev) => {
        if (
          prev &&
          prev.can_switch === info.can_switch &&
          prev.count === info.count &&
          prev.background_count === info.background_count &&
          prev.pids.length === info.pids.length &&
          prev.pids.every((pid, index) => pid === info.pids[index])
        ) {
          return prev;
        }
        return info;
      });
      return info;
    } catch (err) {
      console.error("Failed to check processes:", err);
      return null;
    }
  }, []);

  // Check processes on mount and periodically
  useEffect(() => {
    checkProcesses();
    const interval = setInterval(checkProcesses, 5000);
    return () => clearInterval(interval);
  }, [checkProcesses]);

  // Load masked accounts from storage on mount
  useEffect(() => {
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    if (!isActionsMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!actionsMenuRef.current) return;
      if (!actionsMenuRef.current.contains(event.target as Node)) {
        setIsActionsMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isActionsMenuOpen]);

  useEffect(() => {
    const isDark = themeMode === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore storage errors; theme still works for current session.
    }
  }, [themeMode]);

  useEffect(() => {
    if (!isTauriRuntime() || isMacOs || !appWindow) return;

    let unlisten: (() => void) | undefined;

    const syncMaximizedState = async () => {
      try {
        setIsWindowMaximized(await appWindow.isMaximized());
      } catch (err) {
        console.error("Failed to read window state:", err);
      }
    };

    void syncMaximizedState();

    appWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to watch window resize:", err);
      });

    return () => {
      unlisten?.();
    };
  }, []);

  /**
   * Switches accounts from manual UI entry points.
   *
   * Purpose:
   *   Applies the Codex-running guard before invoking the shared account switch workflow, so both
   *   main cards and tray popup rows follow the same manual switching rule.
   * Inputs:
   *   accountId - Required account ID selected by the user.
   * Output:
   *   Resolves after switch succeeds, is blocked by running Codex processes, or fails.
   * Errors:
   *   Catches switch failures and logs them instead of throwing to click/event handlers.
   * Side Effects:
   *   Reads process state, may write Codex auth JSON through `switchAccount`, and updates
   *   `switchingId`.
   */
  const handleSwitch = useCallback(async (accountId: string) => {
    const latestProcessInfo = await checkProcesses();
    if (latestProcessInfo && !latestProcessInfo.can_switch) {
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
    } catch (err) {
      console.error("Failed to switch account:", err);
    } finally {
      setSwitchingId(null);
    }
  }, [checkProcesses, switchAccount]);

  const handleDelete = async (accountId: string) => {
    if (deleteConfirmId !== accountId) {
      setDeleteConfirmId(accountId);
      setTimeout(() => setDeleteConfirmId(null), 3000);
      return;
    }

    try {
      await deleteAccount(accountId);
      setDeleteConfirmId(null);
    } catch (err) {
      console.error("Failed to delete account:", err);
    }
  };

  /**
   * Runs automatic account switching after a quota report snapshot is available.
   *
   * Purpose:
   *   Switches the active auth file away from an exhausted account after a fresh quota reload,
   *   using priority accounts first and then any other account with remaining quota.
   * Inputs:
   *   report - Required quota report snapshot produced by the shared quota reload workflow.
   * Output:
   *   Resolves after the switch attempt succeeds, fails, or is skipped.
   * Errors:
   *   Catches switch failures and shows a toast instead of throwing to the reload caller.
   * Side Effects:
   *   Reads latest account refs, may call the backend switch command, mutates switching state,
   *   stores the processed report ID, and displays user toasts. This intentionally does not block
   *   on running Codex processes because it uses the same auth-file activation path as adding a new
   *   account.
   */
  async function runAutoSwitchAfterQuotaReport(report: QuotaReportEntry): Promise<void> {
    if (processedQuotaSwitchReportIdRef.current === report.id) return;

    processedQuotaSwitchReportIdRef.current = report.id;
    const active = accountsRef.current.find((account) => account.is_active);
    const activeReportRow = active
      ? report.rows.find((row) => row.accountId === active.id)
      : undefined;
    if (
      !active ||
      !activeReportRow ||
      activeReportRow.status !== "fresh" ||
      (!isLimitFull(activeReportRow.primaryUsedPercent) &&
        !isLimitFull(activeReportRow.secondaryUsedPercent))
    ) {
      return;
    }

    const candidate = selectQuotaSwitchAccount(
      accountsRef.current,
      report,
      priorityQuotaAccountIdsRef.current
    );
    if (!candidate || candidate.account.id === active.id) return;

    try {
      setSwitchingId(candidate.account.id);
      await switchAccount(candidate.account.id);
      const sourceLabel = candidate.source === "priority" ? "priority" : "available";
      showWarmupToast(`Switched to ${sourceLabel} account ${candidate.account.name}`);
    } catch (err) {
      console.error("Failed to auto switch account after quota reload:", err);
      showWarmupToast(
        `Auto switch failed for ${candidate.account.name}: ${formatWarmupError(err)}`,
        true
      );
    } finally {
      setSwitchingId(null);
    }
  }

  /**
   * Reloads quota through the shared app workflow and records the same result as a report log.
   *
   * Purpose:
   *   Prevents the UI refresh path and quota-report scheduler from issuing separate quota reloads.
   * Inputs:
   *   options - Optional `SharedQuotaReloadOptions`; `refreshMetadata` reloads account metadata
   *   before quota requests and defaults to `false`.
   * Output:
   *   Resolves when the shared quota reload finishes and returns `true` when a reload was
   *   performed, or `false` when there were no accounts or another reload was already running.
   * Errors:
   *   Rethrows quota reload failures after recording the report-level error state.
   * Side Effects:
   *   Calls backend quota commands through `refreshUsage`, mutates UI loading state, updates
   *   account quota state, writes a quota report snapshot, and schedules the next reload time.
   */
  const reloadQuotaAndRecordReport = useCallback(
    async (options: SharedQuotaReloadOptions = {}) => {
      const accountSnapshot = options.accountList ?? accountsRef.current;
      if (accountSnapshot.length === 0) {
        setQuotaReportNextReloadAt(null);
        return false;
      }
      if (quotaReloadRunningRef.current) {
        return false;
      }

      const startedAt = Date.now();
      quotaReloadRunningRef.current = true;
      setIsRefreshing(true);
      setRefreshSuccess(false);

      try {
        const summary = await refreshUsage(accountSnapshot, {
          refreshMetadata: options.refreshMetadata,
          preserveExistingOnError: true,
        });
        const updatedAccounts = buildAccountsAfterUsageSummary(accountSnapshot, summary);
        accountsRef.current = updatedAccounts;
        await updateMenuBarQuotaSnapshot(
          updatedAccounts,
          priorityQuotaAccountIdsRef.current
        );
        const report = recordQuotaReportReload(accountSnapshot, summary, startedAt, Date.now());
        if (report) {
          void runAutoSwitchAfterQuotaReport(report);
        }
        setRefreshSuccess(true);
        setTimeout(() => setRefreshSuccess(false), 2000);
        return true;
      } catch (err) {
        recordQuotaReportReloadError(err);
        throw err;
      } finally {
        quotaReloadRunningRef.current = false;
        setIsRefreshing(false);
      }
    },
    [
      recordQuotaReportReload,
      recordQuotaReportReloadError,
      refreshUsage,
      setQuotaReportNextReloadAt,
    ]
  );

  /**
   * Handles the top-bar quota refresh button.
   *
   * Purpose:
   *   Runs the shared quota reload workflow with metadata refresh enabled.
   * Inputs:
   *   None.
   * Output:
   *   Resolves after the reload attempt finishes.
   * Errors:
   *   Propagates unexpected reload failures to the browser console through the caller runtime.
   * Side Effects:
   *   Reloads quota, updates report logs, and toggles the success indicator.
   */
  const handleRefresh = async () => {
    await reloadQuotaAndRecordReport({ refreshMetadata: true });
  };

  useEffect(() => {
    if (accounts.length === 0) {
      setQuotaReportNextReloadAt(null);
      return undefined;
    }

    setQuotaReportNextReloadAt(Date.now() + QUOTA_REPORT_RELOAD_INTERVAL_MS);
    const interval = window.setInterval(() => {
      void reloadQuotaAndRecordReport().catch((err) => {
        console.error("Scheduled quota reload failed:", err);
      });
    }, QUOTA_REPORT_RELOAD_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [
    accounts.length,
    reloadQuotaAndRecordReport,
    setQuotaReportNextReloadAt,
  ]);

  const showWarmupToast = useCallback((message: string, isError = false) => {
    setWarmupToast({ message, isError });
    setTimeout(() => setWarmupToast(null), 2500);
  }, []);

  const formatWarmupError = useCallback((err: unknown) => {
    if (!err) return "Unknown error";
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }, []);

  useEffect(() => {
    void updateMenuBarQuotaSnapshot(accounts, priorityQuotaAccountIds).catch((err) => {
      console.error("Failed to update menu bar quota:", err);
    });
  }, [accounts, priorityQuotaAccountIds]);

  /**
   * Reloads quota for only the currently active account after a menu bar click.
   *
   * Purpose:
   *   Keeps the menu bar interaction lightweight by refreshing the active account without running
   *   the full all-account report reload workflow.
   * Inputs:
   *   None.
   * Output:
   *   Resolves after the active account quota reload finishes or is skipped when no account is
   *   active.
   * Errors:
   *   Catches reload failures and shows a toast instead of throwing through the event listener.
   * Side Effects:
   *   Calls the single-account quota reload hook, mutates account usage state, and immediately
   *   pushes the refreshed active-account quota snapshot to the native menu bar.
   */
  const handleTrayActiveRefresh = useCallback(async () => {
    const active = accountsRef.current.find((account) => account.is_active);
    if (!active) return;

    try {
      const usage = await refreshSingleUsage(active.id);
      const updatedAccounts = accountsRef.current.map((account) =>
        account.id === active.id ? { ...account, usage, usageLoading: false } : account
      );
      accountsRef.current = updatedAccounts;
      await updateMenuBarQuotaSnapshot(
        updatedAccounts,
        priorityQuotaAccountIdsRef.current
      );
    } catch (err) {
      console.error("Failed to reload active account from menu bar:", err);
      showWarmupToast(`Active quota reload failed: ${formatWarmupError(err)}`, true);
    }
  }, [formatWarmupError, refreshSingleUsage, showWarmupToast]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void listenBackendEvent<TrayAccountSwitchedEvent>(
      "tray-account-switched",
      (event) => {
        void loadAccounts(true).then(() => {
          showWarmupToast(`Switched from menu bar: ${event.account_id}`);
        });
      }
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void listenBackendEvent<void>("tray-refresh-requested", () => {
      void reloadQuotaAndRecordReport({ refreshMetadata: true }).catch((err) => {
        console.error("Failed to reload quota from menu bar:", err);
        showWarmupToast(`Menu bar reload failed: ${formatWarmupError(err)}`, true);
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void listenBackendEvent<void>("tray-active-refresh-requested", () => {
      void handleTrayActiveRefresh();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void listenBackendEvent<TrayErrorEvent>("tray-error", (event) => {
      showWarmupToast(`Menu bar error: ${event.message}`, true);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void listenBackendEvent<TrayPopupSwitchRequestedEvent>(
      "tray-popup-switch-requested",
      (event) => {
        void handleSwitch(event.account_id);
      }
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void listenBackendEvent<void>("tray-popup-report-requested", () => {
      setIsQuotaReportOpen(true);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [
    formatWarmupError,
    handleSwitch,
    handleTrayActiveRefresh,
    loadAccounts,
    reloadQuotaAndRecordReport,
    showWarmupToast,
  ]);

  const markSuccessfulWarmup = useCallback((accountId: string, timestamp = Date.now()) => {
    setAutoWarmupLedger((prev) => ({
      ...prev,
      [accountId]: { lastSuccessfulWarmupAt: timestamp },
    }));
  }, []);

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      markSuccessfulWarmup(accountId);
      showWarmupToast(`Warm-up sent for ${accountName}`);
    } catch (err) {
      console.error("Failed to warm up account:", err);
      showWarmupToast(
        `Warm-up failed for ${accountName}: ${formatWarmupError(err)}`,
        true
      );
    } finally {
      setWarmingUpId(null);
    }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) {
        showWarmupToast("No accounts available for warm-up", true);
        return;
      }

      const warmedAt = Date.now();
      const failedAccountIds = new Set(summary.failed_account_ids);
      accounts.forEach((account) => {
        if (!failedAccountIds.has(account.id)) {
          markSuccessfulWarmup(account.id, warmedAt);
        }
      });

      if (summary.failed_account_ids.length === 0) {
        showWarmupToast(
          `Warm-up sent for all ${summary.warmed_accounts} account${
            summary.warmed_accounts === 1 ? "" : "s"
          }`
        );
      } else {
        showWarmupToast(
          `Warmed ${summary.warmed_accounts}/${summary.total_accounts}. Failed: ${summary.failed_account_ids.length}`,
          true
        );
      }
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      showWarmupToast(`Warm-up all failed: ${formatWarmupError(err)}`, true);
    } finally {
      setIsWarmingAll(false);
    }
  };

  const toggleAutoWarmupAccount = (accountId: string) => {
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  /**
   * Toggles whether an account is preferred for automatic quota switching.
   *
   * Purpose:
   *   Lets the user configure multiple priority accounts that should be selected first when the
   *   active account has no primary or weekly quota left.
   * Inputs:
   *   accountId - Required ID of the account to add to or remove from the priority set.
   * Output:
   *   Returns `void`.
   * Errors:
   *   Does not throw.
   * Side Effects:
   *   Mutates React state and later persists the priority account ID list to local storage.
   */
  const togglePriorityQuotaAccount = useCallback((accountId: string) => {
    setPriorityQuotaAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  }, []);

  const isAutoWarmupDue = useCallback(
    (accountId: string, usage: UsageInfo | undefined) => {
      if (!usage || usage.error || !usage.primary_resets_at) return false;
      if (isLimitFull(usage.secondary_used_percent)) return false;
      if (!isPrimaryFullWindow(usage)) return false;

      const lastSuccessfulWarmupAt = getLastSuccessfulWarmupAt(
        autoWarmupLedgerRef.current,
        accountId
      );
      if (
        lastSuccessfulWarmupAt &&
        Date.now() - lastSuccessfulWarmupAt < AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS
      ) {
        return false;
      }

      return true;
    },
    []
  );

  const getAutoWarmupLabel = useCallback(
    (
      usage: UsageInfo | undefined,
      isEnabled: boolean,
      isRunning: boolean
    ) => {
      if (isRunning) return "Warming...";
      if (!isEnabled) return "Auto: off";
      if (!usage || usage.error || !usage.primary_resets_at) return "Auto: on";

      if (isLimitFull(usage.secondary_used_percent)) {
        return "Waiting weekly reset";
      }

      return "Auto: on";
    },
    []
  );

  const headerAutoWarmupLabel = useMemo(() => {
    if (autoWarmupRunningIds.size > 0) return "Auto warming...";
    return autoWarmupAllEnabled || autoWarmupAccountIds.size > 0
      ? "Auto: on"
      : "Auto: off";
  }, [autoWarmupAccountIds.size, autoWarmupAllEnabled, autoWarmupRunningIds]);

  const backOffAutoWarmupRetry = useCallback((accountId: string) => {
    autoWarmupRetryAfterRef.current[accountId] =
      Date.now() + AUTO_WARMUP_RETRY_BACKOFF_MS;
  }, []);

  const runAutoWarmupForAccount = useCallback(
    async (accountId: string, accountName: string) => {
      setAutoWarmupRunningIds((prev) => new Set(prev).add(accountId));

      try {
        let freshUsage: UsageInfo;
        try {
          freshUsage = await refreshSingleUsage(accountId);
        } catch (err) {
          console.error("Auto warm-up usage refresh failed:", err);
          backOffAutoWarmupRetry(accountId);
          return;
        }

        if (freshUsage.error || !freshUsage.primary_resets_at) {
          backOffAutoWarmupRetry(accountId);
          return;
        }
        if (!isAutoWarmupDue(accountId, freshUsage)) {
          return;
        }

        await warmupAccount(accountId);
        markSuccessfulWarmup(accountId);
        showWarmupToast(`Auto warm-up sent for ${accountName}`);
      } catch (err) {
        console.error("Auto warm-up failed:", err);
        backOffAutoWarmupRetry(accountId);
        showWarmupToast(
          `Auto warm-up failed for ${accountName}: ${formatWarmupError(err)}`,
          true
        );
      } finally {
        setAutoWarmupRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(accountId);
          return next;
        });
      }
    },
    [
      backOffAutoWarmupRetry,
      formatWarmupError,
      isAutoWarmupDue,
      markSuccessfulWarmup,
      refreshSingleUsage,
      showWarmupToast,
      warmupAccount,
    ]
  );

  useEffect(() => {
    if (!autoWarmupAllEnabled && autoWarmupAccountIds.size === 0) return;

    const checkAutoWarmup = () => {
      for (const account of accountsRef.current) {
        const autoEnabled =
          autoWarmupAllEnabled || autoWarmupAccountIdsRef.current.has(account.id);
        if (!autoEnabled || autoWarmupRunningIdsRef.current.has(account.id)) continue;

        const retryAfter = autoWarmupRetryAfterRef.current[account.id];
        if (retryAfter && Date.now() < retryAfter) continue;

        if (!isAutoWarmupDue(account.id, account.usage)) continue;

        void runAutoWarmupForAccount(account.id, account.name);
      }
    };

    checkAutoWarmup();
    const interval = window.setInterval(
      checkAutoWarmup,
      AUTO_WARMUP_CHECK_INTERVAL_MS
    );

    return () => window.clearInterval(interval);
  }, [
    autoWarmupAccountIds.size,
    autoWarmupAllEnabled,
    isAutoWarmupDue,
    runAutoWarmupForAccount,
  ]);

  useEffect(() => {
    const report = quotaReport.latestReport;
    if (!report) return;
    void runAutoSwitchAfterQuotaReport(report);
  }, [quotaReport.latestReport]);

  const handleExportSlimText = async () => {
    setConfigModalMode("slim_export");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);

    try {
      setIsExportingSlim(true);
      const payload = await exportAccountsSlimText();
      setConfigPayload(payload);
      showWarmupToast(`Slim text exported (${accounts.length} accounts).`);
    } catch (err) {
      console.error("Failed to export slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim export failed", true);
    } finally {
      setIsExportingSlim(false);
    }
  };

  const openImportSlimTextModal = () => {
    setConfigModalMode("slim_import");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);
  };

  const handleImportSlimText = async () => {
    if (!configPayload.trim()) {
      setConfigModalError("Please paste the slim text string first.");
      return;
    }

    try {
      setIsImportingSlim(true);
      setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set());
      setIsConfigModalOpen(false);
      showWarmupToast(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`
      );
    } catch (err) {
      console.error("Failed to import slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim import failed", true);
    } finally {
      setIsImportingSlim(false);
    }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      showWarmupToast("Full encrypted file exported.");
    } catch (err) {
      console.error("Failed to export full encrypted file:", err);
      showWarmupToast("Full export failed", true);
    } finally {
      setIsExportingFull(false);
    }
  };

  const handleImportFullFile = async () => {
    try {
      setIsImportingFull(true);
      const summary = await importFullBackupFile();
      if (!summary) return;
      const accountList = await loadAccounts();
      await reloadQuotaAndRecordReport({ accountList });
      const maskedIds = await loadMaskedAccountIds();
      setMaskedAccounts(new Set(maskedIds));
      showWarmupToast(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`
      );
    } catch (err) {
      console.error("Failed to import full encrypted file:", err);
      showWarmupToast("Full import failed", true);
    } finally {
      setIsImportingFull(false);
    }
  };

  /**
   * Triggers a manual quota report reload from the popup.
   *
   * Purpose:
   *   Lets users refresh the popup report immediately without waiting for the three-minute
   *   scheduler.
   * Inputs:
   *   None.
   * Output:
   *   Resolves after the reload attempt finishes.
   * Errors:
   *   Catches reload errors and displays a toast instead of throwing to the modal.
   * Side Effects:
   *   Calls the shared quota reload workflow and updates report state from that same reload
   *   result.
   */
  const handleReloadQuotaReport = async () => {
    try {
      const didReload = await reloadQuotaAndRecordReport({ refreshMetadata: true });
      if (didReload) {
        showWarmupToast("Quota reloaded and report logged.");
      }
    } catch (err) {
      console.error("Failed to reload quota report:", err);
      showWarmupToast(`Quota report reload failed: ${formatWarmupError(err)}`, true);
    }
  };

  /**
   * Exports the latest quota report snapshot.
   *
   * Purpose:
   *   Saves the popup report to a Markdown file using the platform-specific export flow.
   * Inputs:
   *   None.
   * Output:
   *   Resolves after export succeeds, is cancelled, or fails.
   * Errors:
   *   Catches export errors and displays a toast instead of throwing to the modal.
   * Side Effects:
   *   Opens a save/download flow and may write a Markdown file.
   */
  const handleExportQuotaReport = async () => {
    try {
      const exported = await quotaReport.exportLatestReport();
      if (exported) {
        showWarmupToast("Quota report exported.");
      }
    } catch (err) {
      console.error("Failed to export quota report:", err);
      showWarmupToast(`Quota report export failed: ${formatWarmupError(err)}`, true);
    }
  };

  const activeAccount = accounts.find((a) => a.is_active);
  const otherAccounts = accounts.filter((a) => !a.is_active);
  const hasRunningProcesses = processInfo && processInfo.count > 0;

  const sortedOtherAccounts = useMemo(() => {
    const getResetDeadline = (resetAt: number | null | undefined) =>
      resetAt ?? Number.POSITIVE_INFINITY;

    const getSubscriptionDeadline = (expiresAt: string | null | undefined) => {
      if (!expiresAt) return null;
      const timestamp = new Date(expiresAt).getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    };

    const compareOptionalNumber = (
      aValue: number | null,
      bValue: number | null,
      direction: "asc" | "desc"
    ) => {
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return direction === "asc" ? aValue - bValue : bValue - aValue;
    };

    const getRemainingPercent = (usedPercent: number | null | undefined) => {
      if (usedPercent === null || usedPercent === undefined) {
        return Number.NEGATIVE_INFINITY;
      }
      return Math.max(0, 100 - usedPercent);
    };

    return [...otherAccounts].sort((a, b) => {
      if (
        otherAccountsSort === "subscription_asc" ||
        otherAccountsSort === "subscription_desc"
      ) {
        const subscriptionDiff = compareOptionalNumber(
          getSubscriptionDeadline(a.subscription_expires_at),
          getSubscriptionDeadline(b.subscription_expires_at),
          otherAccountsSort === "subscription_asc" ? "asc" : "desc"
        );
        if (subscriptionDiff !== 0) return subscriptionDiff;

        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) return deadlineDiff;

        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) return remainingDiff;

        return a.name.localeCompare(b.name);
      }

      if (otherAccountsSort === "deadline_asc" || otherAccountsSort === "deadline_desc") {
        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) {
          return otherAccountsSort === "deadline_asc" ? deadlineDiff : -deadlineDiff;
        }
        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) return remainingDiff;
        return a.name.localeCompare(b.name);
      }

      const remainingDiff =
        getRemainingPercent(b.usage?.primary_used_percent) -
        getRemainingPercent(a.usage?.primary_used_percent);
      if (otherAccountsSort === "remaining_desc" && remainingDiff !== 0) {
        return remainingDiff;
      }
      if (otherAccountsSort === "remaining_asc" && remainingDiff !== 0) {
        return -remainingDiff;
      }
      const deadlineDiff =
        getResetDeadline(a.usage?.primary_resets_at) -
        getResetDeadline(b.usage?.primary_resets_at);
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.name.localeCompare(b.name);
    });
  }, [otherAccounts, otherAccountsSort]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="flex h-9 items-center bg-white px-3 dark:bg-gray-900">
          <div
            onMouseDown={handleTitlebarDrag}
            onDoubleClick={handleTitlebarDoubleClick}
            className={`h-full flex-1 select-none cursor-default ${isMacOs ? "ml-18 mr-2" : "mr-3"}`}
          />
          {!isMacOs && appWindow && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  void appWindow.minimize();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                title="Minimize"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M5 12h14" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
              <button
                onClick={() => {
                  void appWindow.toggleMaximize();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                title={isWindowMaximized ? "Restore" : "Maximize"}
              >
                {isWindowMaximized ? (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M9 9h10v10H9z" strokeWidth="2" />
                    <path d="M5 15V5h10" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <rect x="5" y="5" width="14" height="14" strokeWidth="2" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => {
                  void appWindow.close();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-red-500 hover:text-white dark:text-gray-400 dark:hover:bg-red-500 dark:hover:text-white"
                title="Close"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M6 6l12 12M18 6L6 18" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_max-content] md:items-center md:gap-4">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <img
                src="/app-icon.png"
                alt="Codex Switcher"
                className="h-10 w-10 rounded-xl shadow-sm"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
                    Codex Switcher
                  </h1>
                  {processInfo && (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border ${hasRunningProcesses
                          ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700"
                          : "bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700"
                        }`}
                    >
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${hasRunningProcesses ? "bg-amber-500" : "bg-green-500"
                          }`}
                      ></span>
                      <span>
                        {hasRunningProcesses
                          ? `${processInfo.count} Codex running`
                          : "0 Codex running"}
                      </span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Multi-account manager for Codex CLI
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0 md:ml-4 md:w-max md:flex-nowrap md:justify-end">
              <button
                onClick={toggleMaskAll}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 shrink-0"
                title={allMasked ? "Show all account names and emails" : "Hide all account names and emails"}
              >
                {allMasked ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                    />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 shrink-0"
                title={isRefreshing ? "Refreshing all usage" : "Refresh all usage"}
              >
                <span className={isRefreshing ? "animate-spin inline-block" : ""}>↻</span>
              </button>
              <button
                onClick={handleWarmupAll}
                disabled={isWarmingAll || accounts.length === 0}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 shrink-0"
                title="Send minimal traffic using all accounts"
              >
                <span className={isWarmingAll ? "animate-pulse" : ""}>⚡</span>
              </button>
              <button
                onClick={() => setAutoWarmupAllEnabled((prev) => !prev)}
                disabled={accounts.length === 0}
                className={`flex h-10 items-center justify-center rounded-lg px-3 text-xs font-semibold transition-colors disabled:opacity-50 shrink-0 whitespace-nowrap ${
                  autoWarmupAllEnabled
                    ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                }`}
                title={
                  autoWarmupAllEnabled
                    ? "Disable auto warm-up for all accounts"
                    : "Enable auto warm-up for all accounts"
                }
              >
                {headerAutoWarmupLabel}
              </button>
              <button
                onClick={() => setIsQuotaReportOpen(true)}
                className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors shrink-0 ${
                  isQuotaReportOpen
                    ? "bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                }`}
                title="Open quota report"
                aria-label="Open quota report"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 19V5" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 19h16" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16v-5" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V8" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 16v-7" />
                </svg>
              </button>
              <button
                onClick={() => setThemeMode((prev) => (prev === "dark" ? "light" : "dark"))}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-lg text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 shrink-0"
                title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {themeMode === "dark" ? "☀" : "☾"}
              </button>

              <div className="relative" ref={actionsMenuRef}>
                <button
                  onClick={() => setIsActionsMenuOpen((prev) => !prev)}
                  className="h-10 px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white transition-colors hover:bg-gray-800 dark:bg-black dark:hover:bg-neutral-900 shrink-0 whitespace-nowrap"
                >
                  Account ▾
                </button>
                {isActionsMenuOpen && (
                  <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-gray-200 bg-white p-2 text-gray-700 shadow-xl dark:border-neutral-800 dark:bg-black dark:text-white">
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        setIsAddModalOpen(true);
                      }}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 dark:text-white dark:hover:bg-neutral-900"
                    >
                      + Add Account
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        void handleExportSlimText();
                      }}
                      disabled={isExportingSlim}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-white dark:hover:bg-neutral-900"
                    >
                      {isExportingSlim ? "Exporting..." : "Export Slim Text"}
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        openImportSlimTextModal();
                      }}
                      disabled={isImportingSlim}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-white dark:hover:bg-neutral-900"
                    >
                      {isImportingSlim ? "Importing..." : "Import Slim Text"}
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        void handleExportFullFile();
                      }}
                      disabled={isExportingFull}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-white dark:hover:bg-neutral-900"
                    >
                      {isExportingFull ? "Exporting..." : "Export Full Encrypted File"}
                    </button>
                    <button
                      onClick={() => {
                        setIsActionsMenuOpen(false);
                        void handleImportFullFile();
                      }}
                      disabled={isImportingFull}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-white dark:hover:bg-neutral-900"
                    >
                      {isImportingFull ? "Importing..." : "Import Full Encrypted File"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-6 py-8">
        {loading && accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="animate-spin h-10 w-10 border-2 border-gray-900 dark:border-gray-100 border-t-transparent rounded-full mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">Loading accounts...</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <div className="text-red-600 dark:text-red-300 mb-2">Failed to load accounts</div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{error}</p>
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-20">
            <div className="h-16 w-16 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">👤</span>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              No accounts yet
            </h2>
            <p className="text-gray-500 dark:text-gray-400 mb-6">
              Add your first Codex account to get started
            </p>
            <button
              onClick={() => setIsAddModalOpen(true)}
              className="px-6 py-3 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors"
            >
              Add Account
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Active Account */}
            {activeAccount && (
              <section>
                <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">
                  Active Account
                </h2>
                <AccountCard
                  account={activeAccount}
                  onSwitch={() => { }}
                  onWarmup={() =>
                    handleWarmupAccount(activeAccount.id, activeAccount.name)
                  }
                  onDelete={() => handleDelete(activeAccount.id)}
                  onRefresh={() =>
                    refreshSingleUsage(activeAccount.id, { refreshMetadata: true })
                  }
                  onRename={(newName) => renameAccount(activeAccount.id, newName)}
                  switching={switchingId === activeAccount.id}
                  switchDisabled={hasRunningProcesses ?? false}
                  warmingUp={
                    isWarmingAll ||
                    warmingUpId === activeAccount.id ||
                    autoWarmupRunningIds.has(activeAccount.id)
                  }
                  masked={maskedAccounts.has(activeAccount.id)}
                  onToggleMask={() => toggleMask(activeAccount.id)}
                  autoWarmupEnabled={
                    autoWarmupAllEnabled || autoWarmupAccountIds.has(activeAccount.id)
                  }
                  autoWarmupManagedByAll={autoWarmupAllEnabled}
                  autoWarmupLabel={getAutoWarmupLabel(
                    activeAccount.usage,
                    autoWarmupAllEnabled || autoWarmupAccountIds.has(activeAccount.id),
                    autoWarmupRunningIds.has(activeAccount.id)
                  )}
                  onToggleAutoWarmup={() => toggleAutoWarmupAccount(activeAccount.id)}
                  priorityQuotaEnabled={priorityQuotaAccountIds.has(activeAccount.id)}
                  onTogglePriorityQuota={() => togglePriorityQuotaAccount(activeAccount.id)}
                />
              </section>
            )}

            {/* Other Accounts */}
            {otherAccounts.length > 0 && (
              <section>
                <div className="flex items-center justify-between gap-3 mb-4">
                  <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Other Accounts ({otherAccounts.length})
                  </h2>
                  <div className="flex items-center gap-2">
                    <label htmlFor="other-accounts-sort" className="text-xs text-gray-500 dark:text-gray-400">
                      Sort
                    </label>
                    <div className="relative">
                      <select
                        id="other-accounts-sort"
                        value={otherAccountsSort}
                        onChange={(e) =>
                          setOtherAccountsSort(
                            e.target.value as
                              | "deadline_asc"
                              | "deadline_desc"
                              | "remaining_desc"
                              | "remaining_asc"
                              | "subscription_asc"
                              | "subscription_desc"
                          )
                        }
                        className="appearance-none font-sans text-xs sm:text-sm font-medium pl-3 pr-9 py-2 rounded-xl border border-gray-300 dark:border-gray-700 bg-gradient-to-b from-white to-gray-50 dark:from-gray-900 dark:to-gray-800 text-gray-700 dark:text-gray-200 shadow-sm hover:border-gray-400 dark:hover:border-gray-600 hover:shadow focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-gray-600 focus:border-gray-400 dark:focus:border-gray-600 transition-all"
                      >
                        <option value="deadline_asc">Reset: earliest to latest</option>
                        <option value="deadline_desc">Reset: latest to earliest</option>
                        <option value="remaining_desc">
                          % remaining: highest to lowest
                        </option>
                        <option value="remaining_asc">
                          % remaining: lowest to highest
                        </option>
                        <option value="subscription_asc">
                          Expiry: earliest to latest
                        </option>
                        <option value="subscription_desc">
                          Expiry: latest to earliest
                        </option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-gray-500 dark:text-gray-400">
                        <svg
                          className="h-4 w-4"
                          viewBox="0 0 20 20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {sortedOtherAccounts.map((account) => (
                    <AccountCard
                      key={account.id}
                      account={account}
                      onSwitch={() => handleSwitch(account.id)}
                      onWarmup={() => handleWarmupAccount(account.id, account.name)}
                      onDelete={() => handleDelete(account.id)}
                      onRefresh={() =>
                        refreshSingleUsage(account.id, { refreshMetadata: true })
                      }
                      onRename={(newName) => renameAccount(account.id, newName)}
                      switching={switchingId === account.id}
                      switchDisabled={hasRunningProcesses ?? false}
                      warmingUp={
                        isWarmingAll ||
                        warmingUpId === account.id ||
                        autoWarmupRunningIds.has(account.id)
                      }
                      masked={maskedAccounts.has(account.id)}
                      onToggleMask={() => toggleMask(account.id)}
                      autoWarmupEnabled={
                        autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id)
                      }
                      autoWarmupManagedByAll={autoWarmupAllEnabled}
                      autoWarmupLabel={getAutoWarmupLabel(
                        account.usage,
                        autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id),
                        autoWarmupRunningIds.has(account.id)
                      )}
                      onToggleAutoWarmup={() => toggleAutoWarmupAccount(account.id)}
                      priorityQuotaEnabled={priorityQuotaAccountIds.has(account.id)}
                      onTogglePriorityQuota={() => togglePriorityQuotaAccount(account.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Refresh Success Toast */}
      {refreshSuccess && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-3 bg-green-600 text-white rounded-lg shadow-lg text-sm flex items-center gap-2">
          <span>✓</span> Usage refreshed successfully
        </div>
      )}

      {/* Warm-up Toast */}
      {warmupToast && (
        <div
          className={`fixed bottom-20 left-1/2 -translate-x-1/2 px-4 py-3 rounded-lg shadow-lg text-sm ${
            warmupToast.isError
              ? "bg-red-600 text-white"
              : "bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700"
          }`}
        >
          {warmupToast.message}
        </div>
      )}

      {/* Delete Confirmation Toast */}
      {deleteConfirmId && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-3 bg-red-600 text-white rounded-lg shadow-lg text-sm">
          Click delete again to confirm removal
        </div>
      )}

      {/* Add Account Modal */}
      <AddAccountModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
      />

      <QuotaReportModal
        isOpen={isQuotaReportOpen}
        reports={quotaReport.reports}
        latestReport={quotaReport.latestReport}
        isReloading={isRefreshing}
        lastError={quotaReport.lastError}
        nextReloadAt={quotaReport.nextReloadAt}
        onClose={() => setIsQuotaReportOpen(false)}
        onReloadNow={handleReloadQuotaReport}
        onExport={handleExportQuotaReport}
        onClearReports={quotaReport.clearReports}
      />

      {/* Import/Export Config Modal */}
      {isConfigModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-2xl mx-4 shadow-xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-800">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {configModalMode === "slim_export" ? "Export Slim Text" : "Import Slim Text"}
              </h2>
              <button
                onClick={() => setIsConfigModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-4">
              {configModalMode === "slim_import" ? (
                <p className="text-sm text-amber-700 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg px-3 py-2">
                  Existing accounts are kept. Only missing accounts are imported.
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  This slim string contains account secrets. Keep it private.
                </p>
              )}
              <textarea
                value={configPayload}
                onChange={(e) => setConfigPayload(e.target.value)}
                readOnly={configModalMode === "slim_export"}
                placeholder={
                  configModalMode === "slim_export"
                    ? isExportingSlim
                      ? "Generating..."
                      : "Export string will appear here"
                    : "Paste config string here"
                }
                className="w-full h-48 px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-gray-500 focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 font-mono"
              />
              {configModalError && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-600 dark:text-red-300 text-sm">
                  {configModalError}
                </div>
              )}
            </div>
            <div className="flex gap-3 p-5 border-t border-gray-100 dark:border-gray-800">
              <button
                onClick={() => setIsConfigModalOpen(false)}
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 transition-colors"
              >
                Close
              </button>
              {configModalMode === "slim_export" ? (
                <button
                  onClick={async () => {
                    if (!configPayload) return;
                    try {
                      await navigator.clipboard.writeText(configPayload);
                      setConfigCopied(true);
                      setTimeout(() => setConfigCopied(false), 1500);
                    } catch {
                      setConfigModalError("Clipboard unavailable. Please copy manually.");
                    }
                  }}
                  disabled={!configPayload || isExportingSlim}
                  className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors disabled:opacity-50"
                >
                  {configCopied ? "Copied" : "Copy String"}
                </button>
              ) : (
                <button
                  onClick={handleImportSlimText}
                  disabled={isImportingSlim}
                  className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors disabled:opacity-50"
                >
                  {isImportingSlim ? "Importing..." : "Import Missing Accounts"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <UpdateChecker />

    </div>
  );
}

export default App;
