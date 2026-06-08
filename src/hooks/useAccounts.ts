import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AccountInfo,
  UsageInfo,
  AccountWithUsage,
  WarmupSummary,
  ImportAccountsSummary,
} from "../types";
import { invokeBackend, type FileSource } from "../lib/platform";

/**
 * Options controlling an account usage reload operation.
 *
 * @property refreshMetadata - Optional flag that refreshes account metadata before loading quota.
 * Defaults to `false`; when enabled, the hook calls the backend metadata endpoint for each
 * targeted account.
 * @property preserveExistingOnError - Optional flag that keeps the previous quota snapshot when
 * an account-specific reload fails. Defaults to `false`; when enabled and no prior quota exists,
 * the hook records an error placeholder instead.
 */
export interface RefreshUsageOptions {
  refreshMetadata?: boolean;
  preserveExistingOnError?: boolean;
}

/**
 * Summary returned after a usage reload targets one or more accounts.
 *
 * @property attemptedAccountIds - Account IDs that were scheduled for quota reload.
 * @property succeededAccountIds - Account IDs whose quota reload returned fresh data.
 * @property failedAccountIds - Account IDs whose quota reload failed.
 * @property errorsByAccountId - Account-specific failure messages keyed by account ID.
 * @property usageByAccountId - Fresh usage payloads keyed by account ID for successful reloads.
 * @property refreshedAt - Unix timestamp in milliseconds captured when the reload completed.
 */
export interface RefreshUsageSummary {
  attemptedAccountIds: string[];
  succeededAccountIds: string[];
  failedAccountIds: string[];
  errorsByAccountId: Record<string, string>;
  usageByAccountId: Record<string, UsageInfo>;
  refreshedAt: number;
}

/**
 * Provides account CRUD actions plus quota refresh state for the Codex Switcher UI.
 *
 * Purpose:
 *   Loads stored Codex accounts, exposes account management commands, and keeps frontend quota
 *   state synchronized with backend usage responses.
 * Inputs:
 *   None. The hook reads from the Tauri or web backend through `invokeBackend`.
 * Output:
 *   Returns account state, loading/error flags, and async command callbacks for account,
 *   authentication, masking, warm-up, import/export, and quota refresh operations.
 * Errors:
 *   Backend command errors are captured in `error` for account loading or rethrown by command
 *   callbacks when the caller needs to display an operation-specific failure.
 * Side Effects:
 *   Performs backend I/O, mutates React state, and logs failed quota or warm-up calls to the
 *   console.
 */
