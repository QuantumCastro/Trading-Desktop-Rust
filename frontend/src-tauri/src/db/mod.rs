use crate::error::AppError;
use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const DEFAULT_DB_FILENAME: &str = "app.db";

fn resolve_db_filename() -> String {
    std::env::var("APP_DB_FILENAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DB_FILENAME.to_string())
}

fn resolve_db_path(app_handle: &AppHandle) -> Result<PathBuf, AppError> {
    let mut base_dir = app_handle.path().app_data_dir()?;
    std::fs::create_dir_all(&base_dir)?;
    base_dir.push(resolve_db_filename());
    Ok(base_dir)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

pub async fn initialize_pool_from_path(path: &Path) -> Result<SqlitePool, AppError> {
    let connect_options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePool::connect_with(connect_options).await?;
    run_migrations(&pool).await?;

    Ok(pool)
}

pub async fn initialize_pool(app_handle: &AppHandle) -> Result<SqlitePool, AppError> {
    let db_path = resolve_db_path(app_handle)?;
    initialize_pool_from_path(&db_path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_db_path() -> PathBuf {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();

        std::env::temp_dir().join(format!("desktop-template-{timestamp}.db"))
    }

    #[tokio::test]
    async fn migrations_are_idempotent() {
        let db_path = unique_db_path();

        let pool = initialize_pool_from_path(&db_path)
            .await
            .expect("pool initialization should succeed");

        run_migrations(&pool)
            .await
            .expect("running migrations multiple times should succeed");

        let metadata_rows = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_metadata")
            .fetch_one(&pool)
            .await
            .expect("app_metadata table must exist and be queryable");

        assert_eq!(metadata_rows, 1);

        drop(pool);
        let _ = std::fs::remove_file(db_path);
    }
}
