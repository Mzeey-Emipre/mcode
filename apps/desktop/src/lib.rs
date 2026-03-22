use mcode_api::commands::AppState;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tracing_subscriber::{fmt, EnvFilter};

// -- Tauri commands --

#[tauri::command]
async fn get_version() -> String {
    mcode_api::api_version().to_string()
}

#[tauri::command]
async fn list_workspaces(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let workspaces = state.list_workspaces().await.map_err(|e| e.to_string())?;
    serde_json::to_string(&workspaces).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_workspace(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    path: String,
) -> Result<String, String> {
    let workspace = state
        .create_workspace(&name, &path)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&workspace).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_workspace(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state
        .delete_workspace(&uuid)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_threads(
    state: tauri::State<'_, Arc<AppState>>,
    workspace_id: String,
) -> Result<String, String> {
    let uuid = uuid::Uuid::parse_str(&workspace_id).map_err(|e| e.to_string())?;
    let threads = state.list_threads(&uuid).await.map_err(|e| e.to_string())?;
    serde_json::to_string(&threads).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_thread(
    state: tauri::State<'_, Arc<AppState>>,
    workspace_id: String,
    title: String,
    mode: String,
    branch: String,
    workspace_path: String,
) -> Result<String, String> {
    let ws_uuid = uuid::Uuid::parse_str(&workspace_id).map_err(|e| e.to_string())?;
    let thread_mode = match mode.as_str() {
        "worktree" => mcode_api::mcode_core::store::models::ThreadMode::Worktree,
        _ => mcode_api::mcode_core::store::models::ThreadMode::Direct,
    };
    let thread = state
        .create_thread(&ws_uuid, &title, thread_mode, &branch, &workspace_path)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&thread).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_thread(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: String,
) -> Result<bool, String> {
    let uuid = uuid::Uuid::parse_str(&thread_id).map_err(|e| e.to_string())?;
    state.delete_thread(&uuid).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: String,
    content: String,
    workspace_path: String,
) -> Result<u32, String> {
    let uuid = uuid::Uuid::parse_str(&thread_id).map_err(|e| e.to_string())?;
    state
        .send_message(&uuid, &content, &workspace_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop_agent(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: String,
) -> Result<(), String> {
    let uuid = uuid::Uuid::parse_str(&thread_id).map_err(|e| e.to_string())?;
    state.stop_agent(&uuid).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_messages(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: String,
    limit: i64,
) -> Result<String, String> {
    let uuid = uuid::Uuid::parse_str(&thread_id).map_err(|e| e.to_string())?;
    let messages = state
        .get_messages(&uuid, limit)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&messages).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_active_agent_count(state: tauri::State<'_, Arc<AppState>>) -> Result<usize, String> {
    Ok(state.active_agent_count().await)
}

#[tauri::command]
async fn discover_config(
    state: tauri::State<'_, Arc<AppState>>,
    workspace_path: String,
) -> Result<String, String> {
    let config = state.discover_config(&workspace_path);
    serde_json::to_string(&config.summary()).map_err(|e| e.to_string())
}

// -- App setup --

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    tracing::info!("Mcode v{} starting", mcode_api::api_version());

    // Initialize app state with database in ~/.mcode/
    let db_dir = dirs::home_dir()
        .expect("Could not find home directory")
        .join(".mcode");
    std::fs::create_dir_all(&db_dir).expect("Could not create ~/.mcode/ directory");
    let db_path = db_dir.join("mcode.db");

    let app_state = Arc::new(
        AppState::new(db_path.to_str().expect("Invalid db path"))
            .expect("Failed to initialize app state"),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![
            get_version,
            list_workspaces,
            create_workspace,
            delete_workspace,
            list_threads,
            create_thread,
            delete_thread,
            send_message,
            stop_agent,
            get_messages,
            get_active_agent_count,
            discover_config,
        ])
        .on_window_event({
            let state = app_state.clone();
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = state.clone();
                    let handle = window.app_handle().clone();

                    // Check if agents are running
                    let rt = tokio::runtime::Handle::current();
                    let count = rt.block_on(state.active_agent_count());

                    if count > 0 {
                        // Prevent immediate close
                        api.prevent_close();

                        let msg = format!(
                            "{count} agent{} still working. \
                             They'll resume when you reopen Mcode.",
                            if count == 1 { " is" } else { "s are" }
                        );

                        // Clone the tokio handle for use inside the dialog
                        // callback, which runs on a non-tokio thread where
                        // Handle::current() would panic.
                        let rt_for_callback = rt.clone();

                        // Show confirmation dialog via callback
                        handle
                            .dialog()
                            .message(msg)
                            .title("Agents Running")
                            .buttons(MessageDialogButtons::OkCancelCustom(
                                "Continue".into(),
                                "Cancel".into(),
                            ))
                            .show({
                                let state = state.clone();
                                let handle = handle.clone();
                                move |confirmed| {
                                    if confirmed {
                                        rt_for_callback.block_on(state.shutdown());
                                        handle.exit(0);
                                    }
                                }
                            });
                    } else {
                        // No agents, shut down immediately
                        rt.block_on(state.shutdown());
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Mcode");
}
