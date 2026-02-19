use crate::error::AppError;
use serde::{Deserialize, Serialize};

pub const DEFAULT_SYMBOL: &str = "BTCUSDT";
pub const DEFAULT_MIN_NOTIONAL_USDT: f64 = 100.0;
pub const DEFAULT_EMIT_INTERVAL_MS: u64 = 16;
pub const DEFAULT_MOCK_MODE: bool = false;
pub const DEFAULT_EMIT_LEGACY_PRICE_EVENT: bool = false;
pub const DEFAULT_EMIT_LEGACY_FRAME_EVENTS: bool = false;
pub const DEFAULT_PERF_TELEMETRY: bool = false;
pub const DEFAULT_CLOCK_SYNC_INTERVAL_MS: u64 = 30_000;
pub const DEFAULT_TIMEFRAME: MarketTimeframe = MarketTimeframe::M1;
pub const DEFAULT_STARTUP_MODE: MarketStartupMode = MarketStartupMode::LiveFirst;
pub const DEFAULT_HISTORY_LIMIT: u16 = 5_000;
pub const MIN_EMIT_INTERVAL_MS: u64 = 8;
pub const MAX_EMIT_INTERVAL_MS: u64 = 1_000;
pub const MIN_CLOCK_SYNC_INTERVAL_MS: u64 = 5_000;
pub const MAX_CLOCK_SYNC_INTERVAL_MS: u64 = 300_000;
pub const MIN_HISTORY_LIMIT: u16 = 50;
pub const MAX_HISTORY_LIMIT: u16 = 10_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MarketConnectionState {
    Connecting,
    Live,
    Desynced,
    Reconnecting,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MarketTimeframe {
    #[serde(rename = "1m")]
    M1,
    #[serde(rename = "5m")]
    M5,
    #[serde(rename = "1h")]
    H1,
    #[serde(rename = "4h")]
    H4,
    #[serde(rename = "1d")]
    D1,
    #[serde(rename = "1w")]
    W1,
    #[serde(rename = "1M")]
    Mo1,
}

impl MarketTimeframe {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::M1 => "1m",
            Self::M5 => "5m",
            Self::H1 => "1h",
            Self::H4 => "4h",
            Self::D1 => "1d",
            Self::W1 => "1w",
            Self::Mo1 => "1M",
        }
    }

    pub fn duration_ms(self) -> i64 {
        match self {
            Self::M1 => 60_000,
            Self::M5 => 300_000,
            Self::H1 => 3_600_000,
            Self::H4 => 14_400_000,
            Self::D1 => 86_400_000,
            Self::W1 => 604_800_000,
            Self::Mo1 => 2_592_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarketStartupMode {
    LiveFirst,
    HistoryFirst,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketStreamStatusSnapshot {
    pub state: MarketConnectionState,
    pub symbol: String,
    pub timeframe: MarketTimeframe,
    pub last_agg_id: Option<u64>,
    pub latency_ms: Option<i64>,
    pub raw_exchange_latency_ms: Option<i64>,
    pub clock_offset_ms: Option<i64>,
    pub adjusted_network_latency_ms: Option<i64>,
    pub local_pipeline_latency_ms: Option<i64>,
    pub reason: Option<String>,
}

impl MarketStreamStatusSnapshot {
    pub fn stopped(symbol: String, reason: Option<String>) -> Self {
        Self {
            state: MarketConnectionState::Stopped,
            symbol,
            timeframe: DEFAULT_TIMEFRAME,
            last_agg_id: None,
            latency_ms: None,
            raw_exchange_latency_ms: None,
            clock_offset_ms: None,
            adjusted_network_latency_ms: None,
            local_pipeline_latency_ms: None,
            reason,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartMarketStreamArgs {
    pub symbol: Option<String>,
    pub min_notional_usdt: Option<f64>,
    pub emit_interval_ms: Option<u64>,
    pub mock_mode: Option<bool>,
    pub emit_legacy_price_event: Option<bool>,
    pub emit_legacy_frame_events: Option<bool>,
    pub perf_telemetry: Option<bool>,
    pub clock_sync_interval_ms: Option<u64>,
    pub timeframe: Option<MarketTimeframe>,
    pub startup_mode: Option<MarketStartupMode>,
    pub history_limit: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct MarketStreamConfig {
    pub symbol: String,
    pub min_notional_usdt: f64,
    pub emit_interval_ms: u64,
    pub mock_mode: bool,
    pub emit_legacy_price_event: bool,
    pub emit_legacy_frame_events: bool,
    pub perf_telemetry: bool,
    pub clock_sync_interval_ms: u64,
    pub timeframe: MarketTimeframe,
    pub startup_mode: MarketStartupMode,
    pub history_limit: u16,
}

impl StartMarketStreamArgs {
    pub fn normalize(self) -> Result<MarketStreamConfig, AppError> {
        let symbol = self
            .symbol
            .unwrap_or_else(|| DEFAULT_SYMBOL.to_string())
            .trim()
            .to_ascii_uppercase();

        if symbol.is_empty() || !symbol.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Err(AppError::InvalidArgument(
                "symbol must be non-empty alphanumeric ASCII".to_string(),
            ));
        }

        let min_notional_usdt = self.min_notional_usdt.unwrap_or(DEFAULT_MIN_NOTIONAL_USDT);
        if !min_notional_usdt.is_finite() || min_notional_usdt < 0.0 {
            return Err(AppError::InvalidArgument(
                "minNotionalUsdt must be a finite non-negative number".to_string(),
            ));
        }

        let emit_interval_ms = self.emit_interval_ms.unwrap_or(DEFAULT_EMIT_INTERVAL_MS);
        if !(MIN_EMIT_INTERVAL_MS..=MAX_EMIT_INTERVAL_MS).contains(&emit_interval_ms) {
            return Err(AppError::InvalidArgument(format!(
                "emitIntervalMs must be between {MIN_EMIT_INTERVAL_MS} and {MAX_EMIT_INTERVAL_MS}"
            )));
        }

        let mock_mode = self.mock_mode.unwrap_or(DEFAULT_MOCK_MODE);
        let emit_legacy_price_event = self
            .emit_legacy_price_event
            .unwrap_or(DEFAULT_EMIT_LEGACY_PRICE_EVENT);
        let emit_legacy_frame_events = self
            .emit_legacy_frame_events
            .unwrap_or(DEFAULT_EMIT_LEGACY_FRAME_EVENTS);
        let perf_telemetry = self.perf_telemetry.unwrap_or(DEFAULT_PERF_TELEMETRY);
        let clock_sync_interval_ms = self
            .clock_sync_interval_ms
            .unwrap_or(DEFAULT_CLOCK_SYNC_INTERVAL_MS);
        if !(MIN_CLOCK_SYNC_INTERVAL_MS..=MAX_CLOCK_SYNC_INTERVAL_MS)
            .contains(&clock_sync_interval_ms)
        {
            return Err(AppError::InvalidArgument(format!(
                "clockSyncIntervalMs must be between {MIN_CLOCK_SYNC_INTERVAL_MS} and {MAX_CLOCK_SYNC_INTERVAL_MS}"
            )));
        }
        let timeframe = self.timeframe.unwrap_or(DEFAULT_TIMEFRAME);
        let startup_mode = self.startup_mode.unwrap_or(DEFAULT_STARTUP_MODE);
        let history_limit = self.history_limit.unwrap_or(DEFAULT_HISTORY_LIMIT);
        if !(MIN_HISTORY_LIMIT..=MAX_HISTORY_LIMIT).contains(&history_limit) {
            return Err(AppError::InvalidArgument(format!(
                "historyLimit must be between {MIN_HISTORY_LIMIT} and {MAX_HISTORY_LIMIT}"
            )));
        }

        Ok(MarketStreamConfig {
            symbol,
            min_notional_usdt,
            emit_interval_ms,
            mock_mode,
            emit_legacy_price_event,
            emit_legacy_frame_events,
            perf_telemetry,
            clock_sync_interval_ms,
            timeframe,
            startup_mode,
            history_limit,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketStreamSession {
    pub running: bool,
    pub symbol: String,
    pub min_notional_usdt: f64,
    pub emit_interval_ms: u64,
    pub mock_mode: bool,
    pub emit_legacy_price_event: bool,
    pub emit_legacy_frame_events: bool,
    pub perf_telemetry: bool,
    pub clock_sync_interval_ms: u64,
    pub timeframe: MarketTimeframe,
    pub startup_mode: MarketStartupMode,
    pub history_limit: u16,
}

impl MarketStreamSession {
    pub fn from_config(config: &MarketStreamConfig) -> Self {
        Self {
            running: true,
            symbol: config.symbol.clone(),
            min_notional_usdt: config.min_notional_usdt,
            emit_interval_ms: config.emit_interval_ms,
            mock_mode: config.mock_mode,
            emit_legacy_price_event: config.emit_legacy_price_event,
            emit_legacy_frame_events: config.emit_legacy_frame_events,
            perf_telemetry: config.perf_telemetry,
            clock_sync_interval_ms: config.clock_sync_interval_ms,
            timeframe: config.timeframe,
            startup_mode: config.startup_mode,
            history_limit: config.history_limit,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketStreamStopResult {
    pub stopped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiTick {
    pub t: i64,
    pub p: f64,
    pub v: f64,
    pub d: i8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiMarketFrameUpdate {
    pub tick: Option<UiTick>,
    pub candle: Option<UiCandle>,
    pub delta_candle: Option<UiDeltaCandle>,
    pub local_pipeline_latency_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiCandle {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

impl UiCandle {
    pub fn from_trade(bucket_open_time: i64, price: f64, quantity: f64) -> Self {
        Self {
            t: bucket_open_time,
            o: price,
            h: price,
            l: price,
            c: price,
            v: quantity,
        }
    }

    pub fn apply_trade(&mut self, price: f64, quantity: f64) {
        self.h = self.h.max(price);
        self.l = self.l.min(price);
        self.c = price;
        self.v += quantity;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiDeltaCandle {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

impl UiDeltaCandle {
    pub fn from_signed_volume(
        bucket_open_time: i64,
        signed_volume: f64,
        absolute_volume: f64,
    ) -> Self {
        let open = 0.0;
        let close = signed_volume;
        Self {
            t: bucket_open_time,
            o: open,
            h: open.max(close),
            l: open.min(close),
            c: close,
            v: absolute_volume.max(0.0),
        }
    }

    pub fn apply_signed_volume(&mut self, signed_volume: f64, absolute_volume: f64) {
        self.c += signed_volume;
        self.h = self.h.max(self.c);
        self.l = self.l.min(self.c);
        self.v += absolute_volume.max(0.0);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCandlesBootstrap {
    pub symbol: String,
    pub timeframe: MarketTimeframe,
    pub candles: Vec<UiCandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiDeltaCandlesBootstrap {
    pub symbol: String,
    pub timeframe: MarketTimeframe,
    pub candles: Vec<UiDeltaCandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketPerfSnapshot {
    pub t: i64,
    pub parse_p50_us: Option<u32>,
    pub parse_p95_us: Option<u32>,
    pub parse_p99_us: Option<u32>,
    pub apply_p50_us: Option<u32>,
    pub apply_p95_us: Option<u32>,
    pub apply_p99_us: Option<u32>,
    pub local_pipeline_p50_ms: Option<u32>,
    pub local_pipeline_p95_ms: Option<u32>,
    pub local_pipeline_p99_ms: Option<u32>,
    pub ingest_count: u64,
    pub emit_count: u64,
}

#[derive(Debug, Deserialize)]
pub struct AggTradeWire {
    #[serde(rename = "e")]
    pub event_type: String,
    #[serde(rename = "E")]
    pub event_time: i64,
    #[serde(rename = "a")]
    pub aggregate_trade_id: u64,
    #[serde(rename = "p")]
    pub price: String,
    #[serde(rename = "q")]
    pub quantity: String,
    #[serde(rename = "T")]
    pub trade_time: i64,
    #[serde(rename = "m")]
    pub is_buyer_maker: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AggTradeEvent {
    pub event_time: i64,
    pub aggregate_trade_id: u64,
    pub price: f64,
    pub quantity: f64,
    pub trade_time: i64,
    pub is_buyer_maker: bool,
}

impl AggTradeEvent {
    pub fn direction(&self) -> i8 {
        direction_from_is_buyer_maker(self.is_buyer_maker)
    }

    pub fn notional(&self) -> f64 {
        self.price * self.quantity
    }
}

impl TryFrom<AggTradeWire> for AggTradeEvent {
    type Error = AppError;

    fn try_from(value: AggTradeWire) -> Result<Self, Self::Error> {
        if value.event_type != "aggTrade" {
            return Err(AppError::InvalidArgument(format!(
                "unexpected event type '{}' for aggTrade stream",
                value.event_type
            )));
        }

        let price = value.price.parse::<f64>()?;
        let quantity = value.quantity.parse::<f64>()?;
        if !price.is_finite() || !quantity.is_finite() || quantity < 0.0 {
            return Err(AppError::InvalidArgument(
                "price/quantity must be finite and quantity non-negative".to_string(),
            ));
        }

        Ok(Self {
            event_time: value.event_time,
            aggregate_trade_id: value.aggregate_trade_id,
            price,
            quantity,
            trade_time: value.trade_time,
            is_buyer_maker: value.is_buyer_maker,
        })
    }
}

pub fn parse_agg_trade_payload(payload: &mut [u8]) -> Result<AggTradeEvent, AppError> {
    let wire: AggTradeWire = simd_json::serde::from_slice(payload)?;
    wire.try_into()
}

pub fn direction_from_is_buyer_maker(is_buyer_maker: bool) -> i8 {
    if is_buyer_maker {
        -1
    } else {
        1
    }
}

#[derive(Debug, Deserialize)]
pub struct AggTradeSnapshotWire {
    #[serde(rename = "a")]
    pub aggregate_trade_id: u64,
    #[serde(rename = "p")]
    pub price: String,
}

#[derive(Debug, Clone)]
pub struct AggTradeSnapshot {
    pub aggregate_trade_id: u64,
    pub price: f64,
}

impl TryFrom<AggTradeSnapshotWire> for AggTradeSnapshot {
    type Error = AppError;

    fn try_from(value: AggTradeSnapshotWire) -> Result<Self, Self::Error> {
        let price = value.price.parse::<f64>()?;
        if !price.is_finite() {
            return Err(AppError::InvalidArgument(
                "snapshot price must be finite".to_string(),
            ));
        }
        Ok(Self {
            aggregate_trade_id: value.aggregate_trade_id,
            price,
        })
    }
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct KlineWire(
    pub i64,
    pub String,
    pub String,
    pub String,
    pub String,
    pub String,
    pub i64,
    pub String,
    pub u64,
    pub String,
    pub String,
    pub String,
);

impl TryFrom<KlineWire> for UiCandle {
    type Error = AppError;

    fn try_from(value: KlineWire) -> Result<Self, Self::Error> {
        let open = value.1.parse::<f64>()?;
        let high = value.2.parse::<f64>()?;
        let low = value.3.parse::<f64>()?;
        let close = value.4.parse::<f64>()?;
        let volume = value.5.parse::<f64>()?;

        if !open.is_finite()
            || !high.is_finite()
            || !low.is_finite()
            || !close.is_finite()
            || !volume.is_finite()
        {
            return Err(AppError::InvalidArgument(
                "kline values must be finite".to_string(),
            ));
        }

        Ok(Self {
            t: value.0,
            o: open,
            h: high,
            l: low,
            c: close,
            v: volume.max(0.0),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_agg_trade_payload() {
        let mut payload =
            br#"{"e":"aggTrade","E":123456790,"s":"BTCUSDT","a":55,"p":"1000.5","q":"0.25","T":123456789,"m":false}"#
                .to_vec();
        let event = parse_agg_trade_payload(&mut payload).expect("aggTrade payload should parse");

        assert_eq!(event.aggregate_trade_id, 55);
        assert_eq!(event.direction(), 1);
        assert_eq!(event.notional(), 250.125);
    }

    #[test]
    fn rejects_invalid_agg_trade_payload() {
        let mut payload =
            br#"{"e":"aggTrade","E":123456790,"s":"BTCUSDT","a":55,"p":"broken","q":"0.25","T":123456789,"m":false}"#
                .to_vec();

        let result = parse_agg_trade_payload(&mut payload);
        assert!(result.is_err());
    }

    #[test]
    fn maps_direction_from_buyer_maker_flag() {
        assert_eq!(direction_from_is_buyer_maker(true), -1);
        assert_eq!(direction_from_is_buyer_maker(false), 1);
    }

    #[test]
    fn normalizes_start_args_defaults() {
        let config = StartMarketStreamArgs::default()
            .normalize()
            .expect("defaults should be valid");

        assert_eq!(config.symbol, DEFAULT_SYMBOL);
        assert_eq!(config.min_notional_usdt, DEFAULT_MIN_NOTIONAL_USDT);
        assert_eq!(config.emit_interval_ms, DEFAULT_EMIT_INTERVAL_MS);
        assert_eq!(config.mock_mode, DEFAULT_MOCK_MODE);
        assert_eq!(
            config.emit_legacy_price_event,
            DEFAULT_EMIT_LEGACY_PRICE_EVENT
        );
        assert_eq!(
            config.emit_legacy_frame_events,
            DEFAULT_EMIT_LEGACY_FRAME_EVENTS
        );
        assert_eq!(config.perf_telemetry, DEFAULT_PERF_TELEMETRY);
        assert_eq!(
            config.clock_sync_interval_ms,
            DEFAULT_CLOCK_SYNC_INTERVAL_MS
        );
        assert_eq!(config.timeframe, DEFAULT_TIMEFRAME);
        assert_eq!(config.startup_mode, DEFAULT_STARTUP_MODE);
        assert_eq!(config.history_limit, DEFAULT_HISTORY_LIMIT);
    }

    #[test]
    fn validates_emit_interval_range() {
        let result = StartMarketStreamArgs {
            symbol: Some("BTCUSDT".to_string()),
            min_notional_usdt: Some(50.0),
            emit_interval_ms: Some(1),
            mock_mode: None,
            emit_legacy_price_event: None,
            emit_legacy_frame_events: None,
            perf_telemetry: None,
            clock_sync_interval_ms: None,
            timeframe: None,
            startup_mode: None,
            history_limit: None,
        }
        .normalize();

        assert!(result.is_err());
    }

    #[test]
    fn validates_history_limit_range() {
        let result = StartMarketStreamArgs {
            symbol: Some("BTCUSDT".to_string()),
            min_notional_usdt: Some(50.0),
            emit_interval_ms: Some(16),
            mock_mode: None,
            emit_legacy_price_event: None,
            emit_legacy_frame_events: None,
            perf_telemetry: None,
            clock_sync_interval_ms: None,
            timeframe: Some(MarketTimeframe::M1),
            startup_mode: None,
            history_limit: Some(10),
        }
        .normalize();

        assert!(result.is_err());
    }

    #[test]
    fn validates_clock_sync_interval_range() {
        let result = StartMarketStreamArgs {
            symbol: Some("BTCUSDT".to_string()),
            min_notional_usdt: Some(50.0),
            emit_interval_ms: Some(16),
            mock_mode: None,
            emit_legacy_price_event: None,
            emit_legacy_frame_events: None,
            perf_telemetry: None,
            clock_sync_interval_ms: Some(100),
            timeframe: Some(MarketTimeframe::M1),
            startup_mode: None,
            history_limit: Some(500),
        }
        .normalize();

        assert!(result.is_err());
    }
}
