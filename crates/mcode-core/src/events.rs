use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum McodeEvent {
    AgentOutput {
        thread_id: Uuid,
        content: String,
        tool_calls: Option<serde_json::Value>,
    },
    AgentStatusChanged {
        thread_id: Uuid,
        status: String,
    },
    AgentError {
        thread_id: Uuid,
        error: String,
    },
    AgentFinished {
        thread_id: Uuid,
        exit_code: i32,
    },
}
