use anyhow::Result;
use std::collections::HashMap;
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use super::provider::{AgentHandle, ClaudeProvider, SpawnConfig};

/// Manages running agent processes with concurrency limits.
pub struct ProcessManager {
    processes: Mutex<HashMap<Uuid, AgentHandle>>,
    max_concurrent: usize,
}

impl ProcessManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            max_concurrent,
        }
    }

    /// Spawn a new agent process for the given thread.
    pub async fn spawn(&self, thread_id: Uuid, config: SpawnConfig) -> Result<u32> {
        let mut procs = self.processes.lock().await;

        if procs.len() >= self.max_concurrent {
            anyhow::bail!(
                "Max concurrent agents ({}) reached. Stop an agent before starting a new one.",
                self.max_concurrent
            );
        }

        let handle = ClaudeProvider::spawn(config)?;
        let pid = handle.pid;
        procs.insert(thread_id, handle);

        info!(thread_id = %thread_id, pid = pid, "Agent spawned");
        Ok(pid)
    }

    /// Terminate a specific agent process.
    pub async fn terminate(&self, thread_id: &Uuid) -> Result<()> {
        let mut procs = self.processes.lock().await;
        if let Some(mut handle) = procs.remove(thread_id) {
            handle.terminate().await?;
            info!(thread_id = %thread_id, "Agent terminated");
        } else {
            warn!(thread_id = %thread_id, "No running agent found");
        }
        Ok(())
    }

    /// Terminate all running agent processes. Returns IDs of terminated agents.
    pub async fn terminate_all(&self) -> Vec<Uuid> {
        let mut procs = self.processes.lock().await;
        let mut terminated = Vec::new();

        for (id, mut handle) in procs.drain() {
            if let Err(e) = handle.terminate().await {
                warn!(thread_id = %id, error = %e, "Failed to terminate agent");
            }
            terminated.push(id);
        }

        info!(count = terminated.len(), "All agents terminated");
        terminated
    }

    /// Take the event receiver for a thread's agent process.
    /// Returns None if the thread has no running agent.
    pub async fn take_events(
        &self,
        thread_id: &Uuid,
    ) -> Option<tokio::sync::mpsc::Receiver<super::stream::StreamEvent>> {
        let mut procs = self.processes.lock().await;
        procs.get_mut(thread_id).map(|h| {
            let (_, rx) = tokio::sync::mpsc::channel(1);
            std::mem::replace(&mut h.events, rx)
        })
    }

    /// Get the number of currently running agents.
    pub async fn active_count(&self) -> usize {
        self.processes.lock().await.len()
    }

    /// Check if a specific thread has a running agent.
    pub async fn is_running(&self, thread_id: &Uuid) -> bool {
        self.processes.lock().await.contains_key(thread_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn new_manager_has_zero_active() {
        let manager = ProcessManager::new(5);
        assert_eq!(manager.active_count().await, 0);
    }

    #[tokio::test]
    async fn is_running_returns_false_for_unknown_thread() {
        let manager = ProcessManager::new(5);
        let id = Uuid::new_v4();
        assert!(!manager.is_running(&id).await);
    }

    #[tokio::test]
    async fn terminate_nonexistent_thread_is_ok() {
        let manager = ProcessManager::new(5);
        let id = Uuid::new_v4();
        // Should not error, just warn
        manager.terminate(&id).await.unwrap();
    }

    #[tokio::test]
    async fn terminate_all_on_empty_returns_empty_vec() {
        let manager = ProcessManager::new(5);
        let terminated = manager.terminate_all().await;
        assert!(terminated.is_empty());
    }
}
