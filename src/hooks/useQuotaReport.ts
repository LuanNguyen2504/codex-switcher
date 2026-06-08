import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountWithUsage, UsageInfo } from "../types";
import type { RefreshUsageSummary } from "./useAccounts";
import { exportQuotaReportFile } from "../lib/platform";

/**
 * Three-minute interval used by the automatic quota report scheduler.
 */
export const QUOTA_REPORT_RELOAD_INTERVAL_MS = 3 * 60 * 1000;

const QUOTA_REPORT_LOG_LIMIT = 10;
const QUOTA_REPORT_STORAGE_KEY = "codex-switcher-quota-report-history";

/**
 * Per-account quota status recorded inside a quota report snapshot.
 */
export type QuotaReportRowStatus = "fresh" | "stale" | "failed" | "missing";

/**
 * Per-account row shown in the quota report popup and exported report.
 *
 * @property accountId - Stable account identifier from local account storage.
 * @property accountName - Display name configured for the account.
 * @property email - Account email when known, otherwise `null`.
 * @property planType - Account plan label when known, otherwise `null`.
 * @property status - Whether the row contains fresh, stale, failed, or missing quota data.
 * @property error - Latest account-specific reload error when one occurred.
 * @property primaryUsedPercent - Primary quota used percentage, or `null` when unavailable.
 * @property primaryWindowMinutes - Primary quota window length in minutes, or `null`.
 * @property primaryResetsAt - Primary quota reset timestamp in Unix seconds, or `null`.
 * @property secondaryUsedPercent - Secondary quota used percentage, or `null` when unavailable.
 * @property secondaryWindowMinutes - Secondary quota window length in minutes, or `null`.
 * @property secondaryResetsAt - Secondary quota reset timestamp in Unix seconds, or `null`.
 * @property hasCredits - Whether the account has credit access when reported, otherwise `null`.
 * @property unlimitedCredits - Whether the account has unlimited credits when reported, otherwise
 * `null`.
 * @property creditsBalance - Credit balance string when the API reports it, otherwise `null`.
 */
export interface QuotaReportRow {
  accountId: string;
  accountName: string;
  email: string | null;
  planType: string | null;
  status: QuotaReportRowStatus;
  error: string | null;
  primaryUsedPercent: number | null;
  primaryWindowMinutes: number | null;
  primaryResetsAt: number | null;
  secondaryUsedPercent: number | null;
  secondaryWindowMinutes: number | null;
  secondaryResetsAt: number | null;
  hasCredits: boolean | null;
  unlimitedCredits: boolean | null;
  creditsBalance: string | null;
}

/**
 * Snapshot produced by one scheduled quota reload.
 *
 * @property id - Unique client-side identifier for the report snapshot.
 * @property startedAt - Unix timestamp in milliseconds when the reload started.
 * @property completedAt - Unix timestamp in milliseconds when the reload finished.
 * @property totalAccounts - Number of accounts included in the report.
 * @property freshAccounts - Number of accounts with fresh quota data from this run.
 * @property staleAccounts - Number of failed accounts that kept a previous quota snapshot.
 * @property failedAccounts - Number of accounts that failed without usable previous quota.
 * @property rows - Per-account quota report rows.
 */
export interface QuotaReportEntry {
  id: string;
  startedAt: number;
  completedAt: number;
  totalAccounts: number;
  freshAccounts: number;
  staleAccounts: number;
  failedAccounts: number;
  rows: QuotaReportRow[];
}

/**
 * Options for the automatic quota report hook.
 *
 * @property accounts - Required latest account list including any currently displayed quota.
 */
export interface UseQuotaReportOptions {
  accounts: AccountWithUsage[];
}

/**
 * Result returned by the automatic quota report hook.
 *
 * @property reports - Most recent quota report snapshots, newest first, capped to ten entries.
 * @property latestReport - Newest report snapshot, or `null` before the first completed run.
 * @property lastError - Last scheduler-level error, or `null` when the last run completed.
 * @property nextReloadAt - Unix timestamp in milliseconds for the next automatic reload, or `null`
 * when no accounts are available.
 * @property recordReload - Records a report snapshot from an already completed quota reload.
 * @property recordReloadError - Records a scheduler-level reload error without making a backend
 * call.
 * @property setNextReloadAt - Stores the next automatic reload timestamp controlled by the app.
 * @property clearReports - Clears all retained quota report snapshots.
 * @property exportLatestReport - Exports the newest report snapshot as a Markdown file.
 */
