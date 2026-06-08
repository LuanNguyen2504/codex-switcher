import { useEffect, useMemo, useState } from "react";
import type { QuotaReportEntry, QuotaReportRow } from "../hooks/useQuotaReport";
import type { UsageInfo } from "../types";
import { UsageBar } from "./UsageBar";

/**
 * Props accepted by the quota report popup.
 *
 * @property isOpen - Required flag controlling whether the popup is rendered.
 * @property reports - Required newest-first list of quota report snapshots, capped by the hook.
 * @property latestReport - Required latest report snapshot, or `null` before any report exists.
 * @property isReloading - Required flag indicating a quota reload is currently running.
 * @property lastError - Required scheduler-level error message, or `null` when none is active.
 * @property nextReloadAt - Required Unix timestamp in milliseconds for the next automatic reload,
 * or `null` when no automatic reload is scheduled.
 * @property onClose - Required callback invoked when the user closes the popup.
 * @property onReloadNow - Required callback that triggers an immediate quota reload.
 * @property onExport - Required callback that exports the latest quota report.
 * @property onClearReports - Required callback that clears retained quota report snapshots.
 */
interface QuotaReportModalProps {
  isOpen: boolean;
  reports: QuotaReportEntry[];
  latestReport: QuotaReportEntry | null;
  isReloading: boolean;
  lastError: string | null;
  nextReloadAt: number | null;
  onClose: () => void;
  onReloadNow: () => Promise<unknown>;
  onExport: () => Promise<unknown>;
  onClearReports: () => void;
}

/**
 * Props used by the snapshot navigation control.
 *
 * @property reports - Required newest-first report snapshots available for inspection.
 * @property selectedIndex - Required zero-based index of the currently selected snapshot.
 * @property onSelect - Required callback that receives the next selected snapshot index.
 */
