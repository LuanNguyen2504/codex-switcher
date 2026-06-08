import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MENU_BAR_QUOTA_SNAPSHOT_STORAGE_KEY,
  type MenuBarQuotaAccountPayload,
  type MenuBarQuotaSnapshotPayload,
} from "../lib/menuBarQuota";
import { emitBackendEvent, invokeBackend } from "../lib/platform";

const POPUP_SWITCH_REQUEST_EVENT = "tray-popup-switch-requested";

/**
 * Renders the custom HTML quota popup opened from the macOS menu bar.
 *
 * Purpose:
 *   Replaces the native account dropdown with a styled grid that can align columns precisely,
 *   show colored status markers, and route actions back through the main app workflow.
 * Inputs:
 *   None. The component reads the latest credential-free quota snapshot from `localStorage`.
 * Output:
 *   Returns the popup React view.
 * Errors:
 *   Does not throw intentionally; action failures are displayed as inline status messages.
 * Side Effects:
 *   Reads browser storage, listens for storage/focus events, emits Tauri events, and invokes
 *   window-control backend commands.
 */
export function TrayQuotaPopup() {
  const [snapshot, setSnapshot] = useState<MenuBarQuotaSnapshotPayload | null>(() =>
    readStoredMenuBarQuotaSnapshot()
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    /**
     * Refreshes popup state from the shared menu bar snapshot storage.
     *
     * Purpose:
     *   Keeps the popup current when the hidden main window reloads quota or changes account
     *   ordering.
     * Inputs:
     *   None.
     * Output:
     *   Returns nothing.
     * Errors:
     *   Does not throw.
     * Side Effects:
     *   Updates React state from `localStorage`.
     */
    const refreshSnapshot = () => setSnapshot(readStoredMenuBarQuotaSnapshot());

    /**
     * Handles cross-window storage changes for the quota snapshot.
     *
     * Purpose:
     *   Updates the popup when the main window writes a new quota snapshot.
     * Inputs:
     *   event - Required browser storage event describing the changed key.
     * Output:
     *   Returns nothing.
     * Errors:
     *   Does not throw.
     * Side Effects:
     *   May update React state.
     */
    const handleStorage = (event: StorageEvent) => {
      if (event.key === MENU_BAR_QUOTA_SNAPSHOT_STORAGE_KEY) {
        refreshSnapshot();
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", refreshSnapshot);
    const timerId = window.setInterval(refreshSnapshot, 2_000);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", refreshSnapshot);
      window.clearInterval(timerId);
    };
  }, []);

  const activeAccount = useMemo(
    () => snapshot?.accounts.find((account) => account.is_active) ?? null,
    [snapshot]
  );

  const handleOpenMainWindow = useCallback(async () => {
    await runPopupAction(setActionMessage, async () => {
      await invokeBackend<void>("show_codex_switcher_window");
      await invokeBackend<void>("hide_quota_popup");
    });
  }, []);

  const handleReloadQuota = useCallback(async () => {
    await runPopupAction(setActionMessage, async () => {
      await emitBackendEvent("tray-refresh-requested");
      setActionMessage("Reload requested");
    });
  }, []);

  const handleOpenReport = useCallback(async () => {
    await runPopupAction(setActionMessage, async () => {
      await emitBackendEvent("tray-popup-report-requested");
      await invokeBackend<void>("show_codex_switcher_window");
      await invokeBackend<void>("hide_quota_popup");
    });
  }, []);

  const handleClosePopup = useCallback(async () => {
    await runPopupAction(setActionMessage, async () => {
      await invokeBackend<void>("hide_quota_popup");
    });
  }, []);

  const handleQuitApp = useCallback(async () => {
    await runPopupAction(setActionMessage, async () => {
      await invokeBackend<void>("quit_codex_switcher_app");
    });
  }, []);

  const handleSwitchAccount = useCallback(async (account: MenuBarQuotaAccountPayload) => {
    if (!account.selectable || account.error) return;
    await runPopupAction(setActionMessage, async () => {
      await emitBackendEvent(POPUP_SWITCH_REQUEST_EVENT, { account_id: account.id });
      await invokeBackend<void>("hide_quota_popup");
    });
  }, []);

  return (
    <main className="tray-popup-shell">
      <section className="tray-popup-panel">
        <header className="tray-popup-header">
          <div>
            <p className="tray-popup-eyebrow">Codex Switcher</p>
            <h1>Quota Overview</h1>
          </div>
          <div className="tray-popup-active">
            <span className="tray-popup-active-dot" />
            <span>{activeAccount ? shortAccountLabel(activeAccount) : "No active account"}</span>
          </div>
        </header>

        <div className="tray-popup-toolbar">
          <button type="button" className="tray-popup-tool primary" onClick={handleOpenMainWindow}>
            <span className="tray-popup-tool-icon">⌂</span>
            <span>Open</span>
          </button>
          <button type="button" className="tray-popup-tool" onClick={handleReloadQuota}>
            <span className="tray-popup-tool-icon">↻</span>
            <span>Reload</span>
          </button>
          <button type="button" className="tray-popup-tool report" onClick={handleOpenReport}>
            <span className="tray-popup-tool-icon">▤</span>
            <span>Report</span>
          </button>
          <button type="button" className="tray-popup-tool" onClick={handleClosePopup}>
            <span className="tray-popup-tool-icon">×</span>
            <span>Close</span>
          </button>
          <button type="button" className="tray-popup-tool danger" onClick={handleQuitApp}>
            <span className="tray-popup-tool-icon">⏻</span>
            <span>Quit</span>
          </button>
        </div>

        <div className="tray-popup-summary">
          <span>Updated {formatTime(snapshot?.generated_at ?? null)}</span>
          <span>{snapshot?.accounts.length ?? 0} accounts</span>
          {actionMessage ? <strong>{actionMessage}</strong> : null}
        </div>

        <div className="tray-popup-table" role="table" aria-label="Account quota">
          <div className="tray-popup-grid tray-popup-head" role="row">
            <span>A</span>
            <span>P</span>
            <span>5h</span>
            <span>Reset</span>
            <span>Week</span>
            <span>Reset</span>
            <span>Account</span>
          </div>
          <div className="tray-popup-rows">
            {snapshot?.accounts.length ? (
              snapshot.accounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  className={`tray-popup-grid tray-popup-row ${
                    account.is_active ? "is-active" : ""
                  } ${account.selectable && !account.error ? "" : "is-disabled"}`}
                  disabled={!account.selectable || Boolean(account.error)}
                  onClick={() => handleSwitchAccount(account)}
                  title={buildAccountTitle(account)}
                >
                  <span className={buildActiveMarkerClass(account)} />
                  <span className={buildPriorityMarkerClass(account)} />
                  <span className="tray-popup-quota-cell">
                    <span className={buildQuotaDotClass(account.primary_remaining_percent)} />
                    {formatPercent(account.primary_remaining_percent)}
                  </span>
                  <span>{formatResetCountdown(account.primary_resets_at)}</span>
                  <span className="tray-popup-quota-cell">
                    <span className={buildQuotaDotClass(account.secondary_remaining_percent)} />
                    {formatPercent(account.secondary_remaining_percent)}
                  </span>
                  <span>{formatResetCountdown(account.secondary_resets_at)}</span>
                  <span className="tray-popup-account-label">{account.email || account.name}</span>
                </button>
              ))
            ) : (
              <div className="tray-popup-empty">No quota snapshot yet</div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

/**
 * Reads the latest menu bar quota snapshot from browser storage.
 *
 * Purpose:
 *   Supplies the popup with the same data that the hidden main window sent to the native tray.
 * Inputs:
 *   None.
 * Output:
 *   Returns the parsed snapshot, or `null` when no valid snapshot exists.
 * Errors:
 *   Catches JSON/storage failures and returns `null`.
 * Side Effects:
 *   Reads `localStorage`.
 */
function readStoredMenuBarQuotaSnapshot(): MenuBarQuotaSnapshotPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MENU_BAR_QUOTA_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MenuBarQuotaSnapshotPayload;
    return Array.isArray(parsed.accounts) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Runs a popup action with consistent error reporting.
 *
 * Purpose:
 *   Keeps toolbar and row actions concise while surfacing failures inside the popup.
 * Inputs:
 *   setMessage - Required React state setter used to show action status.
 *   action - Required async operation to execute.
 * Output:
 *   Resolves after the action succeeds or fails.
 * Errors:
 *   Catches action errors instead of rethrowing.
 * Side Effects:
 *   May update the popup message state.
 */
async function runPopupAction(
  setMessage: (message: string | null) => void,
  action: () => Promise<void>
): Promise<void> {
  try {
    setMessage(null);
    await action();
  } catch (error) {
    setMessage(formatActionError(error));
  }
}

/**
 * Formats an unknown popup action failure.
 *
 * Purpose:
 *   Converts backend and event errors into short UI text.
 * Inputs:
 *   error - Required unknown error value caught from an action.
 * Output:
 *   Returns a human-readable error string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatActionError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "Action failed";
}

/**
 * Builds the account tooltip text for popup rows.
 *
 * Purpose:
 *   Exposes the full account identity and error reason when visible labels are truncated.
 * Inputs:
 *   account - Required account row displayed in the popup.
 * Output:
 *   Returns the tooltip string.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildAccountTitle(account: MenuBarQuotaAccountPayload): string {
  const identity = account.email || account.name;
  if (account.error) return `${identity}: ${account.error}`;
  if (!account.selectable) return `${identity}: quota exhausted`;
  return identity;
}

/**
 * Builds the CSS class for the active/error marker.
 *
 * Purpose:
 *   Gives each row a colored status dot while keeping the active column aligned.
 * Inputs:
 *   account - Required account row whose status determines the marker color.
 * Output:
 *   Returns the CSS class string for the marker span.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildActiveMarkerClass(account: MenuBarQuotaAccountPayload): string {
  if (account.error) return "tray-popup-status-dot error";
  if (account.is_active) return "tray-popup-status-dot active";
  return "tray-popup-status-dot hollow";
}

/**
 * Builds the CSS class for the priority marker.
 *
 * Purpose:
 *   Shows a colored priority star for selected accounts and a hollow star for normal accounts.
 * Inputs:
 *   account - Required account row whose priority flag determines the marker.
 * Output:
 *   Returns the CSS class string for the marker span.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildPriorityMarkerClass(account: MenuBarQuotaAccountPayload): string {
  return account.priority_quota_enabled
    ? "tray-popup-star priority"
    : "tray-popup-star hollow";
}

/**
 * Builds the CSS class for a quota status dot.
 *
 * Purpose:
 *   Maps remaining quota to a compact color state for primary and weekly quota cells.
 * Inputs:
 *   percent - Optional remaining quota percentage.
 * Output:
 *   Returns the CSS class string for the quota dot.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function buildQuotaDotClass(percent: number | null): string {
  if (percent === null) return "tray-popup-quota-dot unknown";
  if (percent <= 0) return "tray-popup-quota-dot empty";
  if (percent < 20) return "tray-popup-quota-dot low";
  if (percent < 60) return "tray-popup-quota-dot medium";
  return "tray-popup-quota-dot healthy";
}

/**
 * Formats an optional quota percentage.
 *
 * Purpose:
 *   Keeps quota cells compact and consistent.
 * Inputs:
 *   percent - Optional remaining quota percentage.
 * Output:
 *   Returns a whole-number percentage or `--`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function formatPercent(percent: number | null): string {
  if (percent === null) return "--";
  return `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
}

/**
 * Formats an optional reset timestamp as remaining time.
 *
 * Purpose:
 *   Displays reset columns as a countdown so users see how long remains until quota is usable
 *   again instead of seeing an absolute wall-clock reset time.
 * Inputs:
 *   timestamp - Optional Unix timestamp in seconds.
 * Output:
 *   Returns remaining `HH:mm`, `00:00` when the reset time has passed, or `--`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   Reads the current browser clock.
 */
function formatResetCountdown(timestamp: number | null): string {
  if (!timestamp) return "--";
  const remainingSeconds = Math.max(0, timestamp - Math.floor(Date.now() / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Formats an optional Unix timestamp for popup display.
 *
 * Purpose:
 *   Shows reset times without date clutter.
 * Inputs:
 *   timestamp - Optional Unix timestamp in seconds.
 * Output:
 *   Returns `HH:mm:ss` in local time or `--`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   Reads the local timezone from the browser runtime.
 */
function formatTime(timestamp: number | null): string {
  if (!timestamp) return "--";
  return new Date(timestamp * 1000).toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Builds a short active-account label for the popup header.
 *
 * Purpose:
 *   Keeps the active account chip compact while preserving enough identity to recognize it.
 * Inputs:
 *   account - Required active account row.
 * Output:
 *   Returns a shortened account email/name.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
function shortAccountLabel(account: MenuBarQuotaAccountPayload): string {
  const value = account.email || account.name;
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}
