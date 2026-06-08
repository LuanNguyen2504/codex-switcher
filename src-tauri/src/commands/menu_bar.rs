//! Native menu bar quota display and quick-switch actions.
//!
//! Purpose:
//!   Bridges React quota snapshots to native Tauri tray/menu-bar UI, custom popup windows, and
//!   macOS window visibility behavior.
//! Inputs:
//!   Receives credential-free quota snapshots and command invocations from the frontend.
//! Output:
//!   Updates the native tray title, icon, popup, and fallback menu actions.
//! Errors:
//!   Returns Tauri errors for tray/menu/window creation and string command errors for frontend
//!   invocations.
//! Side Effects:
//!   Creates native tray icons and webview popups, emits frontend events, shows or hides windows,
//!   and changes macOS activation policy.

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    Wry,
};

const MENU_BAR_TRAY_ID: &str = "quota-menu-bar";
const QUOTA_POPUP_WINDOW_LABEL: &str = "quota-popup";
const MENU_ACTION_SHOW_WINDOW: &str = "menu-bar:show-window";
const MENU_ACTION_REFRESH_QUOTA: &str = "menu-bar:refresh-quota";
const MENU_ACTION_QUIT: &str = "menu-bar:quit";
const EVENT_TRAY_ACTIVE_REFRESH_REQUESTED: &str = "tray-active-refresh-requested";
const EVENT_TRAY_REFRESH_REQUESTED: &str = "tray-refresh-requested";
const EVENT_TRAY_ERROR: &str = "tray-error";
const TRAY_POPUP_WIDTH: f64 = 560.0;
const TRAY_POPUP_HEIGHT: f64 = 420.0;
const MENU_BAR_ICON_WIDTH: usize = 18;
const MENU_BAR_ICON_HEIGHT: usize = 18;

/// RGBA color used by generated menu bar icons.
///
/// Purpose:
///   Keeps the compact app identity mark readable in the native macOS menu bar.
/// Inputs:
///   Constructed from static color channels in icon drawing helpers.
/// Output:
///   Used by `draw_antialiased_dot` to write icon pixels.
/// Errors:
///   Does not throw.
/// Side Effects:
///   None.
#[derive(Debug, Clone, Copy)]
struct RgbaColor {
    /// Red color channel in the inclusive `0..255` range.
    red: u8,
    /// Green color channel in the inclusive `0..255` range.
    green: u8,
    /// Blue color channel in the inclusive `0..255` range.
    blue: u8,
    /// Alpha color channel in the inclusive `0..255` range.
    alpha: u8,
}

/// Account quota row received from the frontend for menu bar rendering.
///
/// Purpose:
///   Carries only display-safe account metadata and quota fields into the native tray menu.
/// Inputs:
///   Deserialized from the `update_menu_bar_quota` command payload.
/// Output:
///   Used to build menu item labels and switch action IDs.
/// Errors:
///   Serde returns a command error if required fields are missing or have incompatible types.
/// Side Effects:
///   None.
#[derive(Debug, Clone, Deserialize)]
pub struct MenuBarQuotaAccountPayload {
    /// Account ID used by quick-switch menu item actions.
    pub id: String,
    /// Email-first display label shown in the menu.
    pub email: String,
    /// Account display name used as a fallback identity.
    pub name: String,
    /// Whether this account is currently active.
    pub is_active: bool,
    /// Whether the user starred this account for quota priority.
    pub priority_quota_enabled: bool,
    /// Remaining primary, five-hour quota percentage.
    pub primary_remaining_percent: Option<f64>,
    /// Primary, five-hour reset Unix timestamp in seconds.
    pub primary_resets_at: Option<i64>,
    /// Remaining weekly quota percentage.
    pub secondary_remaining_percent: Option<f64>,
    /// Weekly reset Unix timestamp in seconds.
    pub secondary_resets_at: Option<i64>,
    /// Latest quota reload error for the account, when present.
    pub error: Option<String>,
    /// Whether the account currently has selectable quota in both tracked windows.
    pub selectable: bool,
}

