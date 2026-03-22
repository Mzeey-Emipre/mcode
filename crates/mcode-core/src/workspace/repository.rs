use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::store::models::{Message, MessageRole, Thread, ThreadMode, ThreadStatus, Workspace};

/// Repository for workspace CRUD operations.
pub struct WorkspaceRepo;

impl WorkspaceRepo {
    pub fn create(conn: &Connection, name: &str, path: &str) -> Result<Workspace> {
        let id = Uuid::new_v4();
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        conn.execute(
            "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id.to_string(), name, path, now_str, now_str],
        )?;

        Ok(Workspace {
            id,
            name: name.to_string(),
            path: path.to_string(),
            provider_config: serde_json::json!({}),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn find_by_id(conn: &Connection, id: &Uuid) -> Result<Option<Workspace>> {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces WHERE id = ?1",
        )?;

        let result = stmt.query_row(params![id.to_string()], |row| {
            Ok(Workspace {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                name: row.get(1)?,
                path: row.get(2)?,
                provider_config: serde_json::from_str(&row.get::<_, String>(3)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                created_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                updated_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
            })
        });

        match result {
            Ok(ws) => Ok(Some(ws)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn find_by_path(conn: &Connection, path: &str) -> Result<Option<Workspace>> {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces WHERE path = ?1",
        )?;

        let result = stmt.query_row(params![path], |row| {
            Ok(Workspace {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                name: row.get(1)?,
                path: row.get(2)?,
                provider_config: serde_json::from_str(&row.get::<_, String>(3)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                created_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                updated_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
            })
        });

        match result {
            Ok(ws) => Ok(Some(ws)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn list_all(conn: &Connection) -> Result<Vec<Workspace>> {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces ORDER BY updated_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Workspace {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                name: row.get(1)?,
                path: row.get(2)?,
                provider_config: serde_json::from_str(&row.get::<_, String>(3)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                created_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                updated_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
            })
        })?;

        let mut workspaces = Vec::new();
        for row in rows {
            workspaces.push(row?);
        }
        Ok(workspaces)
    }

    pub fn delete(conn: &Connection, id: &Uuid) -> Result<bool> {
        let affected = conn.execute(
            "DELETE FROM workspaces WHERE id = ?1",
            params![id.to_string()],
        )?;
        Ok(affected > 0)
    }
}

/// Repository for thread CRUD operations.
pub struct ThreadRepo;

impl ThreadRepo {
    pub fn create(
        conn: &Connection,
        workspace_id: &Uuid,
        title: &str,
        mode: ThreadMode,
        branch: &str,
    ) -> Result<Thread> {
        let id = Uuid::new_v4();
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let session_name = format!("mcode-{}", id);

        conn.execute(
            "INSERT INTO threads (id, workspace_id, title, status, mode, branch, session_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id.to_string(),
                workspace_id.to_string(),
                title,
                ThreadStatus::Active.to_string(),
                mode.to_string(),
                branch,
                session_name,
                now_str,
                now_str,
            ],
        )?;

        Ok(Thread {
            id,
            workspace_id: *workspace_id,
            title: title.to_string(),
            status: ThreadStatus::Active,
            mode,
            worktree_path: None,
            branch: branch.to_string(),
            issue_number: None,
            pr_number: None,
            pr_status: None,
            session_name,
            pid: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        })
    }

    pub fn list_by_workspace(
        conn: &Connection,
        workspace_id: &Uuid,
        limit: i64,
    ) -> Result<Vec<Thread>> {
        anyhow::ensure!(
            (1..=1000).contains(&limit),
            "limit must be between 1 and 1000"
        );
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, title, status, mode, worktree_path, branch, issue_number, pr_number, pr_status, session_name, pid, created_at, updated_at, deleted_at FROM threads WHERE workspace_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![workspace_id.to_string(), limit], |row| {
            Ok(Thread {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                workspace_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                title: row.get(2)?,
                status: row.get::<_, String>(3)?.parse().map_err(|e: String| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                })?,
                mode: row.get::<_, String>(4)?.parse().map_err(|e: String| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                })?,
                worktree_path: row.get(5)?,
                branch: row.get(6)?,
                issue_number: row.get(7)?,
                pr_number: row.get(8)?,
                pr_status: row.get(9)?,
                session_name: row.get(10)?,
                pid: row.get(11)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(12)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            12,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                updated_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(13)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            13,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                deleted_at: None,
            })
        })?;

        let mut threads = Vec::new();
        for row in rows {
            threads.push(row?);
        }
        Ok(threads)
    }

    pub fn update_status(conn: &Connection, id: &Uuid, status: &ThreadStatus) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let affected = conn.execute(
            "UPDATE threads SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status.to_string(), now, id.to_string()],
        )?;
        Ok(affected > 0)
    }

    pub fn update_worktree_path(conn: &Connection, id: &Uuid, worktree_path: &str) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let affected = conn.execute(
            "UPDATE threads SET worktree_path = ?1, updated_at = ?2 WHERE id = ?3",
            params![worktree_path, now, id.to_string()],
        )?;
        Ok(affected > 0)
    }

    pub fn find_by_id(conn: &Connection, id: &Uuid) -> Result<Option<Thread>> {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, title, status, mode, worktree_path, branch, issue_number, pr_number, pr_status, session_name, pid, created_at, updated_at, deleted_at FROM threads WHERE id = ?1",
        )?;

        let result = stmt.query_row(params![id.to_string()], |row| {
            Ok(Thread {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                workspace_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                title: row.get(2)?,
                status: row.get::<_, String>(3)?.parse().map_err(|e: String| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                })?,
                mode: row.get::<_, String>(4)?.parse().map_err(|e: String| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                })?,
                worktree_path: row.get(5)?,
                branch: row.get(6)?,
                issue_number: row.get(7)?,
                pr_number: row.get(8)?,
                pr_status: row.get(9)?,
                session_name: row.get(10)?,
                pid: row.get(11)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(12)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            12,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                updated_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(13)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            13,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                deleted_at: None,
            })
        });

        match result {
            Ok(thread) => Ok(Some(thread)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn hard_delete(conn: &Connection, id: &Uuid) -> Result<bool> {
        let affected =
            conn.execute("DELETE FROM threads WHERE id = ?1", params![id.to_string()])?;
        Ok(affected > 0)
    }

    pub fn soft_delete(conn: &Connection, id: &Uuid) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let affected = conn.execute(
            "UPDATE threads SET deleted_at = ?1, status = ?2, updated_at = ?1 WHERE id = ?3",
            params![now, ThreadStatus::Deleted.to_string(), id.to_string()],
        )?;
        Ok(affected > 0)
    }
}

