import { useRef, useState } from "react";
import {
  describeFileSource,
  isTauriRuntime,
  openExternalUrl,
  pickAuthJsonFile,
  type FileSource,
} from "../lib/platform";

/**
 * Props used by the add-account modal.
 *
 * @property isOpen - Required flag controlling whether the modal is visible.
 * @property onClose - Required callback invoked after the modal finishes closing.
 * @property onImportFile - Required callback that imports a selected auth file with the provided
 * account display name.
 * @property onStartOAuth - Required callback that starts a ChatGPT OAuth login and returns the
 * browser URL.
 * @property onCompleteOAuth - Required callback that waits for the active OAuth callback to finish.
 * @property onCancelOAuth - Required callback that cancels any pending OAuth login flow.
 */
interface AddAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
}

/**
 * Modal tab identifiers.
 */
type Tab = "oauth" | "import";

/**
 * Renders the add-account modal for OAuth login or auth-file import.
 *
 * Purpose:
 *   Lets users add accounts through ChatGPT browser login or by importing an existing auth file.
 * Inputs:
 *   props - Required `AddAccountModalProps` containing modal state and async account callbacks.
 * Output:
 *   Returns the modal React element when open, otherwise `null`.
 * Errors:
 *   Does not throw intentionally; async callback failures are shown in local error state.
 * Side Effects:
 *   Starts, cancels, and completes OAuth login flows; opens external URLs and file pickers;
 *   writes to the clipboard; invokes import callbacks.
 */