/// Complete menu bar quota snapshot received from the frontend.
///
/// Purpose:
///   Replaces the native tray title and account quick-switch menu after account or quota state
///   changes.
/// Inputs:
///   Deserialized from the `update_menu_bar_quota` command payload.
/// Output:
///   Used by `update_menu_bar_quota` to rebuild the tray menu.
/// Errors:
///   Serde returns a command error if required fields are missing or have incompatible types.
/// Side Effects:
///   None.
#[derive(Debug, Clone, Deserialize)]
pub struct MenuBarQuotaSnapshotPayload {
    /// Snapshot generation Unix timestamp in seconds.
    pub generated_at: i64,
    /// Active account ID at the time the snapshot was generated.
    pub active_account_id: Option<String>,
    /// Account rows sorted by the frontend's shared quota priority comparator.
    pub accounts: Vec<MenuBarQuotaAccountPayload>,
}

/// Event payload emitted when a menu bar action fails.
///
/// Purpose:
///   Sends native tray failures back to the React UI for toast/log display.
/// Inputs:
///   message - Required human-readable error message.
/// Output:
///   Serialized as the `tray-error` event payload.
/// Errors:
///   Event emission may fail if there are no active listeners.
/// Side Effects:
///   None by itself; emitted by tray action handlers.
#[derive(Debug, Clone, Serialize)]
pub struct MenuBarErrorEvent {
    /// Human-readable native menu action failure.
    pub message: String,
}

/// Initializes the menu bar quota tray with an empty placeholder state.
///
/// Purpose:
///   Ensures the app is visible from the macOS menu bar even when the main window is hidden and
///   before the frontend sends the first quota snapshot.
/// Inputs:
///   app - Required Tauri app handle used to create the tray icon and menu.
/// Output:
///   Returns `Ok(())` after the tray exists.
/// Errors:
///   Returns a Tauri error if tray or menu creation fails.
/// Side Effects:
///   Creates a native tray/menu bar item and registers menu event handlers.
pub fn setup_menu_bar_quota_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(MENU_BAR_TRAY_ID).is_some() {
        return Ok(());
    }

    let snapshot = MenuBarQuotaSnapshotPayload {
        generated_at: chrono::Utc::now().timestamp(),
        active_account_id: None,
        accounts: Vec::new(),
    };
    let menu = build_menu_bar_menu(app, &snapshot)?;
    let builder = TrayIconBuilder::with_id(MENU_BAR_TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .title("")
        .tooltip("Codex Switcher quota")
        .icon(build_menu_bar_icon(&snapshot))
        .icon_as_template(false)
        .on_tray_icon_event(handle_tray_icon_event)
        .on_menu_event(handle_menu_bar_event);

    builder.build(app)?;
    Ok(())
}

/// Installs the main-window close behavior expected by the menu-bar app mode.
///
/// Purpose:
///   Converts native close requests for the main window into a hide action so Codex Switcher keeps
///   running from the macOS menu bar.
/// Inputs:
///   app - Required app handle used to find the main window and update the macOS activation policy.
/// Output:
///   Returns `Ok(())` after the handler has been registered, or when the main window is not yet
///   available.
/// Errors:
///   Does not return operation failures because close-time hide, Dock visibility, and activation
///   updates are best-effort UI state changes.
/// Side Effects:
///   Registers a native close-request listener that prevents the window from being destroyed, hides
///   it, removes it from the Dock/taskbar, and returns the app to menu-bar-only mode on macOS.
pub fn setup_main_window_dock_behavior(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let app_for_event = app.clone();
        let window_for_event = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_for_event.hide();
                let _ = window_for_event.set_skip_taskbar(true);
                #[cfg(target_os = "macos")]
                let _ = app_for_event.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }

    Ok(())
}