interface SnapshotNavigatorProps {
  reports: QuotaReportEntry[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

/**
 * Props used to render one read-only quota report account card.
 *
 * @property row - Required report row containing account identity, quota values, and row status.
 */
interface ReportAccountCardProps {
  row: QuotaReportRow;
}

/**
 * Renders the quota report popup with snapshot navigation and read-only quota cards.
 *
 * Purpose:
 *   Gives users an in-app report view for the automatic three-minute quota reload schedule while
 *   matching the main account quota presentation.
 * Inputs:
 *   props - Required `QuotaReportModalProps` controlling visibility, report data, status, and
 *   button actions.
 * Output:
 *   Returns the popup React element when `isOpen` is true, otherwise `null`.
 * Errors:
 *   Does not throw directly; action callback failures are handled by the caller.
 * Side Effects:
 *   Invokes `onClose`, `onReloadNow`, `onExport`, or `onClearReports` in response to user actions
 *   and stores local snapshot selection state.
 */
export function QuotaReportModal({
  isOpen,
  reports,
  latestReport,
  isReloading,
  lastError,
  nextReloadAt,
  onClose,
  onReloadNow,
  onExport,
  onClearReports,
}: QuotaReportModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [reports[0]?.id, isOpen]);

  const selectedReport = useMemo(
    () => reports[selectedIndex] ?? latestReport,
    [latestReport, reports, selectedIndex]
  );
  const selectedSnapshotPosition = selectedReport
    ? reports.findIndex((report) => report.id === selectedReport.id) + 1
    : 0;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl dark:border-gray-700 dark:bg-gray-950">
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Quota Report
              </h2>
              {selectedReport && (
                <span
                  className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                  title={formatFullReportTime(selectedReport.completedAt)}
                >
                  {formatReportTime(selectedReport.completedAt)}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>{isReloading ? "Reloading quota..." : formatNextReload(nextReloadAt)}</span>
              {selectedReport && reports.length > 0 && (
                <span>
                  Snapshot {selectedSnapshotPosition || 1}/{reports.length}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            title="Close quota report"
            aria-label="Close quota report"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {lastError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300">
              {lastError}
            </div>
          )}

          {selectedReport ? (
            <div className="space-y-5">
              <SnapshotNavigator
                reports={reports}
                selectedIndex={Math.min(selectedIndex, Math.max(reports.length - 1, 0))}
                onSelect={setSelectedIndex}
              />
              <ReportSummary report={selectedReport} />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {selectedReport.rows.map((row) => (
                  <ReportAccountCard key={row.accountId} row={row} />
                ))}
              </div>
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">
              No quota report yet
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Showing the latest usable quota when a reload fails. Retains up to 10 snapshots.
          </div>
          <div className="flex items-center gap-3">
          <button
            onClick={onClearReports}
            disabled={reports.length === 0}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-600 transition-colors hover:bg-red-100 disabled:opacity-50 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30"
            title="Clear quota report log"
            aria-label="Clear quota report log"
          >
            <TrashIcon />
          </button>
          <button
            onClick={() => {
              void onReloadNow();
            }}
            disabled={isReloading}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            title={isReloading ? "Reloading quota report" : "Reload quota report now"}
            aria-label={isReloading ? "Reloading quota report" : "Reload quota report now"}
          >
            {isReloading ? <SpinnerIcon /> : <ReloadIcon />}
          </button>
          <button
            onClick={() => {
              void onExport();
            }}
            disabled={!latestReport}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-900 text-white transition-colors hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
            title="Export latest quota report"
            aria-label="Export latest quota report"
          >
            <ExportIcon />
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders summary counters for a quota report snapshot.
 *
 * Purpose:
 *   Shows the current report timestamp and fresh/stale/failed totals.
 * Inputs:
 *   report - Required report snapshot to summarize.
 * Output:
 *   Returns a React element containing compact summary counters.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function ReportSummary({ report }: { report: QuotaReportEntry }) {
  const items = [
    {
      label: "Accounts",
      value: String(report.totalAccounts),
      className: "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900",
      valueClassName: "text-gray-900 dark:text-gray-100",
    },
    {
      label: "Fresh",
      value: String(report.freshAccounts),
      className: "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20",
      valueClassName: "text-emerald-700 dark:text-emerald-300",
    },
    {
      label: "Fallback",
      value: String(report.staleAccounts),
      className: "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20",
      valueClassName: "text-amber-700 dark:text-amber-300",
    },
    {
      label: "Failed",
      value: String(report.failedAccounts),
      className: "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20",
      valueClassName: "text-red-700 dark:text-red-300",
    },
  ];
  const weeklyRemainingPercent = getWeeklyRemainingPercent(report);
  const weeklyRemainingTotal = getWeeklyRemainingTotal(report);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Weekly Quota Remaining
          </div>
          <div className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {weeklyRemainingPercent.toFixed(1)}% across {report.totalAccounts} account
            {report.totalAccounts === 1 ? "" : "s"}
          </div>
        </div>
        <div
          className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-right dark:border-gray-700 dark:bg-gray-800"
          title={formatFullReportTime(report.completedAt)}
        >
          <div className="text-xs text-gray-500 dark:text-gray-400">Generated</div>
          <div className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
            {formatReportTime(report.completedAt)}
          </div>
        </div>
      </div>
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${weeklyRemainingPercent}%` }}
        />
      </div>
      <div className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        Weekly remaining: {weeklyRemainingTotal.toFixed(1)} / {report.totalAccounts * 100}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {items.map((item) => (
        <div
          key={item.label}
          className={`rounded-xl border px-3 py-2 ${item.className}`}
        >
          <div className="text-xs text-gray-500 dark:text-gray-400">{item.label}</div>
          <div className={`mt-1 truncate text-lg font-semibold ${item.valueClassName}`}>
            {item.value}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}

/**
 * Computes the total weekly quota remaining across all report rows.
 *
 * Purpose:
 *   Supports the aggregate weekly remaining formula shown in the report summary card.
 * Inputs:
 *   report - Required quota report snapshot containing per-account weekly usage percentages.
 * Output:
 *   Returns the sum of weekly remaining percentages, where missing weekly quota contributes `0`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function getWeeklyRemainingTotal(report: QuotaReportEntry): number {
  return report.rows.reduce((total, row) => {
    if (row.secondaryUsedPercent === null) return total;
    return total + Math.max(0, 100 - row.secondaryUsedPercent);
  }, 0);
}

/**
 * Computes aggregate weekly quota remaining as a percentage of all account capacity.
 *
 * Purpose:
 *   Applies the formula `weekly remaining total / (account count * 100) * 100`; for example, nine
 *   accounts divide by `900`.
 * Inputs:
 *   report - Required quota report snapshot containing total account count and weekly usage rows.
 * Output:
 *   Returns a percentage in the inclusive range `0..100`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function getWeeklyRemainingPercent(report: QuotaReportEntry): number {
  if (report.totalAccounts === 0) return 0;
  const capacity = report.totalAccounts * 100;
  return Math.min(100, Math.max(0, (getWeeklyRemainingTotal(report) / capacity) * 100));
}

/**
 * Renders buttons for moving between stored quota report snapshots.
 *
 * Purpose:
 *   Lets users inspect the latest ten scheduler logs one snapshot at a time.
 * Inputs:
 *   props - Required `SnapshotNavigatorProps` with report data, selected index, and selection
 *   callback.
 * Output:
 *   Returns a React element containing previous/next controls and numbered snapshot buttons.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   Calls `onSelect` when the user changes the selected snapshot.
 */
function SnapshotNavigator({ reports, selectedIndex, onSelect }: SnapshotNavigatorProps) {
  if (reports.length <= 1) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
        Latest snapshot only
      </div>
    );
  }

  const canGoNewer = selectedIndex > 0;
  const canGoOlder = selectedIndex < reports.length - 1;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div>
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Recent Snapshots
        </div>
        <div className="mt-1 text-sm text-gray-700 dark:text-gray-200">
          {formatReportTime(reports[selectedIndex]?.completedAt ?? Date.now())}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onSelect(Math.max(0, selectedIndex - 1))}
          disabled={!canGoNewer}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-700"
          title="View newer snapshot"
          aria-label="View newer snapshot"
        >
          <ChevronLeftIcon />
        </button>
        {reports.map((report, index) => (
          <button
            key={report.id}
            onClick={() => onSelect(index)}
            className={`h-8 rounded-lg px-2.5 font-mono text-xs font-semibold transition-colors ${
              index === selectedIndex
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-700"
            }`}
            title={formatFullReportTime(report.completedAt)}
            aria-label={`View quota snapshot ${index + 1}`}
          >
            {formatReportTime(report.completedAt)}
          </button>
        ))}
        <button
          onClick={() => onSelect(Math.min(reports.length - 1, selectedIndex + 1))}
          disabled={!canGoOlder}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-700"
          title="View older snapshot"
          aria-label="View older snapshot"
        >
          <ChevronRightIcon />
        </button>
      </div>
    </div>
  );
}

/**
 * Renders one read-only account card for a quota report row.
 *
 * Purpose:
 *   Mirrors the main screen quota presentation while omitting account actions for historical log
 *   snapshots.
 * Inputs:
 *   row - Required report row containing account identity, status, quota values, and errors.
 * Output:
 *   Returns a React card element for the row.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function ReportAccountCard({ row }: ReportAccountCardProps) {
  const usage = buildUsageFromReportRow(row);
  const quotaSummary = getQuotaSummary(row);

  return (
    <div className={`rounded-2xl border bg-white p-5 shadow-sm dark:bg-gray-900 ${getCardClassName(row.status)}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-gray-900 dark:text-gray-100">
            {row.accountName}
          </div>
          {row.email && (
            <div className="truncate text-sm text-gray-500 dark:text-gray-400">
              {row.email}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <span className={getStatusClassName(row.status)}>{getStatusLabel(row.status)}</span>
          <span className="rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 dark:border-gray-700 dark:text-gray-300">
            {row.planType ?? "Unknown"}
          </span>
        </div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {quotaSummary.map((item) => (
          <div
            key={item.label}
            className="rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-800"
            title={item.title}
          >
            <div className="text-xs text-gray-500 dark:text-gray-400">{item.label}</div>
            <div className="mt-1 truncate font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
              {item.value}
            </div>
          </div>
        ))}
      </div>
      <UsageBar usage={usage} loading={false} />
      {row.error && row.status !== "fresh" && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          {row.status === "stale" ? "Using previous quota: " : ""}
          {row.error}
        </div>
      )}
    </div>
  );
}

/**
 * Compact quota fact shown near the top of a report account card.
 */
interface QuotaSummaryItem {
  label: string;
  value: string;
  title: string;
}

/**
 * Builds compact quota facts for a report card.
 *
 * Purpose:
 *   Surfaces the most important daily and weekly quota percentages before the detailed bars.
 * Inputs:
 *   row - Required report row with nullable quota values.
 * Output:
 *   Returns two display items for primary and weekly quota.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function getQuotaSummary(row: QuotaReportRow): QuotaSummaryItem[] {
  return [
    {
      label: "5h Used",
      value: formatPercent(row.primaryUsedPercent),
      title: formatResetTitle("5h reset", row.primaryResetsAt),
    },
    {
      label: "Weekly Used",
      value: formatPercent(row.secondaryUsedPercent),
      title: formatResetTitle("Weekly reset", row.secondaryResetsAt),
    },
  ];
}

/**
 * Converts a quota report row into the usage shape consumed by `UsageBar`.
 *
 * Purpose:
 *   Reuses the exact quota bar component from the main screen for historical report snapshots.
 * Inputs:
 *   row - Required report row with nullable quota values and reset metadata.
 * Output:
 *   Returns a `UsageInfo` object suitable for `UsageBar`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildUsageFromReportRow(row: QuotaReportRow): UsageInfo {
  return {
    account_id: row.accountId,
    plan_type: row.planType,
    primary_used_percent: row.primaryUsedPercent,
    primary_window_minutes: row.primaryWindowMinutes,
    primary_resets_at: row.primaryResetsAt,
    secondary_used_percent: row.secondaryUsedPercent,
    secondary_window_minutes: row.secondaryWindowMinutes,
    secondary_resets_at: row.secondaryResetsAt,
    has_credits: row.hasCredits ?? (row.creditsBalance ? true : null),
    unlimited_credits: row.unlimitedCredits ?? null,
    credits_balance: row.creditsBalance,
    error: row.primaryUsedPercent === null && row.secondaryUsedPercent === null ? row.error : null,
  };
}

/**
 * Formats the next automatic reload timestamp.
 *
 * Purpose:
 *   Provides concise schedule status text for the popup header.
 * Inputs:
 *   nextReloadAt - Required Unix timestamp in milliseconds, or `null` when unscheduled.
 * Output:
 *   Returns a short status string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatNextReload(nextReloadAt: number | null): string {
  if (!nextReloadAt) return "No accounts scheduled";
  return `Next reload: ${formatReportTime(nextReloadAt)}`;
}

/**
 * Formats a report timestamp.
 *
 * Purpose:
 *   Converts report millisecond timestamps into localized UI text.
 * Inputs:
 *   timestamp - Required Unix timestamp in milliseconds.
 * Output:
 *   Returns a locale-formatted time string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatReportTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Formats a report timestamp with full date and time for tooltips.
 *
 * Purpose:
 *   Keeps visible report timestamps compact while preserving exact date context on hover.
 * Inputs:
 *   timestamp - Required Unix timestamp in milliseconds.
 * Output:
 *   Returns a locale-formatted date/time string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatFullReportTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Formats a nullable percentage for compact quota summary cards.
 *
 * Purpose:
 *   Displays unavailable quota as a dash and available quota with one decimal place.
 * Inputs:
 *   value - Required percentage value, or `null` when unavailable.
 * Output:
 *   Returns a display-ready percentage string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}%`;
}

/**
 * Formats reset metadata for quota summary tooltips.
 *
 * Purpose:
 *   Shows reset timing without adding extra visible text to the account card.
 * Inputs:
 *   label - Required reset label identifying the quota window.
 *   timestampSeconds - Required Unix timestamp in seconds, or `null` when unavailable.
 * Output:
 *   Returns a tooltip string describing the reset time.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatResetTitle(label: string, timestampSeconds: number | null): string {
  if (!timestampSeconds) return `${label}: unavailable`;
  return `${label}: ${formatResetCountdown(timestampSeconds)}`;
}

/**
 * Formats a reset timestamp as remaining time for report tooltips.
 *
 * Purpose:
 *   Keeps report reset metadata consistent with account cards by showing a countdown instead of an
 *   absolute reset time.
 * Inputs:
 *   timestampSeconds - Required Unix timestamp in seconds.
 * Output:
 *   Returns remaining `HH:mm`, or `00:00` when the reset has passed.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   Reads the current browser clock.
 */
function formatResetCountdown(timestampSeconds: number): string {
  const remainingSeconds = Math.max(0, timestampSeconds - Math.floor(Date.now() / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Maps an internal row status to user-facing text.
 *
 * Purpose:
 *   Keeps report status labels consistent with status badge styling.
 * Inputs:
 *   status - Required internal quota row status.
 * Output:
 *   Returns the display label for the status.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function getStatusLabel(status: QuotaReportRow["status"]): string {
  switch (status) {
    case "fresh":
      return "Fresh";
    case "stale":
      return "Stale";
    case "failed":
      return "Failed";
    case "missing":
      return "Missing";
  }
}

/**
 * Maps an internal row status to Tailwind classes.
 *
 * Purpose:
 *   Applies visual treatment to quota freshness states in report cards.
 * Inputs:
 *   status - Required internal quota row status.
 * Output:
 *   Returns a Tailwind class string for the status badge.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function getStatusClassName(status: QuotaReportRow["status"]): string {
  const base = "inline-flex rounded-md px-2 py-0.5 text-xs font-medium";
  switch (status) {
    case "fresh":
      return `${base} bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300`;
    case "stale":
      return `${base} bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300`;
    case "failed":
      return `${base} bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300`;
    case "missing":
      return `${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300`;
  }
}

/**
 * Maps an internal row status to card border classes.
 *
 * Purpose:
 *   Gives each report card a subtle status accent while keeping the quota bars readable.
 * Inputs:
 *   status - Required internal quota row status.
 * Output:
 *   Returns a Tailwind class string for the report card border.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function getCardClassName(status: QuotaReportRow["status"]): string {
  switch (status) {
    case "fresh":
      return "border-gray-200 dark:border-gray-700";
    case "stale":
      return "border-amber-200 dark:border-amber-800";
    case "failed":
      return "border-red-200 dark:border-red-800";
    case "missing":
      return "border-gray-200 dark:border-gray-700";
  }
}

/**
 * Renders the shared close icon.
 *
 * Purpose:
 *   Provides an icon-only close control in the quota report popup.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG close icon.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * Renders the shared reload icon.
 *
 * Purpose:
 *   Represents manual quota report reload in icon-only controls.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG reload icon.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function ReloadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 10-2.34 5.66" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 5v6h-6" />
    </svg>
  );
}

/**
 * Renders the shared export icon.
 *
 * Purpose:
 *   Represents quota report export in icon-only controls.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG export icon.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function ExportIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10l5 5 5-5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 21h14" />
    </svg>
  );
}

/**
 * Renders the shared clear-log icon.
 *
 * Purpose:
 *   Represents clearing retained quota report snapshots in icon-only controls.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG trash icon.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function TrashIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 11v6M14 11v6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 7l1 14h10l1-14" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 7V4h6v3" />
    </svg>
  );
}

/**
 * Renders the shared spinner icon.
 *
 * Purpose:
 *   Indicates an in-progress quota report reload.
 * Inputs:
 *   None.
 * Output:
 *   Returns an animated SVG spinner.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M21 12a9 9 0 00-9-9v3a6 6 0 016 6h3z" />
    </svg>
  );
}

/**
 * Renders the shared left-chevron icon.
 *
 * Purpose:
 *   Indicates navigation to a newer report snapshot.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG left chevron.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function ChevronLeftIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/**
 * Renders the shared right-chevron icon.
 *
 * Purpose:
 *   Indicates navigation to an older report snapshot.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG right chevron.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function ChevronRightIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" />
    </svg>
  );
}
