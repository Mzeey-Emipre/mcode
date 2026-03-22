use anyhow::Result;
use std::process::ExitStatus;
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, info};

use super::stream::{parse_stream_line, StreamEvent};

/// Configuration for spawning an agent process.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    pub session_name: String,
    pub prompt: String,
    pub cwd: String,
    pub resume: bool,
}

/// Capabilities that a provider supports.
#[derive(Debug, Clone)]
pub struct ProviderCapabilities {
    pub supports_resume: bool,
    pub supports_streaming: bool,
    pub supports_tool_use: bool,
}

/// Claude CLI provider implementation.
pub struct ClaudeProvider;

impl ClaudeProvider {
    pub fn capabilities() -> ProviderCapabilities {
        ProviderCapabilities {
            supports_resume: true,
            supports_streaming: true,
            supports_tool_use: true,
        }
    }

    pub fn spawn(config: SpawnConfig) -> Result<AgentHandle> {
        let mut cmd = Command::new("claude");
        cmd.current_dir(&config.cwd);
        cmd.arg("--output-format").arg("stream-json");
        cmd.arg("--verbose");
        cmd.arg("--session-name").arg(&config.session_name);

        if config.resume {
            cmd.arg("--resume").arg(&config.session_name);
        }

        cmd.arg("-p").arg(&config.prompt);

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        info!(
            session = %config.session_name,
            cwd = %config.cwd,
            resume = config.resume,
            "Spawning Claude CLI"
        );

        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take().expect("stdout must be piped");

        let (event_tx, event_rx) = mpsc::channel::<StreamEvent>(512);

        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(event) = parse_stream_line(&line) {
                    if event_tx.send(event).await.is_err() {
                        debug!("Event receiver dropped, stopping stream reader");
                        break;
                    }
                }
            }
        });

        Ok(AgentHandle {
            child,
            pid,
            events: event_rx,
        })
    }
}

/// Handle to a running agent process.
pub struct AgentHandle {
    child: Child,
    pub pid: u32,
    pub events: mpsc::Receiver<StreamEvent>,
}

impl AgentHandle {
    pub async fn terminate(&mut self) -> Result<ExitStatus> {
        info!(pid = self.pid, "Terminating agent process");
        self.child.kill().await?;
        let status = self.child.wait().await?;
        Ok(status)
    }

    pub async fn wait(&mut self) -> Result<ExitStatus> {
        let status = self.child.wait().await?;
        Ok(status)
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}
