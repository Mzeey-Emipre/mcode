pub mod models;
pub mod writer;

use anyhow::Result;
use refinery::embed_migrations;
use rusqlite::Connection;
use tracing::info;

embed_migrations!("src/store/migrations");

pub fn run_migrations(db_path: &str) -> Result<()> {
    let mut conn = Connection::open(db_path)?;
    info!("Running database migrations on {}", db_path);
    migrations::runner().run(&mut conn)?;
    info!("Migrations complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_run_on_memory_db() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::runner().run(&mut conn).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"workspaces".to_string()));
        assert!(tables.contains(&"threads".to_string()));
        assert!(tables.contains(&"messages".to_string()));
    }

    #[test]
    fn migrations_are_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::runner().run(&mut conn).unwrap();
        // Running again should not error
        migrations::runner().run(&mut conn).unwrap();
    }
}
