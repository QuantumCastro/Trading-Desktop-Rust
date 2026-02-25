pub mod binance;
pub mod persistence;
pub mod pipeline;
pub mod types;

pub const PRICE_UPDATE_EVENT: &str = "price_update";
pub const MARKET_STATUS_EVENT: &str = "market_status";
pub const MARKET_FRAME_UPDATE_EVENT: &str = "market_frame_update";
pub const MARKET_PERF_EVENT: &str = "market_perf";
pub const CANDLE_UPDATE_EVENT: &str = "candle_update";
pub const CANDLES_BOOTSTRAP_EVENT: &str = "candles_bootstrap";
pub const DELTA_CANDLE_UPDATE_EVENT: &str = "delta_candle_update";
pub const DELTA_CANDLES_BOOTSTRAP_EVENT: &str = "delta_candles_bootstrap";
pub const HISTORY_LOAD_PROGRESS_EVENT: &str = "history_load_progress";