export interface UseQuotaReportResult {
  reports: QuotaReportEntry[];
  latestReport: QuotaReportEntry | null;
  lastError: string | null;
  nextReloadAt: number | null;
  recordReload: (
    accountList: AccountWithUsage[] | undefined,
    summary: RefreshUsageSummary,
    startedAt: number,
    completedAt: number
  ) => QuotaReportEntry | null;
  recordReloadError: (error: unknown) => void;
  setNextReloadAt: (timestamp: number | null) => void;
  clearReports: () => void;
  exportLatestReport: () => Promise<boolean>;
}

/**
 * Reads persisted quota report snapshots from browser storage.
 *
 * Purpose:
 *   Restores report history after the app restarts so old quota and auth-loss evidence remains
 *   available.
 * Inputs:
 *   None.
 * Output:
 *   Returns up to `QUOTA_REPORT_LOG_LIMIT` valid `QuotaReportEntry` objects, newest first.
 * Errors:
 *   Swallows storage or JSON errors and returns an empty history.
 * Side Effects:
 *   Reads from `window.localStorage` when available.
 */
function readStoredQuotaReports(): QuotaReportEntry[] {
  if (typeof window === "undefined") return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(QUOTA_REPORT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isQuotaReportEntry)
      .slice(0, QUOTA_REPORT_LOG_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Persists quota report snapshots to browser storage.
 *
 * Purpose:
 *   Keeps report history available across app restarts while respecting the configured retention
 *   limit.
 * Inputs:
 *   reports - Required newest-first report snapshots to persist.
 * Output:
 *   Returns nothing.
 * Errors:
 *   Ignores storage failures so quota reloads are not blocked by persistence issues.
 * Side Effects:
 *   Writes to `window.localStorage` when available.
 */
function writeStoredQuotaReports(reports: QuotaReportEntry[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      QUOTA_REPORT_STORAGE_KEY,
      JSON.stringify(reports.slice(0, QUOTA_REPORT_LOG_LIMIT))
    );
  } catch {
    // Ignore storage errors; in-memory report history still works for the current session.
  }
}

/**
 * Validates an unknown value as a quota report snapshot.
 *
 * Purpose:
 *   Prevents malformed stored data from entering report history after app restart.
 * Inputs:
 *   value - Required unknown value read from storage.
 * Output:
 *   Returns `true` when the value has the minimum report shape needed by the UI.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function isQuotaReportEntry(value: unknown): value is QuotaReportEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<QuotaReportEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.startedAt === "number" &&
    typeof entry.completedAt === "number" &&
    typeof entry.totalAccounts === "number" &&
    typeof entry.freshAccounts === "number" &&
    typeof entry.staleAccounts === "number" &&
    typeof entry.failedAccounts === "number" &&
    Array.isArray(entry.rows)
  );
}

/**
 * Records popup-ready report snapshots from the app's shared quota reload mechanism.
 *
 * Purpose:
 *   Keeps a per-account quota report current without starting a second quota reload path.
 * Inputs:
 *   options - Required object containing the latest account list.
 * Output:
 *   Returns report state, next schedule time, snapshot recording helpers, and export actions.
 * Errors:
 *   Captures scheduler-level reload/export errors in `lastError`; export may still reject if the
 *   caller needs to handle failures differently.
 * Side Effects:
 *   Writes report snapshots to React state, records console logs, and may open a save/download
 *   flow when exporting.
 */
export function useQuotaReport({ accounts }: UseQuotaReportOptions): UseQuotaReportResult {
  const [reports, setReports] = useState<QuotaReportEntry[]>(() => readStoredQuotaReports());
  const [lastError, setLastError] = useState<string | null>(null);
  const [nextReloadAt, setNextReloadAt] = useState<number | null>(null);
  const accountsRef = useRef(accounts);
  const lastUsableUsageByAccountIdRef = useRef<Record<string, UsageInfo>>({});

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    seedLastUsableUsageCacheFromReports(lastUsableUsageByAccountIdRef.current, reports);
  }, []);

  const recordReload = useCallback(
    (
      accountList: AccountWithUsage[] | undefined,
      summary: RefreshUsageSummary,
      startedAt: number,
      completedAt: number
    ) => {
      const targetAccounts = accountList?.length ? accountList : accountsRef.current;
      if (targetAccounts.length === 0) {
        setNextReloadAt(null);
        return null;
      }

      updateLastUsableUsageCache(
        lastUsableUsageByAccountIdRef.current,
        targetAccounts,
        summary
      );
      const entry = buildQuotaReportEntry(
        targetAccounts,
        summary,
        startedAt,
        completedAt,
        lastUsableUsageByAccountIdRef.current
      );
      setReports((prev) => {
        const next = [entry, ...prev].slice(0, QUOTA_REPORT_LOG_LIMIT);
        writeStoredQuotaReports(next);
        return next;
      });
      setLastError(null);
      setNextReloadAt(Date.now() + QUOTA_REPORT_RELOAD_INTERVAL_MS);
      console.info(
        `[Quota] report ${new Date(entry.completedAt).toISOString()} fresh=${entry.freshAccounts} stale=${entry.staleAccounts} failed=${entry.failedAccounts}`
      );
      return entry;
    },
    []
  );

  const recordReloadError = useCallback((error: unknown) => {
    const message = formatUnknownError(error);
    setLastError(message);
    setNextReloadAt(Date.now() + QUOTA_REPORT_RELOAD_INTERVAL_MS);
    console.error("[Quota] shared quota reload failed:", error);
  }, []);

  useEffect(() => {
    if (accounts.length === 0) {
      setNextReloadAt(null);
      return undefined;
    }
    setNextReloadAt((prev) => prev ?? Date.now() + QUOTA_REPORT_RELOAD_INTERVAL_MS);
    return undefined;
  }, [accounts.length]);

  const latestReport = reports[0] ?? null;

  const exportLatestReport = useCallback(async () => {
    const report = reports[0] ?? buildCurrentQuotaReport(accountsRef.current);
    if (!report) return false;

    return exportQuotaReportFile(renderQuotaReportMarkdown(report));
  }, [reports]);

  /**
   * Clears all retained quota report snapshots.
   *
   * Purpose:
   *   Lets users reset the visible report log without affecting account quota state.
   * Inputs:
   *   None.
   * Output:
   *   Returns nothing.
   * Errors:
   *   Does not throw.
   * Side Effects:
   *   Mutates report state by dropping all retained snapshots.
   */
  const clearReports = useCallback(() => {
    setReports([]);
    writeStoredQuotaReports([]);
  }, []);

  return useMemo(
    () => ({
      reports,
      latestReport,
      lastError,
      nextReloadAt,
      recordReload,
      recordReloadError,
      setNextReloadAt,
      clearReports,
      exportLatestReport,
    }),
    [
      clearReports,
      exportLatestReport,
      lastError,
      latestReport,
      nextReloadAt,
      recordReload,
      recordReloadError,
      reports,
    ]
  );
}

