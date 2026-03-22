use anyhow::Result;
use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info};

pub enum DbCommand {
    Execute {
        sql: String,
        params: Vec<String>,
        reply: oneshot::Sender<Result<usize>>,
    },
    Query {
        sql: String,
        params: Vec<String>,
        reply: oneshot::Sender<Result<Vec<Vec<String>>>>,
    },
    Shutdown,
}

pub struct DbWriter {
    sender: mpsc::Sender<DbCommand>,
}

impl DbWriter {
    pub fn new(db_path: &str) -> Result<Self> {
        let db_path = db_path.to_string();
        let (tx, mut rx) = mpsc::channel::<DbCommand>(256);

        std::thread::spawn(move || {
            let conn = match Connection::open(&db_path) {
                Ok(c) => c,
                Err(e) => {
                    error!("Failed to open database: {}", e);
                    return;
                }
            };

            if let Err(e) = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;") {
                error!("Failed to set pragmas: {}", e);
                return;
            }

            info!("Database writer started: {}", db_path);

            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    DbCommand::Shutdown => break,
                    DbCommand::Execute { sql, params, reply } => {
                        let result = conn
                            .execute(&sql, rusqlite::params_from_iter(params.iter()))
                            .map_err(|e| anyhow::anyhow!(e));
                        let _ = reply.send(result);
                    }
                    DbCommand::Query { sql, params, reply } => {
                        let result = (|| -> Result<Vec<Vec<String>>> {
                            let mut stmt = conn.prepare(&sql)?;
                            let col_count = stmt.column_count();
                            let rows =
                                stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                                    let mut cols = Vec::with_capacity(col_count);
                                    for i in 0..col_count {
                                        cols.push(row.get::<_, String>(i).unwrap_or_default());
                                    }
                                    Ok(cols)
                                })?;
                            let mut results = Vec::new();
                            for row in rows {
                                results.push(row?);
                            }
                            Ok(results)
                        })();
                        let _ = reply.send(result);
                    }
                }
            }

            info!("Database writer shut down");
        });

        Ok(Self { sender: tx })
    }

    pub fn sender(&self) -> mpsc::Sender<DbCommand> {
        self.sender.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn writer_starts_and_shuts_down() {
        let tmp = NamedTempFile::new().unwrap();
        let writer = DbWriter::new(tmp.path().to_str().unwrap()).unwrap();
        let sender = writer.sender();
        sender.send(DbCommand::Shutdown).await.unwrap();
    }

    #[tokio::test]
    async fn writer_executes_sql() {
        let tmp = NamedTempFile::new().unwrap();
        let db_path = tmp.path().to_str().unwrap();

        // Run migrations first
        super::super::run_migrations(db_path).unwrap();

        let writer = DbWriter::new(db_path).unwrap();
        let sender = writer.sender();

        let (reply_tx, reply_rx) = oneshot::channel();
        sender
            .send(DbCommand::Execute {
                sql: "INSERT INTO workspaces (id, name, path) VALUES (?1, ?2, ?3)".to_string(),
                params: vec![
                    "test-id".to_string(),
                    "test-name".to_string(),
                    "/tmp/test".to_string(),
                ],
                reply: reply_tx,
            })
            .await
            .unwrap();

        let result = reply_rx.await.unwrap().unwrap();
        assert_eq!(result, 1); // 1 row inserted

        sender.send(DbCommand::Shutdown).await.unwrap();
    }
}