/// Updates the native menu bar quota title and quick-switch menu.
///
/// Purpose:
///   Receives fresh account quota state from the React app after initial load, manual reloads, and
///   automatic reloads.
/// Inputs:
///   app - Required Tauri app handle injected by the command runtime.
///   snapshot - Required sorted, credential-free account quota snapshot.
/// Output:
///   Returns `Ok(())` after the tray menu and title are updated.
/// Errors:
///   Returns a string error if tray creation, menu creation, title update, tooltip update, or menu
///   replacement fails.
/// Side Effects:
///   Creates or updates the native tray/menu bar item.
#[tauri::command]
pub async fn update_menu_bar_quota(
    app: AppHandle,
    snapshot: MenuBarQuotaSnapshotPayload,
) -> Result<(), String> {
    setup_menu_bar_quota_tray(&app).map_err(|e| e.to_string())?;
    let tray = app
        .tray_by_id(MENU_BAR_TRAY_ID)
        .ok_or_else(|| "Menu bar tray was not created".to_string())?;
    let menu = build_menu_bar_menu(&app, &snapshot).map_err(|e| e.to_string())?;
    tray.set_icon(Some(build_menu_bar_icon(&snapshot)))
        .map_err(|e| e.to_string())?;
    tray.set_icon_as_template(false)
        .map_err(|e| e.to_string())?;
    tray.set_title(Some(build_menu_bar_title(&snapshot)))
        .map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(build_menu_bar_tooltip(&snapshot)))
        .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Shows the hidden main application window from a popup or backend command.
///
/// Purpose:
///   Lets the custom HTML tray popup reveal the full Codex Switcher UI without using the native
///   menu fallback.
/// Inputs:
///   app - Required Tauri app handle injected by the command runtime.
/// Output:
///   Returns `Ok(())` after the main window show/focus calls have been attempted.
/// Errors:
///   Does not return operation failures because missing windows and focus failures are non-fatal.
/// Side Effects:
///   Shows, unminimizes, and focuses the main window when it exists.
#[tauri::command]
pub async fn show_codex_switcher_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

/// Hides the custom quota popup window.
///
/// Purpose:
///   Lets the popup close itself after button actions and keeps the window reusable for future tray
///   clicks.
/// Inputs:
///   app - Required Tauri app handle injected by the command runtime.
/// Output:
///   Returns `Ok(())` after the popup has been hidden or if it does not exist.
/// Errors:
///   Returns a string error if the native hide call fails.
/// Side Effects:
///   Hides the `quota-popup` webview window.
#[tauri::command]
pub async fn hide_quota_popup(app: AppHandle) -> Result<(), String> {
    hide_quota_popup_window(&app).map_err(|error| error.to_string())
}

/// Exits the Codex Switcher application from the popup.
///
/// Purpose:
///   Provides a webview button equivalent to the native `Quit Codex Switcher` menu item.
/// Inputs:
///   app - Required Tauri app handle injected by the command runtime.
/// Output:
///   Returns `Ok(())`; the process exits immediately afterward.
/// Errors:
///   Does not throw.
/// Side Effects:
///   Terminates the app process through Tauri.
#[tauri::command]
pub async fn quit_codex_switcher_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// Builds the tray menu for a quota snapshot.
///
/// Purpose:
///   Renders account quota details and quick-switch actions in the account order supplied by the
///   frontend.
/// Inputs:
///   app - Required app handle used to create native menu items.
///   snapshot - Required account quota snapshot.
/// Output:
///   Returns a Tauri `Menu` ready to attach to the tray icon.
/// Errors:
///   Returns a Tauri error if any native menu item cannot be created or appended.
/// Side Effects:
///   Allocates native menu items in Tauri's resource table.
fn build_menu_bar_menu(
    app: &AppHandle,
    snapshot: &MenuBarQuotaSnapshotPayload,
) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let show_window = MenuItemBuilder::with_id(MENU_ACTION_SHOW_WINDOW, "Open Codex Switcher")
        .build(app)?;
    let refresh = MenuItemBuilder::with_id(MENU_ACTION_REFRESH_QUOTA, "Reload Quota Now")
        .build(app)?;
    let summary = MenuItemBuilder::new(build_snapshot_summary(snapshot))
        .enabled(false)
        .build(app)?;

    menu.append(&show_window)?;
    menu.append(&refresh)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&summary)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let quit = MenuItemBuilder::with_id(MENU_ACTION_QUIT, "Quit Codex Switcher").build(app)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// Handles direct tray icon clicks.
