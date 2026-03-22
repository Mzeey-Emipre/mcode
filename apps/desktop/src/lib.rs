use mcode_api::commands::AppState;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tracing_appender::rolling;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

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
    // Validate workspace path
    let ws_path = std::path::Path::new(&path);
    if !ws_path.is_absolute() {
        return Err("Workspace path must be absolute".into());
    }
    if !ws_path.is_dir() {
        return Err("Workspace path must be an existing directory".into());
    }

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
) -> Result<String, String> {
    let ws_uuid = uuid::Uuid::parse_str(&workspace_id).map_err(|e| e.to_string())?;
    let thread_mode = match mode.as_str() {
        "worktree" => mcode_api::mcode_core::store::models::ThreadMode::Worktree,
        "direct" => mcode_api::mcode_core::store::models::ThreadMode::Direct,
        other => return Err(format!("Unknown thread mode: {other}")),
    };
    let thread = state
        .create_thread(&ws_uuid, &title, thread_mode, &branch)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&thread).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_thread(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: String,
    cleanup_worktree: bool,
) -> Result<bool, String> {
    let uuid = uuid::Uuid::parse_str(&thread_id).map_err(|e| e.to_string())?;
    state
        .delete_thread(&uuid, cleanup_worktree)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    thread_id: String,
    content: String,
) -> Result<u32, String> {
    let uuid = uuid::Uuid::parse_str(&thread_id).map_err(|e| e.to_string())?;
    let pid = state
        .send_message(&uuid, &content)
        .await
        .map_err(|e| e.to_string())?;

    // Start streaming events from the agent to the frontend
    let events = state.take_events(&uuid).await;
    if let Some(mut rx) = events {
        let app_handle = app.clone();
        let tid = thread_id.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let payload = serde_json::json!({
                    "thread_id": tid,
                    "event": event,
                });
                let _ = app_handle.emit("agent-event", payload);
            }
            // Agent process finished
            let _ = app_handle.emit("agent-event", serde_json::json!({
                "thread_id": tid,
                "event": { "type": "agent_finished" },
            }));
        });
    }

    Ok(pid)
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

#[tauri::command]
fn get_log_path() -> Result<String, String> {
    let log_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".mcode")
        .join("logs");
    Ok(log_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn get_recent_logs(lines: usize) -> Result<String, String> {
    let log_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".mcode")
        .join("logs");

    // Find the most recent log file
    let mut entries: Vec<_> = std::fs::read_dir(&log_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .file_name()
                .map(|n| n.to_string_lossy().starts_with("mcode.log"))
                .unwrap_or(false)
        })
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.metadata().ok().and_then(|m| m.modified().ok())));

    let latest = entries
        .first()
        .ok_or_else(|| "No log files found".to_string())?;
    let content = std::fs::read_to_string(latest.path()).map_err(|e| e.to_string())?;

    // Return last N lines
    let result: Vec<&str> = content.lines().rev().take(lines).collect();
    Ok(result.into_iter().rev().collect::<Vec<_>>().join("\n"))
}

// -- Runtime helper --

/// Returns the current tokio runtime handle, or lazily creates a fallback runtime.
/// This is needed because Tauri's dialog callbacks may run on a non-tokio thread.
fn get_runtime_handle() -> tokio::runtime::Handle {
    tokio::runtime::Handle::try_current().unwrap_or_else(|_| {
        static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
        RT.get_or_init(|| {
            tokio::runtime::Runtime::new().expect("Failed to create fallback runtime")
        })
        .handle()
        .clone()
    })
}

// -- App setup --

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set up rotating file logger alongside stderr
    let log_dir = dirs::home_dir()
        .expect("Could not find home directory")
        .join(".mcode")
        .join("logs");
    std::fs::create_dir_all(&log_dir).expect("Could not create log directory");

    let file_appender = rolling::daily(&log_dir, "mcode.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()))
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(fmt::layer().json().with_writer(non_blocking))
        .init();

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
            get_log_path,
            get_recent_logs,
        ])
        .on_window_event({
            let state = app_state.clone();
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = state.clone();
                    let handle = window.app_handle().clone();

                    // Check if agents are running
                    let rt = get_runtime_handle();
                    let count = rt.block_on(state.active_agent_count());

                    if count > 0 {
                        // Prevent immediate close
                        api.prevent_close();

                        let msg = format!(
                            "{count} agent{} still working. \
                             They'll resume when you reopen Mcode.",
                            if count == 1 { " is" } else { "s are" }
                        );

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
                                        // Use get_runtime_handle() since the
                                        // callback may run on a non-tokio thread.
                                        let rt = get_runtime_handle();
                                        rt.block_on(state.shutdown());
                                        handle.exit(0);
                                    }
                                }
                            });
                    } else {
                        // No agents, shut down immediately
                        rt.block_on(state.shutdown());
                        handle.exit(0);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Mcode");
}
