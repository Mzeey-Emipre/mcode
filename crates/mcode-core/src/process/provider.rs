use anyhow::{Context, Result};
use std::path::Path;
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
        // Validate session_name
        anyhow::ensure!(
            config.session_name.len() <= 255
                && !config.session_name.is_empty()
                && config
                    .session_name
                    .bytes()
                    .all(|b| b != 0 && b.is_ascii_graphic()),
            "invalid session_name: must be 1-255 ASCII printable characters"
        );

        // Validate cwd
        let cwd_path = Path::new(&config.cwd);
        anyhow::ensure!(
            cwd_path.is_absolute(),
            "cwd must be an absolute path: {}",
            config.cwd
        );
        anyhow::ensure!(
            cwd_path.is_dir(),
            "cwd must be an existing directory: {}",
            config.cwd
        );

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
        cmd.kill_on_drop(true);

        info!(
            session = %config.session_name,
            cwd = %config.cwd,
            resume = config.resume,
            "Spawning Claude CLI"
        );

        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take().context("Claude stdout was not piped")?;
        let stderr = child.stderr.take().context("Claude stderr was not piped")?;

        // Drain stderr to prevent child stalls
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(stderr = %line, "Claude CLI stderr");
            }
        });

        let (event_tx, event_rx) = mpsc::channel::<StreamEvent>(512);

        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match parse_stream_line(&line) {
                    Some(event) => {
                        if event_tx.send(event).await.is_err() {
                            debug!("Event receiver dropped, stopping stream reader");
                            break;
                        }
                    }
                    None => {
                        tracing::debug!(raw = %line, "Unparsed Claude CLI output line");
                    }
                }
            }
        });

        Ok(AgentHandle {
            child,
            pid,
            events: Some(event_rx),
        })
    }
}

/// Handle to a running agent process.
pub struct AgentHandle {
    child: Child,
    pub pid: u32,
    pub events: Option<mpsc::Receiver<StreamEvent>>,
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
