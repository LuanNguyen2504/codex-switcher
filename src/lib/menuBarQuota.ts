import type { AccountWithUsage } from "../types";
import { invokeBackend, isTauriRuntime } from "./platform";
import {
  getAccountDisplayEmail,
  getRemainingQuotaPercent,
  isQuotaAccountSelectable,
  sortAccountsByQuotaPriority,
} from "./quotaAccountOrdering";

/**
 * Local storage key for the credential-free quota snapshot shared with tray popup windows.
 */
export const MENU_BAR_QUOTA_SNAPSHOT_STORAGE_KEY = "codex-switcher-menu-bar-quota-snapshot";

/**
 * Account payload sent to the native menu bar quota renderer.
 *
 * @property id - Required account ID used for quick switch menu actions.
 * @property email - Required email-first account label displayed in the menu.
 * @property name - Required account display name used as a fallback label.
 * @property is_active - Required flag indicating the account is currently active.
 * @property priority_quota_enabled - Required flag indicating the account is starred.
 * @property primary_remaining_percent - Optional remaining 5h quota percentage.
 * @property primary_resets_at - Optional 5h reset Unix timestamp in seconds.
 * @property secondary_remaining_percent - Optional remaining weekly quota percentage.
 * @property secondary_resets_at - Optional weekly reset Unix timestamp in seconds.
 * @property error - Optional quota reload error for this account.
 * @property selectable - Required flag indicating whether the account has known non-zero primary
 * and weekly quota when those values are available.
 */
export interface MenuBarQuotaAccountPayload {
  id: string;
  email: string;
  name: string;
  is_active: boolean;
  priority_quota_enabled: boolean;
  primary_remaining_percent: number | null;
  primary_resets_at: number | null;
  secondary_remaining_percent: number | null;
  secondary_resets_at: number | null;
  error: string | null;
  selectable: boolean;
}

/**
 * Snapshot payload sent to the native menu bar quota renderer.
 *
 * @property generated_at - Required Unix timestamp in seconds for the snapshot.
 * @property active_account_id - Optional active account ID.
 * @property accounts - Required account rows, already sorted by quota priority.
 */
export interface MenuBarQuotaSnapshotPayload {
  generated_at: number;
  active_account_id: string | null;
  accounts: MenuBarQuotaAccountPayload[];
}

/**
 * Builds the menu bar quota snapshot from current frontend account state.
 *
 * Purpose:
 *   Converts account and usage state into the credential-free payload consumed by native tray menu
 *   rendering.
 * Inputs:
 *   accounts - Required current account list with optional quota usage state.
 *   priorityAccountIds - Required set of starred account IDs.
 * Output:
 *   Returns a sorted `MenuBarQuotaSnapshotPayload`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function buildMenuBarQuotaSnapshot(
  accounts: AccountWithUsage[],
  priorityAccountIds: Set<string>
): MenuBarQuotaSnapshotPayload {
  const sortedAccounts = sortAccountsByQuotaPriority(accounts, priorityAccountIds);
  const activeAccount = accounts.find((account) => account.is_active);

  return {
    generated_at: Math.floor(Date.now() / 1000),
    active_account_id: activeAccount?.id ?? null,
    accounts: sortedAccounts.map((account) => ({
      id: account.id,
      email: getAccountDisplayEmail(account),
      name: account.name,
      is_active: account.is_active,
      priority_quota_enabled: priorityAccountIds.has(account.id),
      primary_remaining_percent: getRemainingQuotaPercent(
        account.usage?.primary_used_percent
      ),
      primary_resets_at: account.usage?.primary_resets_at ?? null,
      secondary_remaining_percent: getRemainingQuotaPercent(
        account.usage?.secondary_used_percent
      ),
      secondary_resets_at: account.usage?.secondary_resets_at ?? null,
      error: account.usage?.error ?? null,
      selectable: isQuotaAccountSelectable(account),
    })),
  };
}

/**
 * Sends the latest quota snapshot to the native menu bar renderer.
 *
 * Purpose:
 *   Keeps the macOS menu bar quota title and quick-switch menu synchronized after account loads,
 *   manual reloads, automatic reloads, and priority changes.
 * Inputs:
 *   accounts - Required current account list with optional quota usage state.
 *   priorityAccountIds - Required set of starred account IDs.
 * Output:
 *   Resolves after the native backend accepts the snapshot; resolves immediately in web mode.
 * Errors:
 *   Throws backend invocation errors in Tauri runtime mode.
 * Side Effects:
 *   Invokes the native `update_menu_bar_quota` command in Tauri runtime mode.
 */
export async function updateMenuBarQuotaSnapshot(
  accounts: AccountWithUsage[],
  priorityAccountIds: Set<string>
): Promise<void> {
  const snapshot = buildMenuBarQuotaSnapshot(accounts, priorityAccountIds);
  persistMenuBarQuotaSnapshot(snapshot);
  if (!isTauriRuntime()) return;
  await invokeBackend<void>("update_menu_bar_quota", {
    snapshot,
  });
}

/**
 * Persists the latest menu bar quota snapshot for secondary webview windows.
 *
 * Purpose:
 *   Lets the custom tray popup render the same quota snapshot as the hidden main window without
 *   starting another backend reload or duplicating quota-fetch logic.
 * Inputs:
 *   snapshot - Required credential-free quota snapshot to store.
 * Output:
 *   Returns nothing.
 * Errors:
 *   Ignores storage failures so menu bar updates are not blocked by browser storage limitations.
 * Side Effects:
 *   Writes JSON into `localStorage` under `MENU_BAR_QUOTA_SNAPSHOT_STORAGE_KEY`.
 */
function persistMenuBarQuotaSnapshot(snapshot: MenuBarQuotaSnapshotPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MENU_BAR_QUOTA_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(snapshot)
    );
  } catch (error) {
    console.error("Failed to persist menu bar quota snapshot:", error);
  }
}
