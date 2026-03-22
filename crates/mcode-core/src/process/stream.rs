use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "system")]
    System {
        subtype: String,
        #[serde(default)]
        data: Option<Value>,
    },
    #[serde(rename = "assistant")]
    Assistant { message: AssistantMessage },
    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: usize,
        content_block: ContentBlock,
    },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: usize, delta: Delta },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: usize },
    #[serde(rename = "result")]
    Result { result: ResultData },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Delta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultData {
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub tokens_used: Option<i64>,
    #[serde(default)]
    pub is_error: Option<bool>,
}

/// Parse a single line of stream-json output from Claude CLI.
/// Returns None for empty lines or unparseable lines.
pub fn parse_stream_line(line: &str) -> Option<StreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_system_event() {
        let line = r#"{"type":"system","subtype":"init","data":{"session_id":"abc"}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::System { subtype, .. } => assert_eq!(subtype, "init"),
            _ => panic!("Expected System event"),
        }
    }

    #[test]
    fn parse_system_event_without_data() {
        let line = r#"{"type":"system","subtype":"done"}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::System { subtype, data } => {
                assert_eq!(subtype, "done");
                assert!(data.is_none());
            }
            _ => panic!("Expected System event"),
        }
    }

    #[test]
    fn parse_text_delta() {
        let line = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::ContentBlockDelta {
                index,
                delta: Delta::TextDelta { text },
            } => {
                assert_eq!(index, 0);
                assert_eq!(text, "Hello world");
            }
            _ => panic!("Expected ContentBlockDelta with TextDelta"),
        }
    }

    #[test]
    fn parse_tool_use_block() {
        let line = r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"Read","input":{"path":"/tmp/test.rs"}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::ContentBlockStart {
                index,
                content_block: ContentBlock::ToolUse { id, name, .. },
            } => {
                assert_eq!(index, 1);
                assert_eq!(id, "tool_1");
                assert_eq!(name, "Read");
            }
            _ => panic!("Expected ContentBlockStart with ToolUse"),
        }
    }

    #[test]
    fn parse_result() {
        let line =
            r#"{"type":"result","result":{"cost_usd":0.05,"tokens_used":1500,"is_error":false}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Result { result } => {
                assert_eq!(result.cost_usd, Some(0.05));
                assert_eq!(result.tokens_used, Some(1500));
                assert_eq!(result.is_error, Some(false));
            }
            _ => panic!("Expected Result event"),
        }
    }

    #[test]
    fn parse_result_with_missing_fields() {
        let line = r#"{"type":"result","result":{}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Result { result } => {
                assert!(result.cost_usd.is_none());
                assert!(result.tokens_used.is_none());
                assert!(result.is_error.is_none());
            }
            _ => panic!("Expected Result event"),
        }
    }

    #[test]
    fn parse_content_block_stop() {
        let line = r#"{"type":"content_block_stop","index":0}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::ContentBlockStop { index } => assert_eq!(index, 0),
            _ => panic!("Expected ContentBlockStop"),
        }
    }

    #[test]
    fn parse_empty_line_returns_none() {
        assert!(parse_stream_line("").is_none());
        assert!(parse_stream_line("   ").is_none());
    }

    #[test]
    fn parse_invalid_json_returns_none() {
        assert!(parse_stream_line("not json at all").is_none());
        assert!(parse_stream_line("{invalid}").is_none());
    }

    #[test]
    fn parse_unknown_type_returns_none() {
        let line = r#"{"type":"unknown_future_type","data":"something"}"#;
        assert!(parse_stream_line(line).is_none());
    }

    #[test]
    fn parse_malformed_json_does_not_crash() {
        // Various malformed inputs that should return None, not panic
        assert!(parse_stream_line("{invalid json").is_none());
        assert!(parse_stream_line(r#"{"type": "unknown_type"}"#).is_none());
        assert!(parse_stream_line("just plain text").is_none());
        assert!(parse_stream_line(r#"{"partial":"#).is_none());
        assert!(parse_stream_line("").is_none());
        assert!(parse_stream_line("null").is_none());
        assert!(parse_stream_line("[]").is_none());
    }

    #[test]
    fn parse_tool_use_content_block() {
        let line = r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"Read","input":{"file_path":"/tmp/test.rs"}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                assert_eq!(index, 0);
                match content_block {
                    ContentBlock::ToolUse { id, name, .. } => {
                        assert_eq!(id, "toolu_123");
                        assert_eq!(name, "Read");
                    }
                    _ => panic!("Expected ToolUse content block"),
                }
            }
            _ => panic!("Expected ContentBlockStart event"),
        }
    }
}
