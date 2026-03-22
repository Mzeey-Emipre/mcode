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
        // If worktree mode, create the worktree first
        let worktree_path = if mode == ThreadMode::Worktree {
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
            let wt_info = WorktreeManager::create(workspace_path, &sanitized_title)?;
            Some(wt_info.path)
        } else {
            None
        };

        let conn = self.db.lock().await;
        let mut thread = ThreadRepo::create(&conn, workspace_id, title, mode, branch)?;
        thread.worktree_path = worktree_path;
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

    pub async fn send_message(
        &self,
        thread_id: &Uuid,
        content: &str,
        workspace_path: &str,
    ) -> Result<u32> {
        // Store user message and determine session context
        let (session_name, cwd, is_resume) = {
            let conn = self.db.lock().await;
            let next_seq = {
                let msgs = MessageRepo::list_by_thread(&conn, thread_id, 1)?;
                msgs.last().map(|m| m.sequence + 1).unwrap_or(1)
            };
            MessageRepo::create(&conn, thread_id, MessageRole::User, content, next_seq)?;

            let session_name = format!("mcode-{}", thread_id);
            let has_messages = next_seq > 1;
            (session_name, workspace_path.to_string(), has_messages)
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
            let _ = ThreadRepo::update_status(&conn, id, &ThreadStatus::Interrupted);
        }

        info!(count = terminated.len(), "Shutdown complete");
        terminated
    }
}
