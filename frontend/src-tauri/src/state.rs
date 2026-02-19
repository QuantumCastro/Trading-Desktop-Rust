use crate::market::types::{MarketStreamStatusSnapshot, DEFAULT_SYMBOL};
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

pub struct MarketStreamHandle {
    pub cancellation_token: CancellationToken,
    pub join_handle: tauri::async_runtime::JoinHandle<()>,
}

pub struct AppState {
    pub started_at: Instant,
    pub db_pool: SqlitePool,
    pub market_stream: Mutex<Option<MarketStreamHandle>>,
    pub market_status: Arc<RwLock<MarketStreamStatusSnapshot>>,
}

impl AppState {
    pub fn new(db_pool: SqlitePool) -> Self {
        let market_status = MarketStreamStatusSnapshot::stopped(
            DEFAULT_SYMBOL.to_string(),
            Some("stream idle".to_string()),
        );

        Self {
            started_at: Instant::now(),
            db_pool,
            market_stream: Mutex::new(None),
            market_status: Arc::new(RwLock::new(market_status)),
        }
    }
}
