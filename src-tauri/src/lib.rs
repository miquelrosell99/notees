// Minimal Tauri v2 shell: a single window hosting the Notees web client.
// The web app's own boot flow handles server URL + login; no native commands
// for v1, and no native SQLite plumbing — the store rides sql.js/OPFS in the
// webview and degrades gracefully where OPFS is unavailable.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running the Notees desktop shell");
}