export function AddAccountModal({
  isOpen,
  onClose,
  onImportFile,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
}: AddAccountModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");
  const [name, setName] = useState("");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const oauthFlowIdRef = useRef(0);
  const isPrimaryDisabled = loading || (activeTab === "oauth" && oauthPending);
  const tauriRuntime = isTauriRuntime();

  /**
   * Resets all local form fields and pending UI state.
   *
   * Purpose:
   *   Restores the modal to its initial empty state after close or successful account creation.
   * Inputs:
   *   None.
   * Output:
   *   Returns nothing.
   * Errors:
   *   Does not throw.
   * Side Effects:
   *   Mutates local React state for form values, errors, loading, and OAuth link state.
   */
  const resetForm = () => {
    setName("");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
  };

  /**
   * Closes the modal and cancels any pending OAuth login.
   *
   * Purpose:
   *   Ensures a partially completed OAuth callback server is cancelled when the user leaves the
   *   modal.
   * Inputs:
   *   None.
   * Output:
   *   Returns nothing.
   * Errors:
   *   Ignores cancellation failures because close should remain responsive.
   * Side Effects:
   *   Invalidates pending OAuth flow IDs, may call the backend cancellation callback, resets local
   *   state, and invokes `onClose`.
   */
  const handleClose = () => {
    oauthFlowIdRef.current += 1;
    if (oauthPending) {
      void onCancelOAuth().catch((err) => {
        console.error("Failed to cancel login:", err);
      });
    }
    resetForm();
    onClose();
  };

  /**
   * Starts a new OAuth login flow and waits for its callback.
   *
   * Purpose:
   *   Generates a ChatGPT login link, optionally replacing an existing pending link immediately,
   *   and completes the modal once the OAuth callback succeeds.
   * Inputs:
   *   regenerate - Optional boolean flag indicating an existing pending login should be cancelled
   *   before generating a new link. Defaults to `false`.
   * Output:
   *   Resolves after the active OAuth flow succeeds, fails, or is superseded by a newer flow.
   * Errors:
   *   Captures callback failures in local error state unless the flow was superseded.
   * Side Effects:
   *   Calls OAuth start/cancel/complete callbacks, mutates loading/link/pending state, and may
   *   close the modal after successful login.
   */
  const handleOAuthLogin = async (regenerate = false) => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }

    const flowId = oauthFlowIdRef.current + 1;
    oauthFlowIdRef.current = flowId;

    try {
      setLoading(true);
      setError(null);
      setCopied(false);
      if (regenerate || oauthPending) {
        await onCancelOAuth().catch((err) => {
          console.error("Failed to cancel previous login:", err);
        });
      }
      const info = await onStartOAuth(name.trim());
      if (oauthFlowIdRef.current !== flowId) return;
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);

      await onCompleteOAuth();
      if (oauthFlowIdRef.current !== flowId) return;
      handleClose();
    } catch (err) {
      if (oauthFlowIdRef.current !== flowId) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setOauthPending(false);
    }
  };

  /**
   * Opens the platform file picker for an auth JSON file.
   *
   * Purpose:
   *   Lets users select an existing Codex `auth.json` source for import.
   * Inputs:
   *   None.
   * Output:
   *   Resolves after the picker closes.
   * Errors:
   *   Logs picker failures to the console.
   * Side Effects:
   *   Opens a file picker and mutates local file-source state when a file is selected.
   */
  const handleSelectFile = async () => {
    try {
      const selected = await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  /**
   * Imports the selected auth file as a new account.
   *
   * Purpose:
   *   Validates the account name and file selection before invoking the import callback.
   * Inputs:
   *   None.
   * Output:
   *   Resolves after import succeeds or fails.
   * Errors:
   *   Captures import failures in local error state.
   * Side Effects:
   *   Calls `onImportFile`, mutates local loading/error state, and closes the modal on success.
   */
  const handleImportFile = async () => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }
    if (!fileSource) {
      setError("Please select an auth.json file");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportFile(fileSource, name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-md mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Add Account</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 dark:border-gray-800">
          {(["oauth", "import"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (tab === "import" && oauthPending) {
                  oauthFlowIdRef.current += 1;
                  void onCancelOAuth().catch((err) => {
                    console.error("Failed to cancel login:", err);
                  });
                  setOauthPending(false);
                  setLoading(false);
                }
                setActiveTab(tab);
                setError(null);
              }}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab
                  ? "text-gray-900 dark:text-gray-100 border-b-2 border-gray-900 dark:border-gray-100 -mb-px"
                  : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                }`}
            >
              {tab === "oauth" ? "ChatGPT Login" : "Import File"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Account Name (always shown) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Account Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Work Account"
              className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-gray-500 focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 transition-colors"
            />
          </div>

          {/* Tab-specific content */}
          {activeTab === "oauth" && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {oauthPending ? (
                <div className="text-center py-4">
                  <div className="animate-spin h-8 w-8 border-2 border-gray-900 dark:border-gray-100 border-t-transparent rounded-full mx-auto mb-3"></div>
                  <p className="text-gray-700 dark:text-gray-300 font-medium mb-2">Waiting for browser login...</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                    Please open the following link in your browser to proceed:
                  </p>
                  <div className="flex items-center gap-2 mb-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg border border-gray-200 dark:border-gray-700">
                    <input
                      type="text"
                      readOnly
                      value={authUrl}
                      className="flex-1 bg-transparent border-none text-xs text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-0 truncate"
                    />
                    <button
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(authUrl)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          })
                          .catch(() => {
                            setError("Clipboard unavailable. Copy the link manually.");
                          });
                      }}
                      className={`px-3 py-1.5 border rounded text-xs font-medium transition-colors shrink-0 
                        ${copied
                          ? "bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300"
                          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
                        }`}
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                    <button
                      onClick={() => {
                        void handleOAuthLogin(true);
                      }}
                      disabled={loading}
                      className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-900 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded text-xs font-medium text-gray-700 dark:text-gray-200 transition-colors shrink-0"
                    >
                      {loading ? "Generating..." : "New"}
                    </button>
                    <button
                      onClick={() => {
                        void openExternalUrl(authUrl);
                      }}
                      className="px-3 py-1.5 bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 border border-gray-900 dark:border-gray-100 rounded text-xs font-medium text-white dark:text-gray-900 transition-colors shrink-0"
                    >
                      Open
                    </button>
                  </div>
                  {!tauriRuntime && (
                    <p className="text-xs text-amber-600">
                      OAuth login must finish on the same host machine because the callback
                      redirects to `localhost`.
                    </p>
                  )}
                </div>
              ) : (
                <p>
                  Click the button below to generate a login link.
                  You will need to open it in your browser to authenticate.
                </p>
              )}
            </div>
          )}

          {activeTab === "import" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Select auth.json file
              </label>
              <div className="flex gap-2">
                <div className="flex-1 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-600 dark:text-gray-300 truncate">
                  {describeFileSource(fileSource)}
                </div>
                <button
                  onClick={handleSelectFile}
                  className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors whitespace-nowrap"
                >
                  Browse...
                </button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                Import credentials from an existing Codex auth.json file
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-600 dark:text-red-300 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t border-gray-100 dark:border-gray-800">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={activeTab === "oauth" ? () => void handleOAuthLogin() : handleImportFile}
            disabled={isPrimaryDisabled}
            className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors disabled:opacity-50"
          >
            {loading
              ? "Adding..."
              : activeTab === "oauth"
                ? "Generate Login Link"
                : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