///
/// Purpose:
///   Opens or toggles the custom HTML quota popup on left click while leaving the native menu
///   available as a minimal fallback for secondary-click behavior.
/// Inputs:
///   tray - Required tray icon that emitted the event.
///   event - Required tray mouse event including physical click position.
/// Output:
///   Returns nothing.
/// Errors:
///   Emits `tray-error` when popup creation or positioning fails.
/// Side Effects:
///   Emits an active-account reload request and creates, moves, shows, focuses, or hides the quota
///   popup window.
fn handle_tray_icon_event(tray: &TrayIcon<Wry>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        position,
        button,
        button_state,
        ..
    } = event
    {
        if button == MouseButton::Left && button_state == MouseButtonState::Up {
            let app = tray.app_handle();
            let _ = app.emit(EVENT_TRAY_ACTIVE_REFRESH_REQUESTED, ());
            if let Err(error) = toggle_quota_popup(app, position) {
                emit_menu_bar_error(app, error.to_string());
            }
        }
    }
}

/// Shows or hides the custom quota popup at the tray click position.
///
/// Purpose:
///   Replaces the visually limited native account menu with a reusable HTML/CSS popup that can
///   render real grid columns and colors.
/// Inputs:
///   app - Required app handle used to create and control the popup window.
///   position - Required physical click position from the tray event.
/// Output:
///   Returns `Ok(())` after the popup has been toggled.
/// Errors:
///   Returns Tauri errors from window creation, movement, show, focus, or hide calls.
/// Side Effects:
///   Creates a `quota-popup` webview window on first use and changes its visibility/position.
fn toggle_quota_popup(app: &AppHandle, position: PhysicalPosition<f64>) -> tauri::Result<()> {
    let popup = get_or_create_quota_popup(app)?;
    if popup.is_visible()? {
        popup.hide()?;
        return Ok(());
    }

    position_quota_popup(&popup, position)?;
    popup.show()?;
    popup.set_focus()?;
    Ok(())
}

/// Creates the custom quota popup window if it does not already exist.
///
/// Purpose:
///   Lazily allocates the lightweight webview used for the tray account dropdown.
/// Inputs:
///   app - Required app handle used to look up or build the popup window.
/// Output:
///   Returns the existing or newly created popup webview window.
/// Errors:
///   Returns a Tauri error when window creation fails.
/// Side Effects:
///   May create a hidden, borderless, always-on-top webview window and register focus handlers.
fn get_or_create_quota_popup(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    if let Some(window) = app.get_webview_window(QUOTA_POPUP_WINDOW_LABEL) {
        return Ok(window);
    }

    let popup = WebviewWindowBuilder::new(
        app,
        QUOTA_POPUP_WINDOW_LABEL,
        WebviewUrl::App("index.html?view=tray-popup".into()),
    )
    .title("Codex Switcher Quota")
    .inner_size(TRAY_POPUP_WIDTH, TRAY_POPUP_HEIGHT)
    .resizable(false)
    .decorations(false)
    .shadow(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(true)
    .build()?;

    let popup_for_event = popup.clone();
    popup.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(false)) {
            let _ = popup_for_event.hide();
        }
    });

    Ok(popup)
}

/// Positions the quota popup near the clicked tray icon.
///
/// Purpose:
///   Anchors the popup below the macOS menu bar item while keeping the panel inside the left edge
///   of the screen.
/// Inputs:
///   popup - Required webview window to move.
///   click_position - Required physical tray click coordinates.
/// Output:
///   Returns `Ok(())` after the native position has been applied.
/// Errors:
///   Returns a Tauri error if moving the window fails.
/// Side Effects:
///   Moves the popup webview window.
fn position_quota_popup(
    popup: &tauri::WebviewWindow<Wry>,
    click_position: PhysicalPosition<f64>,
) -> tauri::Result<()> {
    let x = (click_position.x - TRAY_POPUP_WIDTH + 28.0).max(8.0) as i32;
    let y = (click_position.y + 12.0).max(28.0) as i32;
    popup.set_position(PhysicalPosition::new(x, y))
}

/// Builds the compact quota title shown in the macOS menu bar.
///
/// Purpose:
///   Renders quota percentages with colored status dots using the native menu bar font.
/// Inputs:
///   snapshot - Required account quota snapshot.
/// Output:
///   Returns a short title using the native menu bar font.
/// Errors:
///   Does not throw.
/// Side Effects:
///   None.
fn build_menu_bar_title(snapshot: &MenuBarQuotaSnapshotPayload) -> String {
    let active = snapshot
        .active_account_id
        .as_ref()
        .and_then(|active_id| snapshot.accounts.iter().find(|account| &account.id == active_id));

    match active {
        Some(account) if account.error.is_some() => "• 5h --  • W --".to_string(),
        Some(account) => format!(
            "{} 5h {}  {} W {}",
            quota_text_dot(account.primary_remaining_percent),
            format_percent(account.primary_remaining_percent),
            quota_text_dot(account.secondary_remaining_percent),
            format_percent(account.secondary_remaining_percent)
        ),
        None => "Quota --".to_string(),
    }
}

