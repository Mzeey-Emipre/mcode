use tracing_subscriber::{fmt, EnvFilter};

#[tauri::command]
fn get_version() -> String {
    mcode_api::api_version().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    tracing::info!("Mcode v{} starting", mcode_api::api_version());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![get_version])
        .run(tauri::generate_context!())
        .expect("error while running Mcode");
}