/**
 * Builds a report snapshot from the current account list and reload summary.
 *
 * Purpose:
 *   Combines fresh quota results with previous quota snapshots for failed accounts.
 * Inputs:
 *   accounts - Required account list targeted by the reload.
 *   summary - Required reload result containing fresh quota and account-specific failures.
 *   startedAt - Required Unix timestamp in milliseconds marking reload start time.
 *   completedAt - Required Unix timestamp in milliseconds marking reload completion time.
 * Output:
 *   Returns a `QuotaReportEntry` with one row for each targeted account.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildQuotaReportEntry(
  accounts: AccountWithUsage[],
  summary: RefreshUsageSummary,
  startedAt: number,
  completedAt: number,
  lastUsableUsageByAccountId: Record<string, UsageInfo>
): QuotaReportEntry {
  const rows = accounts.map((account) => {
    const freshUsage = summary.usageByAccountId[account.id];
    const error = summary.errorsByAccountId[account.id] ?? null;
    const fallbackUsage = selectQuotaReportUsage(
      freshUsage,
      account.usage,
      lastUsableUsageByAccountId[account.id]
    );
    return buildQuotaReportRow(account, fallbackUsage, freshUsage, error);
  });

  return {
    id: `${completedAt}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    completedAt,
    totalAccounts: rows.length,
    freshAccounts: rows.filter((row) => row.status === "fresh").length,
    staleAccounts: rows.filter((row) => row.status === "stale").length,
    failedAccounts: rows.filter((row) => row.status === "failed").length,
    rows,
  };
}

/**
 * Builds a report snapshot from currently displayed quota without making a network request.
 *
 * Purpose:
 *   Allows export before the first scheduled run has completed.
 * Inputs:
 *   accounts - Required latest account list from the UI.
 * Output:
 *   Returns a `QuotaReportEntry` when at least one account exists, otherwise `null`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildCurrentQuotaReport(accounts: AccountWithUsage[]): QuotaReportEntry | null {
  if (accounts.length === 0) return null;

  const now = Date.now();
  const rows = accounts.map((account) =>
    buildQuotaReportRow(account, account.usage, account.usage, account.usage?.error ?? null)
  );

  return {
    id: `${now}-current`,
    startedAt: now,
    completedAt: now,
    totalAccounts: rows.length,
    freshAccounts: rows.filter((row) => row.status === "fresh").length,
    staleAccounts: rows.filter((row) => row.status === "stale").length,
    failedAccounts: rows.filter((row) => row.status === "failed").length,
    rows,
  };
}

/**
 * Converts one account and usage payload into a quota report row.
 *
 * Purpose:
 *   Normalizes fresh, stale, missing, and failed quota states for popup display and export.
 * Inputs:
 *   account - Required account whose quota should be represented.
 *   usage - Optional quota payload to display; pass `undefined` when no quota is available.
 *   freshUsage - Optional quota payload returned by the current reload; rows with this value are
 *   marked fresh unless it contains an error.
 *   error - Optional reload error associated with the account.
 * Output:
 *   Returns a `QuotaReportRow` with normalized nullable quota fields and status.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildQuotaReportRow(
  account: AccountWithUsage,
  usage: UsageInfo | undefined,
  freshUsage: UsageInfo | undefined,
  error: string | null
): QuotaReportRow {
  const status = getQuotaReportRowStatus(usage, freshUsage, error);

  return {
    accountId: account.id,
    accountName: account.name,
    email: account.email,
    planType: usage?.plan_type ?? account.plan_type,
    status,
    error: error ?? usage?.error ?? null,
    primaryUsedPercent: usage?.primary_used_percent ?? null,
    primaryWindowMinutes: usage?.primary_window_minutes ?? null,
    primaryResetsAt: usage?.primary_resets_at ?? null,
    secondaryUsedPercent: usage?.secondary_used_percent ?? null,
    secondaryWindowMinutes: usage?.secondary_window_minutes ?? null,
    secondaryResetsAt: usage?.secondary_resets_at ?? null,
    hasCredits: usage?.has_credits ?? null,
    unlimitedCredits: usage?.unlimited_credits ?? null,
    creditsBalance: usage?.credits_balance ?? null,
  };
}

/**
 * Updates the long-lived report fallback cache with usable quota snapshots.
 *
 * Purpose:
 *   Keeps the last known good quota for each account even if many later scheduled reloads fail.
 * Inputs:
 *   cache - Required mutable map from account ID to last usable quota payload.
 *   accounts - Required accounts included in the current reload run.
 *   summary - Required reload summary containing fresh quota results and failures.
 * Output:
 *   Returns nothing.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   Mutates `cache` by replacing entries with fresh or currently displayed usable quota and
 *   deleting entries for accounts no longer present.
 */