/// Builds the tray tooltip for a quota snapshot.
///
/// Purpose:
///   Gives users a readable active-account summary when hovering the menu bar item.
/// Inputs:
///   snapshot - Required account quota snapshot.
/// Output:
///   Returns a tooltip string.
/// Errors:
///   Does not throw.
/// Side Effects:
///   None.
fn build_menu_bar_tooltip(snapshot: &MenuBarQuotaSnapshotPayload) -> String {
    let active = snapshot
        .active_account_id
        .as_ref()
        .and_then(|active_id| snapshot.accounts.iter().find(|account| &account.id == active_id));

    match active {
        Some(account) => format!(
            "{} - 5h {} reset {}, week {} reset {}",
            account_menu_identity(account),
            format_percent(account.primary_remaining_percent),
            format_time(account.primary_resets_at),
            format_percent(account.secondary_remaining_percent),
            format_time(account.secondary_resets_at)
        ),
        None => "Codex Switcher quota".to_string(),
    }
}

/// Builds the disabled snapshot summary menu row.
///
/// Purpose:
///   Shows when the native menu was last updated and how many accounts it contains.
/// Inputs:
///   snapshot - Required account quota snapshot.
/// Output:
///   Returns a menu row label.
/// Errors:
///   Does not throw.
/// Side Effects:
///   None.
fn build_snapshot_summary(snapshot: &MenuBarQuotaSnapshotPayload) -> String {
    format!(
        "Snapshot updated {}    {} account{}",
        format_time(Some(snapshot.generated_at)),
        snapshot.accounts.len(),
        if snapshot.accounts.len() == 1 { "" } else { "s" }
    )
}

/// Builds the app identity icon for the macOS menu bar.
///
/// Purpose:
///   Shows a compact app mark before the native text quota title.
/// Inputs:
///   snapshot - Required quota snapshot; currently unused but retained so setup and update paths
///   can share one icon builder contract.
/// Output:
///   Returns an owned 18x18 RGBA image.
/// Errors:
///   Does not throw.
/// Side Effects:
///   Allocates the icon pixel buffer.
fn build_menu_bar_icon(snapshot: &MenuBarQuotaSnapshotPayload) -> Image<'static> {
    let mut rgba = vec![0u8; MENU_BAR_ICON_WIDTH * MENU_BAR_ICON_HEIGHT * 4];
    let _ = snapshot;
    draw_app_menu_bar_mark(&mut rgba);

    Image::new_owned(
        rgba,
        MENU_BAR_ICON_WIDTH as u32,
        MENU_BAR_ICON_HEIGHT as u32,
    )
}

/// Draws the small app identity mark inside the menu bar icon.
///
/// Purpose:
///   Keeps the menu bar item branded while leaving room for two tiny colored quota dots.
/// Inputs:
///   rgba - Required mutable RGBA buffer sized for the menu bar icon.
/// Output:
///   Returns nothing.
/// Errors:
///   Does not throw.
/// Side Effects:
///   Mutates `rgba` by drawing a compact switch-style glyph.
fn draw_app_menu_bar_mark(rgba: &mut [u8]) {
    let color = RgbaColor {
        red: 186,
        green: 230,
        blue: 253,
        alpha: 235,
    };

    draw_antialiased_ring(rgba, 8.0, 8.5, 5.3, 1.25, color);
    draw_antialiased_dot(
        rgba,
        8.0,
        8.5,
        1.35,
        RgbaColor {
            red: 255,
            green: 255,
            blue: 255,
            alpha: 230,
        },
    );
    draw_antialiased_dot(
        rgba,
        12.5,
        5.0,
        1.45,
        RgbaColor {
            red: 96,
            green: 165,
            blue: 250,
            alpha: 255,
        },
    );
    draw_antialiased_dot(
        rgba,
        3.5,
        12.0,
        1.45,
        RgbaColor {
            red: 52,
            green: 211,
            blue: 153,
            alpha: 255,
        },
    );
}

