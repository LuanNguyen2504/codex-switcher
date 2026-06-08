import type { QuotaReportEntry } from "../hooks/useQuotaReport";
import type { AccountWithUsage } from "../types";
import { sortAccountsByQuotaPriority } from "./quotaAccountOrdering";

const QUOTA_AVAILABLE_THRESHOLD = 99.5;

/**
 * Source category for the account selected by automatic quota switching.
 */
export type QuotaSwitchSource = "priority" | "fallback";

/**
 * Account selected for automatic quota switching.
 *
 * @property account - Account that should become active.
 * @property source - Whether the account came from the preferred list or fallback pool.
 */
export interface QuotaSwitchCandidate {
  account: AccountWithUsage;
  source: QuotaSwitchSource;
}

/**
 * Selects the best account to switch to after a quota reload.
 *
 * Purpose:
 *   Applies the configured priority-account rule after quota reports refresh: accounts with both
 *   quotas available rank first, then starred accounts, nearest primary reset, nearest weekly
 *   reset, most weekly quota remaining, and most primary quota remaining.
 * Inputs:
 *   accounts - Required list of known accounts, including creation timestamps and current active
 *   state.
 *   report - Required latest quota report snapshot, or `null` when no quota report is available.
 *   priorityAccountIds - Required set of account IDs selected as priority accounts.
 * Output:
 *   Returns the selected `QuotaSwitchCandidate`, or `null` when no freshly reloaded account has
 *   both quotas available.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function selectQuotaSwitchAccount(
  accounts: AccountWithUsage[],
  report: QuotaReportEntry | null,
  priorityAccountIds: Set<string>
): QuotaSwitchCandidate | null {
  if (!report) return null;

  const reportRowsByAccountId = new Map(report.rows.map((row) => [row.accountId, row]));
  const eligibleAccounts = accounts
    .filter((account) => {
      const row = reportRowsByAccountId.get(account.id);
      if (!row || row.status !== "fresh") return false;
      return hasQuotaAvailable(row.primaryUsedPercent) && hasQuotaAvailable(row.secondaryUsedPercent);
    });

  const candidate = sortAccountsByQuotaPriority(eligibleAccounts, priorityAccountIds)[0];
  if (!candidate) return null;

  return {
    account: candidate,
    source: priorityAccountIds.has(candidate.id) ? "priority" : "fallback",
  };
}

/**
 * Checks whether a quota usage percentage still has remaining capacity.
 *
 * Purpose:
 *   Treats primary and weekly quota consistently for automatic account selection.
 * Inputs:
 *   usedPercent - Required quota used percentage, or `null` when quota data is unavailable.
 * Output:
 *   Returns `true` when the percentage is known and below the configured full threshold.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function hasQuotaAvailable(usedPercent: number | null): boolean {
  return usedPercent !== null && usedPercent < QUOTA_AVAILABLE_THRESHOLD;
}
