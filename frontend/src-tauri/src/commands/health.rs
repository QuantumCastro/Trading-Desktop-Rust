use crate::{error::AppError, state::AppState};
use serde::Serialize;
use sqlx::SqlitePool;
use std::time::Instant;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: &'static str,
    pub uptime_ms: u128,
    pub db: &'static str,
}

pub async fn build_health_response(started_at: Instant, pool: &SqlitePool) -> HealthResponse {
    let db_status = match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(pool)
        .await
    {
        Ok(_) => "ok",
        Err(_) => "error",
    };

    HealthResponse {
        status: "ok",
        uptime_ms: started_at.elapsed().as_millis(),
        db: db_status,
    }
}

#[tauri::command]
pub async fn health(state: State<'_, AppState>) -> Result<HealthResponse, AppError> {
    Ok(build_health_response(state.started_at, &state.db_pool).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_reports_ok_status_and_db_health() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite should initialize");

        let response = build_health_response(Instant::now(), &pool).await;

        assert_eq!(response.status, "ok");
        assert_eq!(response.db, "ok");
        assert!(response.uptime_ms <= 1_000);
    }
}
