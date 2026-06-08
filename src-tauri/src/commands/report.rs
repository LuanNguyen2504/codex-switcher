//! Quota report export Tauri commands.

use std::fs;
use std::path::Path;

/// Export a generated quota report as a UTF-8 text file.
///
/// Purpose:
///   Writes the frontend-generated Markdown quota report to the path selected by the user.
/// Inputs:
///   path - Required filesystem path chosen by the save dialog; must be writable by the app.
///   contents - Required Markdown report text to write as UTF-8.
/// Output:
///   Returns `Ok(())` after the file is written.
/// Errors:
///   Returns an error string when the target directory cannot be created or the file write fails.
/// Side Effects:
///   Creates parent directories when needed and writes or overwrites the target file.
#[tauri::command]
pub async fn export_quota_report_text_file(path: String, contents: String) -> Result<(), String> {
    let target = Path::new(&path);
    if let Some(parent) = target.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::write(target, contents).map_err(|error| error.to_string())
}