/// Repository for message operations.
pub struct MessageRepo;

impl MessageRepo {
    pub fn create(
        conn: &Connection,
        thread_id: &Uuid,
        role: MessageRole,
        content: &str,
        sequence: i64,
    ) -> Result<Message> {
        let id = Uuid::new_v4();
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        conn.execute(
            "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id.to_string(),
                thread_id.to_string(),
                role.to_string(),
                content,
                now_str,
                sequence,
            ],
        )?;

        Ok(Message {
            id,
            thread_id: *thread_id,
            role,
            content: content.to_string(),
            tool_calls: None,
            files_changed: None,
            cost_usd: None,
            tokens_used: None,
            timestamp: now,
            sequence,
        })
    }

    pub fn list_by_thread(conn: &Connection, thread_id: &Uuid, limit: i64) -> Result<Vec<Message>> {
        anyhow::ensure!(
            (1..=1000).contains(&limit),
            "limit must be between 1 and 1000"
        );
        let mut stmt = conn.prepare(
            "SELECT id, thread_id, role, content, tool_calls, files_changed, cost_usd, tokens_used, timestamp, sequence FROM (SELECT id, thread_id, role, content, tool_calls, files_changed, cost_usd, tokens_used, timestamp, sequence FROM messages WHERE thread_id = ?1 ORDER BY sequence DESC LIMIT ?2) ORDER BY sequence ASC",
        )?;

        let rows = stmt.query_map(params![thread_id.to_string(), limit], |row| {
            Ok(Message {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                thread_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                role: row.get::<_, String>(2)?.parse().map_err(|e: String| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                })?,
                content: row.get(3)?,
                tool_calls: row
                    .get::<_, Option<String>>(4)?
                    .map(|s| serde_json::from_str(&s))
                    .transpose()
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                files_changed: row
                    .get::<_, Option<String>>(5)?
                    .map(|s| serde_json::from_str(&s))
                    .transpose()
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                cost_usd: row.get(6)?,
                tokens_used: row.get(7)?,
                timestamp: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(8)?)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            8,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                sequence: row.get(9)?,
            })
        })?;

        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?);
        }
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        store::run_migrations_on_conn(&mut conn).unwrap();
        conn
    }

    #[test]
    fn create_and_find_workspace() {
        let conn = setup_db();
        let ws = WorkspaceRepo::create(&conn, "test-repo", "/tmp/test-repo").unwrap();
        assert_eq!(ws.name, "test-repo");
        assert_eq!(ws.path, "/tmp/test-repo");

        let found = WorkspaceRepo::find_by_id(&conn, &ws.id).unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "test-repo");
    }

    #[test]
    fn find_workspace_by_path() {
        let conn = setup_db();
        WorkspaceRepo::create(&conn, "test-repo", "/tmp/test-repo").unwrap();

        let found = WorkspaceRepo::find_by_path(&conn, "/tmp/test-repo").unwrap();
        assert!(found.is_some());

        let not_found = WorkspaceRepo::find_by_path(&conn, "/tmp/nonexistent").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn list_workspaces() {
        let conn = setup_db();
        WorkspaceRepo::create(&conn, "repo-a", "/tmp/a").unwrap();
        WorkspaceRepo::create(&conn, "repo-b", "/tmp/b").unwrap();

        let all = WorkspaceRepo::list_all(&conn).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn delete_workspace() {
        let conn = setup_db();
        let ws = WorkspaceRepo::create(&conn, "to-delete", "/tmp/delete").unwrap();

        assert!(WorkspaceRepo::delete(&conn, &ws.id).unwrap());
        assert!(WorkspaceRepo::find_by_id(&conn, &ws.id).unwrap().is_none());
    }

    #[test]
    fn create_and_list_threads() {
        let conn = setup_db();
        let ws = WorkspaceRepo::create(&conn, "test-repo", "/tmp/test").unwrap();

        let t1 =
            ThreadRepo::create(&conn, &ws.id, "Feature A", ThreadMode::Direct, "main").unwrap();
        let _t2 =
            ThreadRepo::create(&conn, &ws.id, "Feature B", ThreadMode::Worktree, "feat/b").unwrap();

        assert_eq!(t1.status, ThreadStatus::Active);
        assert!(t1.session_name.starts_with("mcode-"));

        let threads = ThreadRepo::list_by_workspace(&conn, &ws.id, 100).unwrap();
        assert_eq!(threads.len(), 2);
    }

    #[test]
    fn update_thread_status() {
        let conn = setup_db();
        let ws = WorkspaceRepo::create(&conn, "test-repo", "/tmp/test").unwrap();
        let thread = ThreadRepo::create(&conn, &ws.id, "Test", ThreadMode::Direct, "main").unwrap();

        assert!(ThreadRepo::update_status(&conn, &thread.id, &ThreadStatus::Completed).unwrap());
    }

    #[test]
    fn soft_delete_thread() {
        let conn = setup_db();
        let ws = WorkspaceRepo::create(&conn, "test-repo", "/tmp/test").unwrap();
        let thread = ThreadRepo::create(&conn, &ws.id, "Test", ThreadMode::Direct, "main").unwrap();

        assert!(ThreadRepo::soft_delete(&conn, &thread.id).unwrap());

        // Soft-deleted threads should not appear in list
        let threads = ThreadRepo::list_by_workspace(&conn, &ws.id, 100).unwrap();
        assert!(threads.is_empty());
    }

    #[test]
    fn create_and_list_messages() {
        let conn = setup_db();
        let ws = WorkspaceRepo::create(&conn, "test-repo", "/tmp/test").unwrap();
        let thread = ThreadRepo::create(&conn, &ws.id, "Test", ThreadMode::Direct, "main").unwrap();

        MessageRepo::create(&conn, &thread.id, MessageRole::User, "Hello", 1).unwrap();
        MessageRepo::create(&conn, &thread.id, MessageRole::Assistant, "Hi there!", 2).unwrap();

        let messages = MessageRepo::list_by_thread(&conn, &thread.id, 100).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "Hello");
        assert_eq!(messages[1].content, "Hi there!");
    }

    #[test]
    fn messages_respect_limit() {
        let conn = setup_db();
        let ws = WorkspaceRepo::create(&conn, "test-repo", "/tmp/test").unwrap();
        let thread = ThreadRepo::create(&conn, &ws.id, "Test", ThreadMode::Direct, "main").unwrap();

        for i in 1..=10 {
            MessageRepo::create(
                &conn,
                &thread.id,
                MessageRole::User,
                &format!("msg {}", i),
                i,
            )
            .unwrap();
        }

        let messages = MessageRepo::list_by_thread(&conn, &thread.id, 5).unwrap();
        assert_eq!(messages.len(), 5);
    }
}
