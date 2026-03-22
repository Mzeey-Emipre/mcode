use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info};

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<u64>,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

/// Messages from the sidecar (notifications)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum SidecarEvent {
    #[serde(rename = "session.message")]
    Message {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "type")]
        msg_type: String,
        content: String,
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        tokens: Option<i64>,
    },
    #[serde(rename = "session.delta")]
    Delta {
        #[serde(rename = "sessionId")]
        session_id: String,
        text: String,
    },
    #[serde(rename = "session.turnComplete")]
    TurnComplete {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
        #[serde(rename = "costUsd")]
        cost_usd: Option<f64>,
        #[serde(rename = "totalTokensIn")]
        total_tokens_in: Option<i64>,
        #[serde(rename = "totalTokensOut")]
        total_tokens_out: Option<i64>,
    },
    #[serde(rename = "session.error")]
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        error: String,
    },
    #[serde(rename = "session.ended")]
    Ended {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "session.system")]
    System {
        #[serde(rename = "sessionId")]
        session_id: String,
        subtype: String,
    },
    #[serde(rename = "bridge.ready")]
    BridgeReady {},
}

pub struct Sidecar {
    child: Child,
    stdin: Mutex<tokio::process::ChildStdin>,
    /// Held to keep the event channel open; dropping this signals the reader to stop.
    _keepalive_tx: mpsc::Sender<SidecarEvent>,
}

impl Sidecar {
    /// Start the Node.js sidecar process.
    pub async fn start(sidecar_script: &str) -> Result<(Self, mpsc::Receiver<SidecarEvent>)> {
        let mut child = Command::new("node")
            .arg(sidecar_script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Failed to spawn Node.js sidecar")?;

        let stdin = child.stdin.take().context("Failed to get sidecar stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("Failed to get sidecar stdout")?;
        let stderr = child
            .stderr
            .take()
            .context("Failed to get sidecar stderr")?;

        let (event_tx, event_rx) = mpsc::channel::<SidecarEvent>(256);

        // Read stdout for JSON-RPC messages
        let tx = event_tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }

                // Try to parse as a notification (has "method" but no "id")
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value.get("method").is_some() && value.get("id").is_none() {
                        // It's a notification - try serde enum first, fall back to manual
                        if let Ok(event) = serde_json::from_str::<SidecarEvent>(&line) {
                            if tx.send(event).await.is_err() {
                                break;
                            }
                        } else {
                            // Manual parsing for events that don't match the enum
                            let method = value["method"].as_str().unwrap_or("");
                            let params = &value["params"];
                            debug!(method = %method, "Parsing sidecar notification manually");

                            let event = match method {
                                "session.message" => Some(SidecarEvent::Message {
                                    session_id: params["sessionId"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                    msg_type: params["type"]
                                        .as_str()
                                        .unwrap_or("assistant")
                                        .to_string(),
                                    content: params["content"].as_str().unwrap_or("").to_string(),
                                    message_id: params["messageId"].as_str().map(|s| s.to_string()),
                                    tokens: params["tokens"].as_i64(),
                                }),
                                "session.turnComplete" => Some(SidecarEvent::TurnComplete {
                                    session_id: params["sessionId"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                    reason: params["reason"]
                                        .as_str()
                                        .unwrap_or("end_turn")
                                        .to_string(),
                                    cost_usd: params["costUsd"].as_f64(),
                                    total_tokens_in: params["totalTokensIn"].as_i64(),
                                    total_tokens_out: params["totalTokensOut"].as_i64(),
                                }),
                                "session.error" => Some(SidecarEvent::Error {
                                    session_id: params["sessionId"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                    error: params["error"]
                                        .as_str()
                                        .unwrap_or("Unknown error")
                                        .to_string(),
                                }),
                                "session.ended" => Some(SidecarEvent::Ended {
                                    session_id: params["sessionId"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                }),
                                "bridge.ready" => Some(SidecarEvent::BridgeReady {}),
                                _ => {
                                    debug!(method = %method, "Unknown sidecar notification");
                                    None
                                }
                            };

                            if let Some(event) = event {
                                if tx.send(event).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    // If it has "id", it's a response - log errors
                    if value.get("id").is_some() {
                        if let Some(err) = value.get("error") {
                            tracing::error!(error = %err, "Sidecar JSON-RPC error response");
                        }
                    }
                }
            }
            info!("Sidecar stdout reader ended");
        });

        // Drain stderr
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!(stderr = %line, "Sidecar stderr");
            }
        });

        info!("Node.js sidecar started");

        Ok((
            Self {
                child,
                stdin: Mutex::new(stdin),
                _keepalive_tx: event_tx,
            },
            event_rx,
        ))
    }

    /// Send a JSON-RPC request to the sidecar.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<u64> {
        let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let line = serde_json::to_string(&request)? + "\n";
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;

        debug!(method = %method, id = id, "Sent request to sidecar");
        Ok(id)
    }

