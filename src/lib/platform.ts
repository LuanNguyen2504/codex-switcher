import type { ImportAccountsSummary } from "../types";

/**
 * File-like input accepted by account import flows.
 */
export type FileSource = string | File;

/**
 * Detects whether the app is running inside Tauri.
 *
 * Purpose:
 *   Chooses between native Tauri commands and browser/web fallback behavior.
 * Inputs:
 *   None.
 * Output:
 *   Returns `true` when Tauri internals are present on `window`, otherwise `false`.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Invokes a backend command through Tauri or the LAN web bridge.
 *
 * Purpose:
 *   Provides one command API for both desktop and browser-backed development/runtime modes.
 * Inputs:
 *   command - Required backend command name registered by Tauri or the web bridge.
 *   args - Optional JSON-serializable command payload; defaults to an empty object.
 * Output:
 *   Resolves to the typed backend response payload.
 * Errors:
 *   Throws backend invocation errors, HTTP errors, or response parsing errors.
 * Side Effects:
 *   Performs native IPC or network I/O.
 */
export async function invokeBackend<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  const response = await fetch(`/api/invoke/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

/**
 * Registers a backend event listener when the app runs inside Tauri.
 *
 * Purpose:
 *   Lets native menu bar actions notify the React UI without breaking browser development mode.
 * Inputs:
 *   eventName - Required backend event name emitted by Tauri.
 *   handler - Required callback invoked with the event payload whenever the event fires.
 * Output:
 *   Resolves to an unsubscribe callback; in browser mode the callback is a no-op.
 * Errors:
 *   Throws when Tauri event registration fails.
 * Side Effects:
 *   Registers a native event listener in Tauri runtime mode.
 */
export async function listenBackendEvent<T>(
  eventName: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(eventName, (event) => handler(event.payload));
}

/**
 * Emits a frontend event to all Tauri webview windows.
 *
 * Purpose:
 *   Lets secondary windows such as the custom tray popup ask the hidden main app window to run
 *   shared workflows like reload and manual switch without duplicating that business logic.
 * Inputs:
 *   eventName - Required event name listened to by another frontend window.
 *   payload - Optional JSON-serializable event payload; defaults to `undefined`.
 * Output:
 *   Resolves after the event is emitted, or immediately in browser mode.
 * Errors:
 *   Throws when Tauri event emission fails.
 * Side Effects:
 *   Emits a Tauri event in desktop runtime mode.
 */
export async function emitBackendEvent<T>(
  eventName: string,
  payload?: T
): Promise<void> {
  if (!isTauriRuntime()) return;

  const { emit } = await import("@tauri-apps/api/event");
  await emit(eventName, payload);
}

/**
 * Opens a URL outside the application shell.
 *
 * Purpose:
 *   Sends OAuth and external links to the platform browser in desktop mode or a new browser tab
 *   in web mode.
 * Inputs:
 *   url - Required absolute or browser-resolvable URL to open.
 * Output:
 *   Resolves when the open request has been handed to the platform.
 * Errors:
 *   Throws when Tauri cannot open the URL.
 * Side Effects:
 *   Opens an external browser or tab.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Prompts the user to select an auth.json file.
 *
 * Purpose:
 *   Supplies account import flows with a native path in Tauri or a `File` object in web mode.
 * Inputs:
 *   None.
 * Output:
 *   Resolves to a selected file source, or `null` when the user cancels.
 * Errors:
 *   Throws when the native file picker fails.
 * Side Effects:
 *   Opens a file picker dialog.
 */
export async function pickAuthJsonFile(): Promise<FileSource | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
      title: "Select auth.json file",
    });

    if (!selected || Array.isArray(selected)) return null;
    return selected;
  }

  return pickBrowserFile(".json,application/json");
}

/**
 * Exports the full encrypted account backup.
 *
 * Purpose:
 *   Saves all account configuration in the existing encrypted backup format.
 * Inputs:
 *   None.
 * Output:
 *   Resolves to `true` when a file is written/downloaded, or `false` when the user cancels.
 * Errors:
 *   Throws backend or file picker errors.
 * Side Effects:
 *   Opens a save dialog or starts a browser download and reads backend backup bytes.
 */
export async function exportFullBackupFile(): Promise<boolean> {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selected = await save({
      title: "Export Full Encrypted Account Config",
      defaultPath: "codex-switcher-full.cswf",
      filters: [{ name: "Codex Switcher Full Backup", extensions: ["cswf"] }],
    });

    if (!selected) return false;
    await invokeBackend("export_accounts_full_encrypted_file", { path: selected });
    return true;
  }

  const contentsBase64 = await invokeBackend<string>("export_accounts_full_encrypted_bytes");
  downloadBase64File(
    contentsBase64,
    "codex-switcher-full.cswf",
    "application/octet-stream"
  );
  return true;
}

/**
 * Imports the full encrypted account backup.
 *
 * Purpose:
 *   Restores accounts from a `.cswf` encrypted backup file while preserving existing accounts.
 * Inputs:
 *   None.
 * Output:
 *   Resolves to an import summary, or `null` when the user cancels file selection.
 * Errors:
 *   Throws backend, decoding, or file picker errors.
 * Side Effects:
 *   Opens a file picker, reads selected file bytes, and mutates backend account storage.
 */
export async function importFullBackupFile(): Promise<ImportAccountsSummary | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      title: "Import Full Encrypted Account Config",
      filters: [{ name: "Codex Switcher Full Backup", extensions: ["cswf"] }],
    });

    if (!selected || Array.isArray(selected)) return null;
    return invokeBackend<ImportAccountsSummary>("import_accounts_full_encrypted_file", {
      path: selected,
    });
  }

  const selected = await pickBrowserFile(".cswf,application/octet-stream");
  if (!selected) return null;

  const contentsBase64 = await fileToBase64(selected);
  return invokeBackend<ImportAccountsSummary>("import_accounts_full_encrypted_bytes", {
    contentsBase64,
  });
}

/**
 * Exports a Markdown quota report file.
 *
 * Purpose:
 *   Saves the latest popup quota report outside the app in desktop or browser mode.
 * Inputs:
 *   contents - Required Markdown report text to write.
 * Output:
 *   Resolves to `true` when a file is written/downloaded, or `false` when the user cancels the
 *   native save dialog.
 * Errors:
 *   Throws backend or save dialog errors.
 * Side Effects:
 *   Opens a save dialog in Tauri, writes a text file through the backend, or starts a browser
 *   download in web mode.
 */
export async function exportQuotaReportFile(contents: string): Promise<boolean> {
  const fileName = `codex-switcher-quota-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.md`;

  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selected = await save({
      title: "Export Quota Report",
      defaultPath: fileName,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });

    if (!selected) return false;
    await invokeBackend("export_quota_report_text_file", { path: selected, contents });
    return true;
  }

  downloadTextFile(contents, fileName, "text/markdown;charset=utf-8");
  return true;
}

/**
 * Describes a selected file source for UI copy.
 *
 * Purpose:
 *   Converts native paths, browser files, and empty selections into readable text.
 * Inputs:
 *   source - Required selected file source, or `null` when no file is selected.
 * Output:
 *   Returns a display string for the selected source.
 * Errors:
 *   Does not throw.
 * Side Effects:
 *   None.
 */
export function describeFileSource(source: FileSource | null): string {
  if (!source) return "No file selected";
  return typeof source === "string" ? source : source.name;
}

/**
 * Converts a browser `File` to a base64 string.
 *
 * Purpose:
 *   Encodes encrypted backup uploads for the LAN web command bridge.
 * Inputs:
 *   file - Required browser file selected by the user.
 * Output:
 *   Resolves to the base64 representation of the file bytes.
 * Errors:
 *   Throws when the browser cannot read the file.
 * Side Effects:
 *   Reads the selected file into memory.
 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

/**
 * Downloads base64-encoded bytes as a browser file.
 *
 * Purpose:
 *   Provides the web-mode fallback for encrypted backup export.
 * Inputs:
 *   base64 - Required base64-encoded file contents.
 *   fileName - Required download filename shown to the browser.
 *   mimeType - Required MIME type assigned to the generated Blob.
 * Output:
 *   Returns `void`.
 * Errors:
 *   Throws when base64 decoding fails.
 * Side Effects:
 *   Creates a temporary object URL and clicks a temporary anchor element.
 */
function downloadBase64File(
  base64: string,
  fileName: string,
  mimeType: string
): void {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Downloads text as a browser file.
 *
 * Purpose:
 *   Provides the web-mode fallback for quota report export.
 * Inputs:
 *   contents - Required text payload to save.
 *   fileName - Required download filename shown to the browser.
 *   mimeType - Required MIME type assigned to the generated Blob.
 * Output:
 *   Returns `void`.
 * Errors:
 *   Does not throw under normal browser Blob and DOM behavior.
 * Side Effects:
 *   Creates a temporary object URL and clicks a temporary anchor element.
 */
function downloadTextFile(contents: string, fileName: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Prompts the user to select a browser file.
 *
 * Purpose:
 *   Implements web-mode file selection without Tauri dialogs.
 * Inputs:
 *   accept - Required accept filter string using standard input file syntax.
 * Output:
 *   Resolves to the selected `File`, or `null` when the picker closes without a file.
 * Errors:
 *   Does not throw under normal browser DOM behavior.
 * Side Effects:
 *   Inserts and removes a temporary file input element.
 */
async function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;

    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleWindowFocus);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 0);
    };

    input.addEventListener(
      "change",
      () => {
        finish(input.files?.[0] ?? null);
      },
      { once: true }
    );

    document.body.appendChild(input);
    window.addEventListener("focus", handleWindowFocus, { once: true });
    input.click();
  });
}

/**
 * Reads a JSON response from the LAN command bridge.
 *
 * Purpose:
 *   Parses successful command responses and converts non-JSON bodies into error payloads.
 * Inputs:
 *   response - Required Fetch API response returned by the web bridge.
 * Output:
 *   Resolves to parsed JSON, `null` for an empty body, or `{ error: text }` for plain-text bodies.
 * Errors:
 *   Throws when the response body cannot be read.
 * Side Effects:
 *   Consumes the response body stream.
 */
async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