export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const maxConcurrentUsageRequests = 10;

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  /**
   * Builds a frontend usage payload that represents a quota reload failure.
   *
   * Purpose:
   *   Creates a `UsageInfo` object for accounts that cannot return live quota data.
   * Inputs:
   *   accountId - Required account ID whose quota request failed.
   *   message - Required human-readable failure message from the backend or runtime.
   *   planType - Required account plan label when known; pass `null` when unavailable.
   * Output:
   *   Returns a `UsageInfo` object with nullable quota fields and `error` set to `message`.
   * Errors:
   *   Does not throw.
   * Side Effects:
   *   None.
   */
  const buildUsageError = useCallback(
    (accountId: string, message: string, planType: string | null): UsageInfo => ({
      account_id: accountId,
      plan_type: planType,
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: message,
    }),
    []
  );

  /**
   * Builds an error usage payload while preserving the last known quota fields.
   *
   * Purpose:
   *   Marks the main account UI as failed immediately after a quota reload error, while keeping
   *   previously known quota values available for report fallback and diagnostics.
   * Inputs:
   *   account - Required account row whose live quota request failed; its existing `usage` field,
   *   when present, is used as the source of stale quota values.
   *   message - Required backend or runtime failure text that should be shown in the main UI.
   * Output:
   *   Returns a `UsageInfo` object with `error` set and quota fields copied from the previous
   *   snapshot when available.
   * Errors:
   *   Does not throw.
   * Side Effects:
   *   None.
   */
  const buildUsageErrorFromPrevious = useCallback(
    (account: AccountWithUsage, message: string): UsageInfo => ({
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
    }),
    []
  );

  /**
   * Runs asynchronous work over a collection with a bounded number of parallel workers.
   *
   * Purpose:
   *   Limits backend request fan-out while still refreshing multiple accounts concurrently.
   * Inputs:
   *   items - Required ordered collection of items to process.
   *   worker - Required async callback invoked once for each item; it performs the actual work.
   *   concurrency - Required maximum number of workers; values below one are treated as one and
   *   values above the item count are capped to the item count.
   * Output:
   *   Resolves after all worker runners settle; returns `void`.
   * Errors:
   *   Worker errors are contained by `Promise.allSettled` and do not reject this helper.
   * Side Effects:
   *   Runs whatever side effects the supplied worker performs, usually backend I/O.
   */
  const runWithConcurrency = useCallback(
    async <T,>(
      items: T[],
      worker: (item: T) => Promise<void>,
      concurrency: number
    ) => {
      if (items.length === 0) return;
      const limit = Math.min(Math.max(concurrency, 1), items.length);
      let index = 0;
      const runners = Array.from({ length: limit }, async () => {
        while (true) {
          const current = index++;
          if (current >= items.length) return;
          await worker(items[current]);
        }
      });
      await Promise.allSettled(runners);
    },
    []
  );

  /**
   * Loads stored accounts from the backend and updates frontend account state.
   *
   * Purpose:
   *   Refreshes account metadata shown by the UI, optionally retaining currently displayed quota
   *   snapshots.
   * Inputs:
   *   preserveUsage - Optional flag, default `false`; when `true`, existing `usage` and
   *   `usageLoading` fields are copied onto matching loaded accounts.
   * Output:
   *   Returns the account list loaded from the backend, or an empty array if loading failed.
   * Errors:
   *   Backend errors are stored in `error` and converted to an empty return list.
   * Side Effects:
   *   Calls the backend, mutates React loading/error/account state.
   */
  const loadAccounts = useCallback(async (preserveUsage = false) => {
    try {
      setLoading(true);
      setError(null);
      const accountList = await invokeBackend<AccountInfo[]>("list_accounts");
      
      if (preserveUsage) {
        // Preserve existing usage data when just updating account info
        setAccounts((prev) => {
          const usageMap = new Map(
            prev.map((a) => [a.id, { usage: a.usage, usageLoading: a.usageLoading }])
          );
          return accountList.map((a) => ({
            ...a,
            usage: usageMap.get(a.id)?.usage,
            usageLoading: usageMap.get(a.id)?.usageLoading,
          }));
        });
      } else {
        setAccounts(accountList.map((a) => ({ ...a, usageLoading: false })));
      }
      return accountList;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshUsage = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[],
      options?: RefreshUsageOptions
    ): Promise<RefreshUsageSummary> => {
      try {
        let list = accountList ?? accountsRef.current;
        const emptySummary: RefreshUsageSummary = {
          attemptedAccountIds: [],
          succeededAccountIds: [],
          failedAccountIds: [],
          errorsByAccountId: {},
          usageByAccountId: {},
          refreshedAt: Date.now(),
        };

        if (list.length === 0) {
          return emptySummary;
        }

        if (options?.refreshMetadata) {
          await runWithConcurrency(
            list,
            async (account) => {
              await invokeBackend<AccountInfo>("refresh_account_metadata", {
                accountId: account.id,
              });
            },
            maxConcurrentUsageRequests
          );

          list = await loadAccounts(true);
        }

        const accountIds = list.map((account) => account.id);
        const accountIdSet = new Set(accountIds);
        const usageResults = new Map<string, UsageInfo>();
        const errorsByAccountId: Record<string, string> = {};
        const failedAccountIds = new Set<string>();

        setAccounts((prev) =>
          prev.map((account) =>
            accountIdSet.has(account.id)
              ? { ...account, usageLoading: true }
              : account
          )
        );

        await runWithConcurrency(
          list,
          async (account) => {
            try {
              const usage = await invokeBackend<UsageInfo>("get_usage", {
                accountId: account.id,
              });
              usageResults.set(account.id, usage);
            } catch (err) {
              console.error("Failed to refresh usage:", err);
              const message = err instanceof Error ? err.message : String(err);
              errorsByAccountId[account.id] = message;
              failedAccountIds.add(account.id);
              if (!options?.preserveExistingOnError) {
                usageResults.set(
                  account.id,
                  buildUsageError(account.id, message, account.plan_type ?? null)
                );
              }
            }
          },
          maxConcurrentUsageRequests
        );

        setAccounts((prev) =>
          prev.map((account) => {
            const usage = usageResults.get(account.id);
            if (!accountIdSet.has(account.id)) return account;
            if (!usage) {
              if (failedAccountIds.has(account.id) && options?.preserveExistingOnError) {
                return {
                  ...account,
                  usage: buildUsageErrorFromPrevious(
                    account,
                    errorsByAccountId[account.id] ?? "Usage refresh failed"
                  ),
                  usageLoading: false,
                };
              }
              return {
                ...account,
                usageLoading: false,
              };
            }
            return {
              ...account,
              usage,
              usageLoading: false,
            };
          })
        );

        return {
          attemptedAccountIds: accountIds,
          succeededAccountIds: Array.from(usageResults.keys()),
          failedAccountIds: Array.from(failedAccountIds),
          errorsByAccountId,
          usageByAccountId: Object.fromEntries(usageResults.entries()),
          refreshedAt: Date.now(),
        };
      } catch (err) {
        console.error("Failed to refresh usage:", err);
        throw err;
      }
    },
    [
      buildUsageError,
      buildUsageErrorFromPrevious,
      loadAccounts,
      maxConcurrentUsageRequests,
      runWithConcurrency,
    ]
  );

  /**
   * Reloads quota for a single account and updates only that account in frontend state.
   *
   * Purpose:
   *   Supports per-card manual reloads and auto warm-up checks that need fresh quota for one
   *   account.
   * Inputs:
   *   accountId - Required ID of the account whose quota should be reloaded.
   *   options - Optional refresh behavior; `refreshMetadata` refreshes account metadata first.
   * Output:
   *   Returns the fresh `UsageInfo` payload when the backend quota request succeeds.
   * Errors:
   *   Rethrows backend quota errors after clearing the loading flag; the account is marked as
   *   failed immediately while preserving prior quota fields for fallback diagnostics.
   * Side Effects:
   *   Calls backend metadata/usage commands, mutates React account state, and writes console
   *   errors for failed reloads.
   */
  const refreshSingleUsage = useCallback(async (
    accountId: string,
    options?: Pick<RefreshUsageOptions, "refreshMetadata">
  ) => {
    try {
      if (options?.refreshMetadata) {
        await invokeBackend<AccountInfo>("refresh_account_metadata", { accountId });
        await loadAccounts(true);
      }

      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usageLoading: true } : a
        )
      );
      const usage = await invokeBackend<UsageInfo>("get_usage", { accountId });
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usage, usageLoading: false } : a
        )
      );
      return usage;
    } catch (err) {
      console.error("Failed to refresh single usage:", err);
      const message = err instanceof Error ? err.message : String(err);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                usage: buildUsageErrorFromPrevious(a, message),
                usageLoading: false,
              }
            : a
        )
      );
      throw err;
    }
  }, [buildUsageErrorFromPrevious, loadAccounts]);

  const warmupAccount = useCallback(async (accountId: string) => {
    try {
      await invokeBackend("warmup_account", { accountId });
    } catch (err) {
      console.error("Failed to warm up account:", err);
      throw err;
    }
  }, []);

  const warmupAllAccounts = useCallback(async () => {
    try {
      return await invokeBackend<WarmupSummary>("warmup_all_accounts");
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      throw err;
    }
  }, []);

  /**
   * Switches the active Codex account and explicitly syncs the auth file.
   *
   * Purpose:
   *   Activates an existing account in both Codex Switcher's store and the official Codex
   *   `auth.json` so the next Codex restart reads the selected credentials immediately.
   * Inputs:
   *   accountId - Required local account ID that should become active.
   * Output:
   *   Resolves after backend switch, auth-file sync, and account reload complete.
   * Errors:
   *   Rethrows backend switch or sync failures to the caller.
   * Side Effects:
   *   Writes Codex auth JSON through backend commands and refreshes frontend account state.
   */
  const switchAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("switch_account", { accountId });
        await invokeBackend("sync_active_account_auth");
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("delete_account", { accountId });
        await loadAccounts();
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const renameAccount = useCallback(
    async (accountId: string, newName: string) => {
      try {
        await invokeBackend("rename_account", { accountId, newName });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const importFromFile = useCallback(
    async (source: FileSource, name: string) => {
      try {
        if (typeof source === "string") {
          await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
            name,
            contents,
          });
        }
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const startOAuthLogin = useCallback(async (accountName: string) => {
    try {
      const info = await invokeBackend<{ auth_url: string; callback_port: number }>(
        "start_login",
        { accountName }
      );
      return info;
    } catch (err) {
      throw err;
    }
  }, []);

  const completeOAuthLogin = useCallback(async () => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_login");
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const exportAccountsSlimText = useCallback(async () => {
    try {
      return await invokeBackend<string>("export_accounts_slim_text");
    } catch (err) {
      throw err;
    }
  }, []);

  const importAccountsSlimText = useCallback(
    async (payload: string) => {
      try {
        const summary = await invokeBackend<ImportAccountsSummary>("import_accounts_slim_text", {
          payload,
        });
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
        return summary;
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const exportAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        await invokeBackend("export_accounts_full_encrypted_file", { path });
      } catch (err) {
        throw err;
      }
    },
    []
  );

  const importAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        const summary = await invokeBackend<ImportAccountsSummary>(
          "import_accounts_full_encrypted_file",
          { path }
        );
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
        return summary;
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const cancelOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_login");
    } catch (err) {
      console.error("Failed to cancel login:", err);
    }
  }, []);

  const loadMaskedAccountIds = useCallback(async () => {
    try {
      return await invokeBackend<string[]>("get_masked_account_ids");
    } catch (err) {
      console.error("Failed to load masked account IDs:", err);
      return [];
    }
  }, []);

  const saveMaskedAccountIds = useCallback(async (ids: string[]) => {
    try {
      await invokeBackend("set_masked_account_ids", { ids });
    } catch (err) {
      console.error("Failed to save masked account IDs:", err);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  return {
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
    exportAccountsFullEncryptedFile,
    importAccountsFullEncryptedFile,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  };
}
