import type { AccountWithUsage } from "../types";

/**
 * Account row plus priority state used by quota-aware ordering.
 *
 * @property account - Required account whose quota and reset fields participate in sorting.
 * @property priorityQuotaEnabled - Required flag indicating the user starred this account for
 * priority quota switching.
 */
export interface QuotaAccountOrderingEntry {
  account: AccountWithUsage;
  priorityQuotaEnabled: boolean;
}

const QUOTA_SELECTABLE_MIN_REMAINING_PERCENT = 0;

/**
 * Sorts accounts using the quota priority order configured for switching and menu bar display.
 *
 * Purpose:
 *   Applies the shared ranking rule: selectable accounts first, starred accounts, most weekly
 *   quota remaining, most 5h quota remaining, nearest 5h reset, then nearest weekly reset.
 * Inputs:
 *   accounts - Required account list to sort; the source array is not mutated.
 *   priorityAccountIds - Required set of starred account IDs.
 * Output:
 *   Returns a new account array ordered by the shared quota priority rule.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function sortAccountsByQuotaPriority(
  accounts: AccountWithUsage[],
  priorityAccountIds: Set<string>
): AccountWithUsage[] {
  return accounts
    .map((account) => ({
      account,
      priorityQuotaEnabled: priorityAccountIds.has(account.id),
    }))
    .sort(compareQuotaAccountOrderingEntries)
    .map((entry) => entry.account);
}

/**
 * Compares two account ordering entries by the shared quota priority rule.
 *
 * Purpose:
 *   Keeps auto switch and menu bar account ordering consistent.
 * Inputs:
 *   first - Required first account ordering entry.
 *   second - Required second account ordering entry.
 * Output:
 *   Returns a negative number when `first` should appear before `second`, a positive number when
 *   `second` should appear before `first`, or zero when both are equivalent.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function compareQuotaAccountOrderingEntries(
  first: QuotaAccountOrderingEntry,
  second: QuotaAccountOrderingEntry
): number {
  const firstSelectable = isQuotaAccountSelectable(first.account);
  const secondSelectable = isQuotaAccountSelectable(second.account);
  if (firstSelectable !== secondSelectable) {
    return firstSelectable ? -1 : 1;
  }

  if (first.priorityQuotaEnabled !== second.priorityQuotaEnabled) {
    return first.priorityQuotaEnabled ? -1 : 1;
  }

  const weeklyRemainingDiff = compareOptionalDescending(
    getRemainingQuotaPercent(first.account.usage?.secondary_used_percent),
    getRemainingQuotaPercent(second.account.usage?.secondary_used_percent)
  );
  if (weeklyRemainingDiff !== 0) return weeklyRemainingDiff;

  const primaryRemainingDiff = compareOptionalDescending(
    getRemainingQuotaPercent(first.account.usage?.primary_used_percent),
    getRemainingQuotaPercent(second.account.usage?.primary_used_percent)
  );
  if (primaryRemainingDiff !== 0) return primaryRemainingDiff;

  const primaryResetDiff = compareOptionalAscending(
    first.account.usage?.primary_resets_at,
    second.account.usage?.primary_resets_at
  );
  if (primaryResetDiff !== 0) return primaryResetDiff;

  const weeklyResetDiff = compareOptionalAscending(
    first.account.usage?.secondary_resets_at,
    second.account.usage?.secondary_resets_at
  );
  if (weeklyResetDiff !== 0) return weeklyResetDiff;

  return getAccountDisplayEmail(first.account).localeCompare(
    getAccountDisplayEmail(second.account)
  );
}

/**
 * Returns the remaining quota percentage for a used percentage.
 *
 * Purpose:
 *   Converts API usage percentages into comparable remaining quota percentages for sorting and
 *   menu labels.
 * Inputs:
 *   usedPercent - Optional quota used percentage in the inclusive `0..100` range when known.
 * Output:
 *   Returns remaining quota in the inclusive `0..100` range, or `null` when usage is unknown.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function getRemainingQuotaPercent(
  usedPercent: number | null | undefined
): number | null {
  if (usedPercent === null || usedPercent === undefined) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

/**
 * Returns the email-first account label used outside cards.
 *
 * Purpose:
 *   Displays menu bar account rows by email while falling back to account name for API-key or
 *   incomplete accounts.
 * Inputs:
 *   account - Required account with optional email metadata.
 * Output:
 *   Returns the account email when present, otherwise the account name.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function getAccountDisplayEmail(account: AccountWithUsage): string {
  return account.email || account.name;
}

/**
 * Checks whether an account can be selected for quota-bearing work.
 *
 * Purpose:
 *   Pushes exhausted accounts to the bottom of menu and auto-switch ordering while allowing rows
 *   with unknown quota to remain visible in the normal sorted group until a reload proves they are
 *   exhausted.
 * Inputs:
 *   account - Required account with optional usage data.
 * Output:
 *   Returns `false` only when either known primary remaining quota or known weekly remaining quota
 *   is at zero percent; otherwise returns `true`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function isQuotaAccountSelectable(account: AccountWithUsage): boolean {
  const primaryRemaining = getRemainingQuotaPercent(account.usage?.primary_used_percent);
  const weeklyRemaining = getRemainingQuotaPercent(account.usage?.secondary_used_percent);

  if (
    primaryRemaining !== null &&
    primaryRemaining <= QUOTA_SELECTABLE_MIN_REMAINING_PERCENT
  ) {
    return false;
  }

  if (
    weeklyRemaining !== null &&
    weeklyRemaining <= QUOTA_SELECTABLE_MIN_REMAINING_PERCENT
  ) {
    return false;
  }

  return true;
}

/**
 * Compares optional numbers in ascending order with unknown values last.
 *
 * Purpose:
 *   Orders reset timestamps so the nearest known reset is ranked first and unknown reset times
 *   cannot outrank known quota data.
 * Inputs:
 *   first - Optional first numeric value.
 *   second - Optional second numeric value.
 * Output:
 *   Returns standard comparator output for ascending order.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function compareOptionalAscending(
  first: number | null | undefined,
  second: number | null | undefined
): number {
  if (first === null || first === undefined) {
    return second === null || second === undefined ? 0 : 1;
  }
  if (second === null || second === undefined) return -1;
  return first - second;
}

/**
 * Compares optional numbers in descending order with unknown values last.
 *
 * Purpose:
 *   Orders remaining quota so accounts with more known quota rank ahead of lower or unknown quota.
 * Inputs:
 *   first - Optional first numeric value.
 *   second - Optional second numeric value.
 * Output:
 *   Returns standard comparator output for descending order.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function compareOptionalDescending(
  first: number | null | undefined,
  second: number | null | undefined
): number {
  if (first === null || first === undefined) {
    return second === null || second === undefined ? 0 : 1;
  }
  if (second === null || second === undefined) return -1;
  return second - first;
}
