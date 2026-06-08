//! Tauri entrypoint for Codex Switcher.
//!
//! Purpose:
//!   Configures the desktop runtime, native plugins, menu bar integration, and backend command
//!   handlers for the Codex CLI account switcher.
//! Inputs:
//!   Uses Tauri configuration generated from `tauri.conf.json` and command invocations from the
//!   React frontend.
//! Output:
//!   Starts the native desktop application event loop.
//! Errors:
//!   Panics if the Tauri runtime cannot start.
//! Side Effects:
//!   Creates native windows, initializes plugins, registers command handlers, and configures macOS
//!   activation behavior.

pub mod api;
pub mod auth;
pub mod commands;
pub mod types;
pub mod web;

use commands::{
    add_account_from_file, cancel_login, check_codex_processes, complete_login, delete_account,
    export_accounts_full_encrypted_file, export_accounts_slim_text, get_active_account_info,
    get_masked_account_ids, get_usage, hide_quota_popup, import_accounts_full_encrypted_file,
    import_accounts_slim_text, list_accounts, refresh_account_metadata, refresh_all_accounts_usage,
    rename_account, set_masked_account_ids, setup_menu_bar_quota_tray, start_login,
    switch_account, sync_active_account_auth, update_menu_bar_quota, quit_codex_switcher_app,
    export_quota_report_text_file, setup_main_window_dock_behavior, show_codex_switcher_window,
    warmup_account, warmup_all_accounts,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_main_window_dock_behavior(app.handle())?;
            setup_menu_bar_quota_tray(app.handle())?;
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Account management
            list_accounts,
            get_active_account_info,
            add_account_from_file,
            switch_account,
            sync_active_account_auth,
            delete_account,
            rename_account,
            export_accounts_slim_text,
            import_accounts_slim_text,
            export_accounts_full_encrypted_file,
            import_accounts_full_encrypted_file,
            export_quota_report_text_file,
            update_menu_bar_quota,
            show_codex_switcher_window,
            hide_quota_popup,
            quit_codex_switcher_app,
            // Masked accounts
            get_masked_account_ids,
            set_masked_account_ids,
            // OAuth
            start_login,
            complete_login,
            cancel_login,
            // Usage
            get_usage,
            refresh_account_metadata,
            refresh_all_accounts_usage,
            warmup_account,
            warmup_all_accounts,
            // Process detection
            check_codex_processes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
