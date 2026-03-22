use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ThreadStatus {
    Active,
    Paused,
    Interrupted,
    Errored,
    Archived,
    Completed,
    Deleted,
}

impl ThreadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Interrupted => "interrupted",
            Self::Errored => "errored",
            Self::Archived => "archived",
            Self::Completed => "completed",
            Self::Deleted => "deleted",
        }
    }
}

impl fmt::Display for ThreadStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ThreadStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "interrupted" => Ok(Self::Interrupted),
            "errored" => Ok(Self::Errored),
            "archived" => Ok(Self::Archived),
            "completed" => Ok(Self::Completed),
            "deleted" => Ok(Self::Deleted),
            _ => Err(format!("unknown thread status: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ThreadMode {
    Direct,
    Worktree,
}

impl ThreadMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Worktree => "worktree",
        }
    }
}

impl fmt::Display for ThreadMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ThreadMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "direct" => Ok(Self::Direct),
            "worktree" => Ok(Self::Worktree),
            _ => Err(format!("unknown thread mode: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

impl MessageRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

impl fmt::Display for MessageRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MessageRole {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            "system" => Ok(Self::System),
            _ => Err(format!("unknown message role: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub provider_config: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub title: String,
    pub status: ThreadStatus,
    pub mode: ThreadMode,
    pub worktree_path: Option<String>,
    pub branch: String,
    pub issue_number: Option<i64>,
    pub pr_number: Option<i64>,
    pub pr_status: Option<String>,
    pub session_name: String,
    pub pid: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub role: MessageRole,
    pub content: String,
    pub tool_calls: Option<serde_json::Value>,
    pub files_changed: Option<serde_json::Value>,
    pub cost_usd: Option<f64>,
    pub tokens_used: Option<i64>,
    pub timestamp: DateTime<Utc>,
    pub sequence: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_status_roundtrip() {
        let statuses = vec![
            ThreadStatus::Active,
            ThreadStatus::Paused,
            ThreadStatus::Interrupted,
            ThreadStatus::Errored,
            ThreadStatus::Archived,
            ThreadStatus::Completed,
            ThreadStatus::Deleted,
        ];
        for status in statuses {
            let s = status.as_str();
            let parsed: ThreadStatus = s.parse().unwrap();
            assert_eq!(status, parsed);
        }
    }

    #[test]
    fn thread_mode_roundtrip() {
        assert_eq!("direct".parse::<ThreadMode>().unwrap(), ThreadMode::Direct);
        assert_eq!(
            "worktree".parse::<ThreadMode>().unwrap(),
            ThreadMode::Worktree
        );
        assert!("invalid".parse::<ThreadMode>().is_err());
    }

    #[test]
    fn message_role_roundtrip() {
        assert_eq!("user".parse::<MessageRole>().unwrap(), MessageRole::User);
        assert_eq!(
            "assistant".parse::<MessageRole>().unwrap(),
            MessageRole::Assistant
        );
        assert_eq!(
            "system".parse::<MessageRole>().unwrap(),
            MessageRole::System
        );
        assert!("invalid".parse::<MessageRole>().is_err());
    }

    #[test]
    fn workspace_serializes_to_json() {
        let ws = Workspace {
            id: Uuid::new_v4(),
            name: "test".to_string(),
            path: "/tmp/test".to_string(),
            provider_config: serde_json::json!({}),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains("test"));
    }
}
