use serde::ser::Serializer;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("request error: {0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("websocket error: {0}")]
    WebSocket(Box<tokio_tungstenite::tungstenite::Error>),
    #[error("json decode error: {0}")]
    SimdJson(#[from] simd_json::Error),
    #[error("float parse error: {0}")]
    ParseFloat(#[from] std::num::ParseFloatError),
    #[error("window not found: {0}")]
    WindowNotFound(String),
    #[error("runtime error: {0}")]
    Tauri(#[from] tauri::Error),
}

impl From<tokio_tungstenite::tungstenite::Error> for AppError {
    fn from(value: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::WebSocket(Box::new(value))
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