/// Draws an antialiased ring into an RGBA icon buffer.
///
/// Purpose:
///   Provides a compact app glyph that remains legible at macOS menu bar size.
/// Inputs:
///   rgba - Required mutable RGBA buffer sized for the menu bar icon.
///   center_x - Required ring center x coordinate in physical icon pixels.
///   center_y - Required ring center y coordinate in physical icon pixels.
///   radius - Required ring radius in pixels.
///   stroke_width - Required stroke width in pixels.
///   color - Required RGBA color to blend into the buffer.
/// Output:
///   Returns nothing.
/// Errors:
///   Does not throw; pixels outside the fixed icon bounds are skipped.
/// Side Effects:
///   Mutates `rgba` with blended ring pixels.
fn draw_antialiased_ring(
    rgba: &mut [u8],
    center_x: f64,
    center_y: f64,
    radius: f64,
    stroke_width: f64,
    color: RgbaColor,
) {
    for y in 0..MENU_BAR_ICON_HEIGHT {
        for x in 0..MENU_BAR_ICON_WIDTH {
            let dx = x as f64 + 0.5 - center_x;
            let dy = y as f64 + 0.5 - center_y;
            let distance = (dx * dx + dy * dy).sqrt();
            let stroke_distance = (distance - radius).abs();
            let coverage = (stroke_width - stroke_distance).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                continue;
            }

            let offset = (y * MENU_BAR_ICON_WIDTH + x) * 4;
            rgba[offset] = color.red;
            rgba[offset + 1] = color.green;
            rgba[offset + 2] = color.blue;
            rgba[offset + 3] = ((color.alpha as f64) * coverage) as u8;
        }
    }
}

/// Draws an antialiased colored dot into an RGBA icon buffer.
///
/// Purpose:
///   Produces small, crisp menu bar quota dots without relying on font rendering.
/// Inputs:
///   rgba - Required mutable RGBA buffer sized for the menu bar icon.
///   center_x - Required dot center x coordinate in physical icon pixels.
///   center_y - Required dot center y coordinate in physical icon pixels.
///   radius - Required dot radius in pixels; values around `3.0` fit the menu bar well.
///   color - Required RGBA color to blend into the buffer.
/// Output:
///   Returns nothing.
/// Errors:
///   Does not throw; pixels outside the fixed icon bounds are skipped.
/// Side Effects:
///   Mutates `rgba` with blended dot pixels.
fn draw_antialiased_dot(
    rgba: &mut [u8],
    center_x: f64,
    center_y: f64,
    radius: f64,
    color: RgbaColor,
) {
    for y in 0..MENU_BAR_ICON_HEIGHT {
        for x in 0..MENU_BAR_ICON_WIDTH {
            let dx = x as f64 + 0.5 - center_x;
            let dy = y as f64 + 0.5 - center_y;
            let distance = (dx * dx + dy * dy).sqrt();
            let coverage = (radius + 0.75 - distance).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                continue;
            }

            let offset = (y * MENU_BAR_ICON_WIDTH + x) * 4;
            rgba[offset] = color.red;
            rgba[offset + 1] = color.green;
            rgba[offset + 2] = color.blue;
            rgba[offset + 3] = ((color.alpha as f64) * coverage) as u8;
        }
    }
}

/// Chooses the colored native text dot for a remaining quota value.
///
/// Purpose:
///   Places a quota status marker directly before the `5h` and `W` labels while keeping the menu
///   bar title text in the system font.
/// Inputs:
///   percent - Optional remaining quota percentage for the active account.
/// Output:
///   Returns a colored dot marker for the quota state.
/// Errors:
///   Does not throw.
/// Side Effects:
///   None.
fn quota_text_dot(percent: Option<f64>) -> &'static str {
    match percent {
        Some(value) if value <= 0.0 => "🔴",
        Some(value) if value < 20.0 => "🟠",
        Some(value) if value < 60.0 => "🟡",
        Some(_) => "🟢",
        None => "⚫",
    }
}

