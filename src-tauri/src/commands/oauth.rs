//! Tauri commands for managing the local ChatGPT OAuth login flow.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::{
    add_account, load_accounts, set_active_account, switch_to_account, touch_account,
};
use crate::types::{AccountInfo, OAuthLoginInfo};

struct PendingOAuth {
    rx: oneshot::Receiver<anyhow::Result<OAuthLoginResult>>,
    cancelled: Arc<AtomicBool>,
}

/// Receiver for the OAuth flow that has been started but not yet awaited by the frontend.
static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::new(None);

/// Cancellation handle for the currently running local OAuth callback server.
static ACTIVE_OAUTH_CANCELLED: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Cancels an OAuth flow through its shared cancellation flag.
///
/// Purpose:
///   Stops a local callback server even when its result receiver has already been moved into
///   `complete_login`.
/// Inputs:
///   handle - Optional shared cancellation flag for an OAuth callback server; `None` means there
///   is no known flow to cancel.
/// Output:
///   Returns nothing.
/// Errors:
///   Does not throw or return errors.
/// Side Effects:
///   Mutates the atomic cancellation flag when a handle is present.
fn cancel_oauth_handle(handle: Option<Arc<AtomicBool>>) {
    if let Some(cancelled) = handle {
        cancelled.store(true, Ordering::Relaxed);
    }
}

/// Clears the active OAuth cancellation handle when it belongs to the completed flow.
///
/// Purpose:
///   Prevents an old `complete_login` call from clearing the cancellation handle for a newer OAuth
///   flow that was generated with the New button.
/// Inputs:
///   completed - Required cancellation flag for the flow whose callback wait just finished.
/// Output:
///   Returns nothing.
/// Errors:
///   Does not throw or return errors.
/// Side Effects:
///   Mutates global OAuth command state protected by `ACTIVE_OAUTH_CANCELLED`.
fn clear_active_oauth_handle(completed: &Arc<AtomicBool>) {
    let mut active = ACTIVE_OAUTH_CANCELLED.lock().unwrap();
    if active
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, completed))
    {
        *active = None;
    }
}

/// Starts a new ChatGPT OAuth login flow.
///
/// Purpose:
///   Creates a browser authorization URL and a local callback server for adding a Codex account;
///   starting a new flow cancels any older pending or actively awaited flow.
/// Inputs:
///   account_name - Required display name to assign to the account after OAuth succeeds.
/// Output:
///   Returns `OAuthLoginInfo` containing the authorization URL and callback port.
/// Errors:
///   Returns a string error if the OAuth server cannot start or the authorization URL cannot be
///   prepared.
/// Side Effects:
///   Cancels older OAuth callback servers, starts a new local HTTP callback server, and updates
///   global OAuth command state.
#[tauri::command]
pub async fn start_login(account_name: String) -> Result<OAuthLoginInfo, String> {
    // Cancel any previous pending flow so it does not keep the callback port occupied.
    cancel_oauth_handle({
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending.take().map(|pending| pending.cancelled)
    });
    cancel_oauth_handle({
        let mut active = ACTIVE_OAUTH_CANCELLED.lock().unwrap();
        active.take()
    });

    let (info, rx, cancelled) = start_oauth_login(account_name)
        .await
        .map_err(|e| e.to_string())?;

    {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        *pending = Some(PendingOAuth {
            rx,
            cancelled: cancelled.clone(),
        });
    }
    {
        let mut active = ACTIVE_OAUTH_CANCELLED.lock().unwrap();
        *active = Some(cancelled);
    }

    Ok(info)
}

/// Completes the active ChatGPT OAuth login flow and stores the resulting account.
///
/// Purpose:
///   Waits for the local callback server to receive the OAuth response, persists the authenticated
///   account, and switches Codex to the newly added account.
/// Inputs:
///   None.
/// Output:
///   Returns the stored `AccountInfo` for the newly added active account.
/// Errors:
///   Returns a string error when no flow is pending, the callback fails, account persistence fails,
///   or switching the active auth file fails.
/// Side Effects:
///   Waits on the OAuth callback receiver, writes account storage, changes the active account,
///   copies auth data to Codex, updates account last-used metadata, and clears completed OAuth
///   command state.
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let pending = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending
            .take()
            .ok_or_else(|| "No pending OAuth login".to_string())?
    };

    let cancelled = pending.cancelled.clone();
    let account_result = wait_for_oauth_login(pending.rx).await;
    clear_active_oauth_handle(&cancelled);

    let account = account_result
        .map_err(|e| e.to_string())?;

    // Add the account to storage
    let stored = add_account(account).map_err(|e| e.to_string())?;

    // Make it active and switch to it
    set_active_account(&stored.id).map_err(|e| e.to_string())?;
    switch_to_account(&stored).map_err(|e| e.to_string())?;
    touch_account(&stored.id).map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    Ok(AccountInfo::from_stored(&stored, active_id))
}

/// Cancels any pending or actively awaited ChatGPT OAuth login flow.
///
/// Purpose:
///   Stops the local callback server when the user closes the modal, switches tabs, or asks for a
///   new login link.
/// Inputs:
///   None.
/// Output:
///   Returns `Ok(())` after cancellation flags are set; this is also successful when no flow is
///   active.
/// Errors:
///   Does not return operational errors.
/// Side Effects:
///   Mutates global OAuth command state and sets cancellation flags that cause callback server
///   threads to exit.
#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    cancel_oauth_handle({
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending.take().map(|pending| pending.cancelled)
    });
    cancel_oauth_handle({
        let mut active = ACTIVE_OAUTH_CANCELLED.lock().unwrap();
        active.take()
    });
    Ok(())
}
