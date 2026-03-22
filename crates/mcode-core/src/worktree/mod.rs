use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Manages git worktrees for thread isolation.
pub struct WorktreeManager;

impl WorktreeManager {
    /// Create a new git worktree for the given name.
    /// Creates a new branch `mcode/<name>` and checks it out in `.mcode-worktrees/<name>`.
    pub fn create(repo_path: &str, name: &str) -> Result<WorktreeInfo> {
        let repo_path = Path::new(repo_path);
        anyhow::ensure!(
            repo_path.is_dir(),
            "Repository path does not exist: {:?}",
            repo_path
        );

        let repo = git2::Repository::open(repo_path).context("Failed to open git repository")?;

        // Resolve HEAD to create branch from
        let head = repo.head().context("Failed to resolve HEAD")?;
        let head_commit = head
            .peel_to_commit()
            .context("Failed to resolve HEAD to commit")?;

        let branch_name = format!("mcode/{}", name);
        let worktree_dir = repo_path.join(".mcode-worktrees").join(name);

        // Don't create if worktree directory already exists
        anyhow::ensure!(
            !worktree_dir.exists(),
            "Worktree directory already exists: {:?}",
            worktree_dir
        );

        // Ensure parent directory exists
        if let Some(parent) = worktree_dir.parent() {
            std::fs::create_dir_all(parent).context("Failed to create worktrees directory")?;
        }

        // Create the branch and convert to reference for worktree options
        let branch = repo.branch(&branch_name, &head_commit, false)?;
        let branch_ref = branch.into_reference();

        // Create the worktree
        let worktree = repo
            .worktree(
                name,
                &worktree_dir,
                Some(git2::WorktreeAddOptions::new().reference(Some(&branch_ref))),
            )
            .context("Failed to create worktree")?;

        let worktree_path = worktree.path().to_str().unwrap_or_default().to_string();

        info!(
            name = %name,
            branch = %branch_name,
            path = %worktree_path,
            "Created git worktree"
        );

        Ok(WorktreeInfo {
            name: name.to_string(),
            path: worktree_dir.to_string_lossy().to_string(),
            branch: branch_name,
        })
    }

    /// Remove a git worktree by name.
    pub fn remove(repo_path: &str, name: &str) -> Result<bool> {
        let repo_path = Path::new(repo_path);
        let repo = git2::Repository::open(repo_path).context("Failed to open git repository")?;

        let worktree_dir = repo_path.join(".mcode-worktrees").join(name);

        // Remove the worktree directory if it exists
        if worktree_dir.exists() {
            std::fs::remove_dir_all(&worktree_dir)
                .context("Failed to remove worktree directory")?;
        }

        // Prune the worktree from git's tracking
        if let Ok(wt) = repo.find_worktree(name) {
            let mut prune_opts = git2::WorktreePruneOptions::new();
            prune_opts.valid(true);
            prune_opts.working_tree(true);
            wt.prune(Some(&mut prune_opts))
                .context("Failed to prune worktree")?;
        }

        // Try to delete the branch
        let branch_name = format!("mcode/{}", name);
        if let Ok(mut branch) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            if let Err(e) = branch.delete() {
                warn!(branch = %branch_name, error = %e, "Failed to delete worktree branch");
            }
        }

        info!(name = %name, "Removed git worktree");
        Ok(true)
    }

    /// List all mcode worktrees in a repository.
    pub fn list(repo_path: &str) -> Result<Vec<WorktreeInfo>> {
        let repo_path = Path::new(repo_path);
        let worktrees_dir = repo_path.join(".mcode-worktrees");

        if !worktrees_dir.exists() {
            return Ok(Vec::new());
        }

        let mut result = Vec::new();
        for entry in std::fs::read_dir(&worktrees_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                result.push(WorktreeInfo {
                    path: entry.path().to_string_lossy().to_string(),
                    branch: format!("mcode/{}", name),
                    name,
                });
            }
        }

        Ok(result)
    }

    /// Get the worktree path for a given name.
    pub fn worktree_path(repo_path: &str, name: &str) -> PathBuf {
        Path::new(repo_path).join(".mcode-worktrees").join(name)
    }
}

/// Information about a git worktree.
#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub branch: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn init_test_repo() -> (TempDir, String) {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();

        // Create an initial commit so HEAD exists
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
            .unwrap();

        let path = dir.path().to_string_lossy().to_string();
        (dir, path)
    }

    #[test]
    fn create_and_remove_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let info = WorktreeManager::create(&repo_path, "test-feature").unwrap();
        assert_eq!(info.name, "test-feature");
        assert_eq!(info.branch, "mcode/test-feature");
        assert!(Path::new(&info.path).exists());

        let removed = WorktreeManager::remove(&repo_path, "test-feature").unwrap();
        assert!(removed);
        assert!(!Path::new(&info.path).exists());
    }

    #[test]
    fn list_worktrees() {
        let (_dir, repo_path) = init_test_repo();

        WorktreeManager::create(&repo_path, "feat-a").unwrap();
        WorktreeManager::create(&repo_path, "feat-b").unwrap();

        let worktrees = WorktreeManager::list(&repo_path).unwrap();
        assert_eq!(worktrees.len(), 2);

        // Cleanup
        WorktreeManager::remove(&repo_path, "feat-a").unwrap();
        WorktreeManager::remove(&repo_path, "feat-b").unwrap();
    }

    #[test]
    fn create_duplicate_fails() {
        let (_dir, repo_path) = init_test_repo();

        WorktreeManager::create(&repo_path, "dupe").unwrap();
        let result = WorktreeManager::create(&repo_path, "dupe");
        assert!(result.is_err());

        WorktreeManager::remove(&repo_path, "dupe").unwrap();
    }

    #[test]
    fn remove_nonexistent_is_ok() {
        let (_dir, repo_path) = init_test_repo();
        let result = WorktreeManager::remove(&repo_path, "nonexistent");
        assert!(result.is_ok());
    }

    #[test]
    fn worktree_path_is_correct() {
        let path = WorktreeManager::worktree_path("/tmp/repo", "my-feature");
        assert!(path.ends_with(".mcode-worktrees/my-feature"));
    }
}
