use std::path::{Path, PathBuf};
use tracing::debug;

/// Discovered Claude Code configuration paths.
#[derive(Debug, Clone)]
pub struct ClaudeConfig {
    /// Path to ~/.claude/ directory
    pub user_config_dir: Option<PathBuf>,
    /// Whether CLAUDE.md exists in the user config
    pub has_user_claude_md: bool,
    /// Path to project .claude/ directory (if any)
    pub project_config_dir: Option<PathBuf>,
    /// Whether CLAUDE.md exists in the project
    pub has_project_claude_md: bool,
    /// Path to the claude CLI binary
    pub cli_path: String,
}

impl ClaudeConfig {
    /// Discover Claude Code configuration from the environment.
    /// This is read-only; it never modifies any files.
    pub fn discover(workspace_path: &str) -> Self {
        let home = dirs::home_dir();
        let workspace = Path::new(workspace_path);

        // Check user-level config (~/.claude/)
        let user_config_dir = home.as_ref().map(|h| h.join(".claude"));
        let has_user_claude_md = user_config_dir
            .as_ref()
            .map(|d| d.join("CLAUDE.md").exists())
            .unwrap_or(false);

        // Check project-level config (.claude/ in workspace)
        let project_config_dir = {
            let dir = workspace.join(".claude");
            if dir.exists() {
                Some(dir)
            } else {
                None
            }
        };
        let has_project_claude_md = workspace.join("CLAUDE.md").exists()
            || workspace.join(".claude").join("CLAUDE.md").exists();

        // Resolve CLI path
        let cli_path = std::env::var("MCODE_CLAUDE_PATH").unwrap_or_else(|_| "claude".to_string());

        let config = Self {
            user_config_dir: user_config_dir.filter(|d| d.exists()),
            has_user_claude_md,
            project_config_dir,
            has_project_claude_md,
            cli_path,
        };

        debug!(?config, "Discovered Claude config");
        config
    }

    /// Check if Claude CLI is available on PATH.
    pub fn is_cli_available(&self) -> bool {
        which::which(&self.cli_path).is_ok()
    }

    /// Get the user's home directory.
    pub fn home_dir() -> Option<PathBuf> {
        dirs::home_dir()
    }

    /// Build environment variables for spawning a Claude CLI process.
    /// Ensures HOME is set so ~/.claude/ is found.
    pub fn spawn_env(&self) -> Vec<(String, String)> {
        let mut env = Vec::new();

        // Ensure HOME is set for Claude to find ~/.claude/
        if let Some(home) = dirs::home_dir() {
            env.push(("HOME".to_string(), home.to_string_lossy().to_string()));
        }

        env
    }

    /// Summary of discovered config for display.
    pub fn summary(&self) -> ConfigSummary {
        ConfigSummary {
            cli_available: self.is_cli_available(),
            cli_path: self.cli_path.clone(),
            user_config: self.user_config_dir.is_some(),
            user_claude_md: self.has_user_claude_md,
            project_config: self.project_config_dir.is_some(),
            project_claude_md: self.has_project_claude_md,
        }
    }
}

/// Summary of Claude config for UI display.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfigSummary {
    pub cli_available: bool,
    pub cli_path: String,
    pub user_config: bool,
    pub user_claude_md: bool,
    pub project_config: bool,
    pub project_claude_md: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn discover_with_no_config() {
        let dir = TempDir::new().unwrap();
        let config = ClaudeConfig::discover(dir.path().to_str().unwrap());
        assert!(!config.has_project_claude_md);
        assert!(config.project_config_dir.is_none());
    }

    #[test]
    fn discover_with_project_claude_md() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "test").unwrap();

        let config = ClaudeConfig::discover(dir.path().to_str().unwrap());
        assert!(config.has_project_claude_md);
    }

    #[test]
    fn discover_with_project_claude_dir() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::write(dir.path().join(".claude").join("CLAUDE.md"), "test").unwrap();

        let config = ClaudeConfig::discover(dir.path().to_str().unwrap());
        assert!(config.project_config_dir.is_some());
        assert!(config.has_project_claude_md);
    }

    #[test]
    fn default_cli_path_is_claude() {
        // Only test when env var is not set externally
        if std::env::var("MCODE_CLAUDE_PATH").is_err() {
            let dir = TempDir::new().unwrap();
            let config = ClaudeConfig::discover(dir.path().to_str().unwrap());
            assert_eq!(config.cli_path, "claude");
        }
    }

    #[test]
    fn cli_path_respects_env_var() {
        // Test the fallback logic directly without mutating env
        // (set_var/remove_var is unsafe in parallel tests)
        let default = std::env::var("MCODE_CLAUDE_PATH").unwrap_or_else(|_| "claude".to_string());
        let dir = TempDir::new().unwrap();
        let config = ClaudeConfig::discover(dir.path().to_str().unwrap());
        assert_eq!(config.cli_path, default);
    }

    #[test]
    fn spawn_env_includes_home() {
        let dir = TempDir::new().unwrap();
        let config = ClaudeConfig::discover(dir.path().to_str().unwrap());
        let env = config.spawn_env();
        assert!(env.iter().any(|(k, _)| k == "HOME"));
    }

    #[test]
    fn summary_works() {
        let dir = TempDir::new().unwrap();
        let config = ClaudeConfig::discover(dir.path().to_str().unwrap());
        let summary = config.summary();
        assert!(!summary.cli_path.is_empty());
    }
}