function updateLastUsableUsageCache(
  cache: Record<string, UsageInfo>,
  accounts: AccountWithUsage[],
  summary: RefreshUsageSummary
): void {
  const validAccountIds = new Set(accounts.map((account) => account.id));

  for (const accountId of Object.keys(cache)) {
    if (!validAccountIds.has(accountId)) {
      delete cache[accountId];
    }
  }

  for (const account of accounts) {
    const freshUsage = summary.usageByAccountId[account.id];
    if (isUsableQuotaUsage(freshUsage)) {
      cache[account.id] = freshUsage;
      continue;
    }

    if (isUsableQuotaUsage(account.usage)) {
      cache[account.id] = account.usage;
    }
  }
}

/**
 * Seeds the fallback quota cache from persisted report history.
 *
 * Purpose:
 *   Restores the last known usable quota after app restart, including for accounts that later lose
 *   authentication and can no longer reload quota.
 * Inputs:
 *   cache - Required mutable cache from account ID to last usable quota payload.
 *   reports - Required newest-first persisted report snapshots.
 * Output:
 *   Returns nothing.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   Mutates `cache` with the first usable row found for each account.
 */
function seedLastUsableUsageCacheFromReports(
  cache: Record<string, UsageInfo>,
  reports: QuotaReportEntry[]
): void {
  for (const report of reports) {
    for (const row of report.rows) {
      if (cache[row.accountId]) continue;
      const usage = buildUsageInfoFromReportRow(row);
      if (isUsableQuotaUsage(usage)) {
        cache[row.accountId] = usage;
      }
    }
  }
}