/// Returns the identity label for a menu bar account row.
///
/// Purpose:
///   Displays email when available while preserving a readable fallback for accounts without
///   email metadata.
/// Inputs:
///   account - Required account payload for a native menu row.
/// Output:
///   Returns the account email, account name, or `Unknown account`.
/// Errors:
///   Does not throw.
/// Side Effects:
///   None.
fn account_menu_identity(account: &MenuBarQuotaAccountPayload) -> &str {
    if !account.email.trim().is_empty() {
        return account.email.as_str();
    }
    if !account.name.trim().is_empty() {
        return account.name.as_str();
    }
    "Unknown account"
}

/// Handles clicks on native menu bar items.
///
/// Purpose:
///   Opens the hidden window, requests a quota refresh, or exits the app based on the activated
///   fallback menu item ID.
/// Inputs:
///   app - Required app handle supplied by Tauri.
///   event - Required menu event with the activated item ID.
/// Output:
///   Returns nothing.
/// Errors:
///   Operation errors are emitted as `tray-error` events.
/// Side Effects:
///   May show/focus the main window, emit frontend events, or exit the process.
fn handle_menu_bar_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if id == MENU_ACTION_SHOW_WINDOW {
        show_main_window(app);
        return;
    }
    if id == MENU_ACTION_REFRESH_QUOTA {
        let _ = app.emit(EVENT_TRAY_REFRESH_REQUESTED, ());
        return;
    }
    if id == MENU_ACTION_QUIT {
        app.exit(0);
    }
}

/// Shows and focuses the main app window from the menu bar.
///
/// Purpose:
///   Lets a menu-bar-only app reveal its full UI when the user selects `Open Codex Switcher`.
/// Inputs:
///   app - Required app handle used to find the main window.
/// Output:
///   Returns nothing.
/// Errors:
///   Window operation errors are ignored because the menu remains usable.
/// Side Effects:
///   Shows, unminimizes, and focuses the main window when it exists.
fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Hides the reusable quota popup window when it exists.
///
/// Purpose:
///   Centralizes popup hiding for commands, blur handling, and popup button actions.
/// Inputs:
///   app - Required app handle used to find the popup window.
/// Output:
///   Returns `Ok(())` when the popup is hidden or absent.
/// Errors:
///   Returns a Tauri error if the native hide operation fails.
/// Side Effects:
///   Hides the quota popup webview window.
fn hide_quota_popup_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(QUOTA_POPUP_WINDOW_LABEL) {
        window.hide()?;
    }
    Ok(())
}

/// Emits a native menu bar error event.
///
/// Purpose:
///   Reports tray action failures to the React UI without panicking inside the Tauri menu event
///   handler.
/// Inputs:
///   app - Required app handle used to emit the event.
///   message - Required human-readable error message.
/// Output:
///   Returns nothing.
/// Errors:
///   Ignores event emission failures because there may be no active frontend listener.
/// Side Effects:
///   Emits the `tray-error` event when possible.
fn emit_menu_bar_error(app: &AppHandle, message: String) {
    let _ = app.emit(EVENT_TRAY_ERROR, MenuBarErrorEvent { message });
}

/// Formats an optional quota percentage for compact menu display.
///
/// Purpose:
///   Renders known quota as a whole percentage and unknown quota as a placeholder.
/// Inputs:
///   percent - Optional remaining quota percentage in the inclusive `0..100` range.
/// Output:
///   Returns a string such as `72%` or `--`.
/// Errors:
///   Does not throw.
/// Side Effects:
///   None.
fn format_percent(percent: Option<f64>) -> String {
    percent
        .map(|value| format!("{:.0}%", value.clamp(0.0, 100.0)))
        .unwrap_or_else(|| "--".to_string())
}

/// Formats an optional Unix timestamp as local time.
///
/// Purpose:
///   Keeps reset times compact in menu rows while avoiding date clutter.
/// Inputs:
///   timestamp - Optional Unix timestamp in seconds.
/// Output:
///   Returns local `HH:mm:ss` when known, otherwise `--`.
/// Errors:
///   Does not throw.
/// Side Effects:
///   Reads the local timezone offset from the system clock.
fn format_time(timestamp: Option<i64>) -> String {
    timestamp
        .and_then(|value| chrono::DateTime::from_timestamp(value, 0))
        .map(|date_time| {
            date_time
                .with_timezone(&chrono::Local)
                .format("%H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| "--".to_string())
}