    /// Send a message to a Claude session.
    pub async fn send_message(
        &self,
        session_id: &str,
        message: &str,
        cwd: &str,
        model: &str,
        resume: bool,
        permission_mode: &str,
    ) -> Result<u64> {
        self.send_request(
            "session.sendMessage",
            serde_json::json!({
                "sessionId": session_id,
                "message": message,
                "cwd": cwd,
                "model": model,
                "resumeSession": resume,
                "permissionMode": permission_mode,
            }),
        )
        .await
    }

    /// Stop a running session.
    pub async fn stop_session(&self, session_id: &str) -> Result<u64> {
        self.send_request(
            "session.stop",
            serde_json::json!({ "sessionId": session_id }),
        )
        .await
    }

    /// Shut down the sidecar process.
    pub async fn shutdown(&mut self) -> Result<()> {
        info!("Shutting down sidecar");
        self.child.kill().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_increments() {
        let id1 = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
        let id2 = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
        assert!(id2 > id1);
    }

    #[test]
    fn sidecar_event_message_deserializes() {
        let json = r#"{"method":"session.message","params":{"sessionId":"test-1","type":"assistant","content":"Hello","messageId":"msg_1","tokens":42}}"#;
        let event: SidecarEvent = serde_json::from_str(json).unwrap();
        match event {
            SidecarEvent::Message {
                session_id,
                msg_type,
                content,
                message_id,
                tokens,
            } => {
                assert_eq!(session_id, "test-1");
                assert_eq!(msg_type, "assistant");
                assert_eq!(content, "Hello");
                assert_eq!(message_id, Some("msg_1".to_string()));
                assert_eq!(tokens, Some(42));
            }
            _ => panic!("Expected Message event"),
        }
    }

    #[test]
    fn sidecar_event_turn_complete_deserializes() {
        let json = r#"{"method":"session.turnComplete","params":{"sessionId":"test-1","reason":"end_turn","costUsd":0.05,"totalTokensIn":100,"totalTokensOut":200}}"#;
        let event: SidecarEvent = serde_json::from_str(json).unwrap();
        match event {
            SidecarEvent::TurnComplete {
                session_id,
                reason,
                cost_usd,
                total_tokens_in,
                total_tokens_out,
            } => {
                assert_eq!(session_id, "test-1");
                assert_eq!(reason, "end_turn");
                assert_eq!(cost_usd, Some(0.05));
                assert_eq!(total_tokens_in, Some(100));
                assert_eq!(total_tokens_out, Some(200));
            }
            _ => panic!("Expected TurnComplete event"),
        }
    }

    #[test]
    fn sidecar_event_error_deserializes() {
        let json =
            r#"{"method":"session.error","params":{"sessionId":"test-1","error":"Rate limited"}}"#;
        let event: SidecarEvent = serde_json::from_str(json).unwrap();
        match event {
            SidecarEvent::Error { session_id, error } => {
                assert_eq!(session_id, "test-1");
                assert_eq!(error, "Rate limited");
            }
            _ => panic!("Expected Error event"),
        }
    }

    #[test]
    fn sidecar_event_bridge_ready_deserializes() {
        let json = r#"{"method":"bridge.ready","params":{}}"#;
        let event: SidecarEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(event, SidecarEvent::BridgeReady {}));
    }

    #[test]
    fn sidecar_event_ended_deserializes() {
        let json = r#"{"method":"session.ended","params":{"sessionId":"test-1"}}"#;
        let event: SidecarEvent = serde_json::from_str(json).unwrap();
        match event {
            SidecarEvent::Ended { session_id } => {
                assert_eq!(session_id, "test-1");
            }
            _ => panic!("Expected Ended event"),
        }
    }

    #[test]
    fn sidecar_event_serializes_roundtrip() {
        let event = SidecarEvent::Message {
            session_id: "test-1".to_string(),
            msg_type: "assistant".to_string(),
            content: "Hello".to_string(),
            message_id: None,
            tokens: Some(10),
        };
        let json = serde_json::to_string(&event).unwrap();
        let parsed: SidecarEvent = serde_json::from_str(&json).unwrap();
        match parsed {
            SidecarEvent::Message { content, .. } => assert_eq!(content, "Hello"),
            _ => panic!("Expected Message"),
        }
    }
}
