use anyhow::Result;
use mcode_core::config::claude::ClaudeConfig;
use mcode_core::process::manager::ProcessManager;
use mcode_core::process::provider::SpawnConfig;
use mcode_core::store::models::{
    Message, MessageRole, Thread, ThreadMode, ThreadStatus, Workspace,
};
use mcode_core::workspace::repository::{MessageRepo, ThreadRepo, WorkspaceRepo};
use mcode_core::worktree::WorktreeManager;
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;
use uuid::Uuid;

/// Central application state shared across commands.
pub struct AppState {
    pub process_manager: ProcessManager,
    pub db: Arc<Mutex<Connection>>,
}

impl AppState {
    pub fn new(db_path: &str) -> Result<Self> {
        // Run migrations
        mcode_core::store::run_migrations(db_path)?;

        // Open connection
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        Ok(Self {
            process_manager: ProcessManager::default(),
            db: Arc::new(Mutex::new(conn)),
        })
    }

    // -- Workspace commands --

    pub async fn create_workspace(&self, name: &str, path: &str) -> Result<Workspace> {
        let conn = self.db.lock().await;
        WorkspaceRepo::create(&conn, name, path)
    }

    pub async fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.db.lock().await;
        WorkspaceRepo::list_all(&conn)
    }

    pub async fn delete_workspace(&self, id: &Uuid) -> Result<bool> {
        let conn = self.db.lock().await;
        WorkspaceRepo::delete(&conn, id)
    }

    // -- Thread commands --

    pub async fn create_thread(
        &self,
        workspace_id: &Uuid,
        title: &str,
        mode: ThreadMode,
        branch: &str,
        workspace_path: &str,
    ) -> Result<Thread> {
        // Step 1: Create DB record first (with worktree_path = None)
        let conn = self.db.lock().await;
        let mut thread = ThreadRepo::create(&conn, workspace_id, title, mode.clone(), branch)?;
        drop(conn); // release lock before filesystem ops

        // Step 2: If worktree mode, create worktree on filesystem
        if mode == ThreadMode::Worktree {
            let sanitized_title = title
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == '-' {
                        c
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
                .to_lowercase();

            let ws_path = workspace_path.to_string();
            let sanitized = sanitized_title.clone();
            let wt_result =
                tokio::task::spawn_blocking(move || WorktreeManager::create(&ws_path, &sanitized))
                    .await?;

            match wt_result {
                Ok(info) => {
                    // Step 3: Update worktree_path in DB
                    let conn = self.db.lock().await;
                    ThreadRepo::update_worktree_path(&conn, &thread.id, &info.path)?;
                    thread.worktree_path = Some(info.path);
                }
                Err(e) => {
                    // Rollback: delete the DB row
                    let conn = self.db.lock().await;
                    let _ = ThreadRepo::hard_delete(&conn, &thread.id);
                    return Err(e);
                }
            }
        }

        Ok(thread)
    }

    pub async fn list_threads(&self, workspace_id: &Uuid) -> Result<Vec<Thread>> {
        let conn = self.db.lock().await;
        ThreadRepo::list_by_workspace(&conn, workspace_id, 100)
    }

    pub async fn delete_thread(&self, thread_id: &Uuid) -> Result<bool> {
        let conn = self.db.lock().await;
        ThreadRepo::soft_delete(&conn, thread_id)
    }

    // -- Agent commands --

    pub async fn send_message(&self, thread_id: &Uuid, content: &str) -> Result<u32> {
        // Fix 8: Guard double-spawn race before any DB writes
        if self.process_manager.is_running(thread_id).await {
            anyhow::bail!("Agent is already running for this thread");
        }

        // Fix 1: Load thread from DB to get workspace_id, then load workspace path
        let (session_name, cwd, is_resume) = {
            let conn = self.db.lock().await;

            let thread = ThreadRepo::find_by_id(&conn, thread_id)?
                .ok_or_else(|| anyhow::anyhow!("Thread not found: {}", thread_id))?;

            let workspace = WorkspaceRepo::find_by_id(&conn, &thread.workspace_id)?
                .ok_or_else(|| anyhow::anyhow!("Workspace not found: {}", thread.workspace_id))?;

            // Use worktree_path for worktree threads, otherwise workspace path
            let cwd = if thread.mode == ThreadMode::Worktree {
                thread.worktree_path.unwrap_or(workspace.path.clone())
            } else {
                workspace.path.clone()
            };

            let next_seq = {
                let msgs = MessageRepo::list_by_thread(&conn, thread_id, 1)?;
                msgs.last().map(|m| m.sequence + 1).unwrap_or(1)
            };
            MessageRepo::create(&conn, thread_id, MessageRole::User, content, next_seq)?;

            let session_name = format!("mcode-{}", thread_id);
            let has_messages = next_seq > 1;
            (session_name, cwd, has_messages)
        };

        // Spawn the agent process
        let config = SpawnConfig {
            session_name,
            prompt: content.to_string(),
            cwd,
            resume: is_resume,
        };

        let pid = self.process_manager.spawn(*thread_id, config).await?;

        // Update thread status to active
        {
            let conn = self.db.lock().await;
            ThreadRepo::update_status(&conn, thread_id, &ThreadStatus::Active)?;
        }

        info!(thread_id = %thread_id, pid = pid, "Agent started");
        Ok(pid)
    }

    pub async fn stop_agent(&self, thread_id: &Uuid) -> Result<()> {
        self.process_manager.terminate(thread_id).await?;

        let conn = self.db.lock().await;
        ThreadRepo::update_status(&conn, thread_id, &ThreadStatus::Paused)?;
        Ok(())
    }

    pub async fn active_agent_count(&self) -> usize {
        self.process_manager.active_count().await
    }

    // -- Message queries --

    pub async fn get_messages(&self, thread_id: &Uuid, limit: i64) -> Result<Vec<Message>> {
        let conn = self.db.lock().await;
        MessageRepo::list_by_thread(&conn, thread_id, limit)
    }

    // -- Config queries --

    pub fn discover_config(&self, workspace_path: &str) -> ClaudeConfig {
        ClaudeConfig::discover(workspace_path)
    }

    // -- Shutdown --

    pub async fn shutdown(&self) -> Vec<Uuid> {
        let terminated = self.process_manager.terminate_all().await;

        let conn = self.db.lock().await;
        for id in &terminated {
            // Fix 6: Log error instead of silencing
            if let Err(e) = ThreadRepo::update_status(&conn, id, &ThreadStatus::Interrupted) {
                tracing::error!(thread_id = %id, error = %e, "Failed to mark thread interrupted on shutdown");
            }
        }

        info!(count = terminated.len(), "Shutdown complete");
        terminated
    }
}