/**
 * Converts a persisted report row into a usage payload for fallback cache use.
 *
 * Purpose:
 *   Preserves all quota fields retained in history so later failed reloads can continue to display
 *   the last known quota and reset times.
 * Inputs:
 *   row - Required persisted quota report row.
 * Output:
 *   Returns a `UsageInfo` object containing the row's quota, reset, credit, and error fields.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildUsageInfoFromReportRow(row: QuotaReportRow): UsageInfo {
  return {
    account_id: row.accountId,
    plan_type: row.planType,
    primary_used_percent: row.primaryUsedPercent,
    primary_window_minutes: row.primaryWindowMinutes,
    primary_resets_at: row.primaryResetsAt,
    secondary_used_percent: row.secondaryUsedPercent,
    secondary_window_minutes: row.secondaryWindowMinutes,
    secondary_resets_at: row.secondaryResetsAt,
    has_credits: row.hasCredits ?? null,
    unlimited_credits: row.unlimitedCredits ?? null,
    credits_balance: row.creditsBalance,
    error:
      row.primaryUsedPercent === null && row.secondaryUsedPercent === null ? row.error : null,
  };
}

/**
 * Selects the quota payload that should be displayed in a report row.
 *
 * Purpose:
 *   Prefers fresh quota, then current usable account quota, then the long-lived cached quota for
 *   accounts whose latest reload failed.
 * Inputs:
 *   freshUsage - Optional quota returned by the current reload.
 *   currentUsage - Optional quota currently attached to the account in UI state.
 *   cachedUsage - Optional last usable quota remembered from any previous report run.
 * Output:
 *   Returns the best usable `UsageInfo`, or the current/fresh error payload when no usable quota
 *   exists.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function selectQuotaReportUsage(
  freshUsage: UsageInfo | undefined,
  currentUsage: UsageInfo | undefined,
  cachedUsage: UsageInfo | undefined
): UsageInfo | undefined {
  if (isUsableQuotaUsage(freshUsage)) return freshUsage;
  if (isUsableQuotaUsage(currentUsage)) return currentUsage;
  if (isUsableQuotaUsage(cachedUsage)) return cachedUsage;
  return freshUsage ?? currentUsage;
}

/**
 * Checks whether a quota payload can be used as a fallback snapshot.
 *
 * Purpose:
 *   Prevents error-only quota payloads from replacing older good quota in report snapshots.
 * Inputs:
 *   usage - Optional quota payload to validate.
 * Output:
 *   Returns `true` when the payload exists and does not contain an error string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function isUsableQuotaUsage(usage: UsageInfo | undefined): usage is UsageInfo {
  return Boolean(usage && !usage.error);
}

/**
 * Determines the report status for a quota row.
 *
 * Purpose:
 *   Separates fresh results from stale preserved quota and accounts with no usable quota.
 * Inputs:
 *   usage - Optional quota payload currently available for the account.
 *   freshUsage - Optional quota payload returned by the current reload.
 *   error - Optional account-specific reload error.
 * Output:
 *   Returns a `QuotaReportRowStatus` value.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function getQuotaReportRowStatus(
  usage: UsageInfo | undefined,
  freshUsage: UsageInfo | undefined,
  error: string | null
): QuotaReportRowStatus {
  if (freshUsage && !freshUsage.error) return "fresh";
  if (error && usage && !usage.error) return "stale";
  if (error || usage?.error) return "failed";
  return usage ? "fresh" : "missing";
}

/**
 * Renders a quota report snapshot as Markdown for file export.
 *
 * Purpose:
 *   Produces a readable text report that can be saved outside the application.
 * Inputs:
 *   report - Required report snapshot to render.
 * Output:
 *   Returns Markdown text containing summary counts and per-account quota rows.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function renderQuotaReportMarkdown(report: QuotaReportEntry): string {
  const lines = [
    "# Codex Switcher Quota Report",
    "",
    `Generated: ${formatDateTime(report.completedAt)}`,
    `Accounts: ${report.totalAccounts}`,
    `Fresh: ${report.freshAccounts}`,
    `Stale: ${report.staleAccounts}`,
    `Failed: ${report.failedAccounts}`,
    "",
    "| Account | Email | Plan | Status | 5h Used | 5h Reset | Weekly Used | Weekly Reset | Has Credits | Unlimited Credits | Credits Balance | Error |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.rows.map((row) =>
      `| ${[
        escapeMarkdownCell(row.accountName),
        escapeMarkdownCell(row.email ?? ""),
        escapeMarkdownCell(row.planType ?? ""),
        row.status,
        formatPercent(row.primaryUsedPercent),
        formatTimestamp(row.primaryResetsAt),
        formatPercent(row.secondaryUsedPercent),
        formatTimestamp(row.secondaryResetsAt),
        formatNullableBoolean(row.hasCredits),
        formatNullableBoolean(row.unlimitedCredits),
        escapeMarkdownCell(row.creditsBalance ?? ""),
        escapeMarkdownCell(row.error ?? ""),
      ].join(" | ")} |`
    ),
    "",
  ];

  return lines.join("\n");
}

/**
 * Formats an unknown thrown value as a readable error string.
 *
 * Purpose:
 *   Converts JavaScript thrown values into stable popup/log messages.
 * Inputs:
 *   value - Required thrown value from a catch block.
 * Output:
 *   Returns a non-empty string describing the error.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatUnknownError(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value) return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}

/**
 * Formats a millisecond timestamp for human-readable report text.
 *
 * Purpose:
 *   Displays report creation times consistently in the user's locale.
 * Inputs:
 *   timestamp - Required Unix timestamp in milliseconds.
 * Output:
 *   Returns a locale-formatted date and time string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Formats a Unix-second quota reset timestamp for report rows.
 *
 * Purpose:
 *   Converts backend reset timestamps into readable local date/time values.
 * Inputs:
 *   timestampSeconds - Required reset timestamp in Unix seconds, or `null` when unavailable.
 * Output:
 *   Returns a locale-formatted date/time string, or an empty string for `null`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatTimestamp(timestampSeconds: number | null): string {
  return timestampSeconds ? new Date(timestampSeconds * 1000).toLocaleString() : "";
}

/**
 * Formats a quota used percentage for report rows.
 *
 * Purpose:
 *   Normalizes nullable percentage values for popup export text.
 * Inputs:
 *   value - Required percentage value, or `null` when unavailable.
 * Output:
 *   Returns a percentage string with one decimal place, or an empty string for `null`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatPercent(value: number | null): string {
  return value === null ? "" : `${value.toFixed(1)}%`;
}

/**
 * Formats a nullable boolean value for report export.
 *
 * Purpose:
 *   Preserves credit-related boolean fields in Markdown output without inventing values for
 *   unavailable data.
 * Inputs:
 *   value - Required boolean value, or `null` when unavailable.
 * Output:
 *   Returns `true`, `false`, or an empty string for unavailable values.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatNullableBoolean(value: boolean | null): string {
  if (value === null) return "";
  return value ? "true" : "false";
}

/**
 * Escapes Markdown table cell delimiters.
 *
 * Purpose:
 *   Prevents account names, emails, or errors from breaking the exported report table.
 * Inputs:
 *   value - Required text value for one table cell.
 * Output:
 *   Returns the escaped cell text.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
