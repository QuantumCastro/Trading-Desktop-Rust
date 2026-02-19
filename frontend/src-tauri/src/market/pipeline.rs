use crate::error::AppError;
use crate::market::binance::{
    connect_agg_trade_stream, fetch_klines_delta_history, fetch_klines_history,
    fetch_latest_agg_trade_snapshot, fetch_server_time_ms,
};
use crate::market::types::{
    parse_agg_trade_payload, AggTradeEvent, MarketConnectionState, MarketPerfSnapshot,
    MarketStartupMode, MarketStreamConfig, MarketStreamStatusSnapshot, MarketTimeframe, UiCandle,
    UiCandlesBootstrap, UiDeltaCandle, UiDeltaCandlesBootstrap, UiMarketFrameUpdate, UiTick,
};
use futures_util::StreamExt;
use parking_lot::Mutex;
use reqwest::Client;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::RwLock;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::{
    CANDLES_BOOTSTRAP_EVENT, CANDLE_UPDATE_EVENT, DELTA_CANDLES_BOOTSTRAP_EVENT,
    DELTA_CANDLE_UPDATE_EVENT, MARKET_FRAME_UPDATE_EVENT, MARKET_PERF_EVENT, MARKET_STATUS_EVENT,
    PRICE_UPDATE_EVENT,
};

const STATUS_HEARTBEAT_MS: u64 = 1_000;
const STATUS_ERROR_THROTTLE_MS: u64 = 500;
const PERF_WINDOW_CAPACITY: usize = 2_048;
const CLOCK_SYNC_PROBE_COUNT: usize = 5;
const CLOCK_SYNC_PROBE_SPACING_MS: u64 = 80;
const CLOCK_SYNC_MAX_VALID_RTT_MS: i64 = 2_000;
const CLOCK_SYNC_MIN_DELAY_MS: u64 = 10_000;
const CLOCK_SYNC_MAX_DELAY_MS: u64 = 90_000;

#[derive(Debug, Clone, Copy)]
struct ClockOffsetProbe {
    offset_ms: i64,
    rtt_ms: i64,
}

#[derive(Debug, Default)]
pub struct ConflatedMarketState {
    pub last_agg_id: Option<u64>,
    pub last_price: Option<f64>,
    pub last_latency_ms: Option<i64>,
    pending_price: Option<f64>,
    pending_volume: f64,
    pending_direction: i8,
    pending_time: i64,
    pending_ingest_started_at: Option<Instant>,
    last_candle: Option<UiCandle>,
    pending_candle: Option<UiCandle>,
    last_delta_candle: Option<UiDeltaCandle>,
    pending_delta_candle: Option<UiDeltaCandle>,
}

#[derive(Debug, Clone, Copy, Default)]
struct TelemetrySnapshot {
    last_agg_id: Option<u64>,
    latency_ms: Option<i64>,
    raw_exchange_latency_ms: Option<i64>,
    clock_offset_ms: Option<i64>,
    adjusted_network_latency_ms: Option<i64>,
    local_pipeline_latency_ms: Option<i64>,
}

#[derive(Debug, Default)]
struct MarketTelemetryAtomics {
    has_last_agg_id: AtomicBool,
    last_agg_id: AtomicU64,
    has_latency_ms: AtomicBool,
    latency_ms: AtomicI64,
    has_raw_exchange_latency_ms: AtomicBool,
    raw_exchange_latency_ms: AtomicI64,
    has_clock_offset_ms: AtomicBool,
    clock_offset_ms: AtomicI64,
    has_adjusted_network_latency_ms: AtomicBool,
    adjusted_network_latency_ms: AtomicI64,
    has_local_pipeline_latency_ms: AtomicBool,
    local_pipeline_latency_ms: AtomicI64,
}

impl MarketTelemetryAtomics {
    fn set_last_agg_id(&self, aggregate_trade_id: u64) {
        self.last_agg_id
            .store(aggregate_trade_id, Ordering::Relaxed);
        self.has_last_agg_id.store(true, Ordering::Relaxed);
    }

    fn set_network_latencies(
        &self,
        raw_exchange_latency_ms: i64,
        clock_offset_ms: Option<i64>,
        adjusted_network_latency_ms: i64,
    ) {
        self.raw_exchange_latency_ms
            .store(raw_exchange_latency_ms, Ordering::Relaxed);
        self.has_raw_exchange_latency_ms
            .store(true, Ordering::Relaxed);

        if let Some(offset) = clock_offset_ms {
            self.clock_offset_ms.store(offset, Ordering::Relaxed);
            self.has_clock_offset_ms.store(true, Ordering::Relaxed);
        }

        self.adjusted_network_latency_ms
            .store(adjusted_network_latency_ms, Ordering::Relaxed);
        self.has_adjusted_network_latency_ms
            .store(true, Ordering::Relaxed);

        // Backward-compatible field that old UI reads as "latencyMs".
        self.latency_ms
            .store(adjusted_network_latency_ms, Ordering::Relaxed);
        self.has_latency_ms.store(true, Ordering::Relaxed);
    }

    fn set_clock_offset_ms(&self, clock_offset_ms: i64) {
        self.clock_offset_ms
            .store(clock_offset_ms, Ordering::Relaxed);
        self.has_clock_offset_ms.store(true, Ordering::Relaxed);
    }

    fn clock_offset_ms(&self) -> Option<i64> {
        if self.has_clock_offset_ms.load(Ordering::Relaxed) {
            Some(self.clock_offset_ms.load(Ordering::Relaxed))
        } else {
            None
        }
    }

    fn set_local_pipeline_latency_ms(&self, local_pipeline_latency_ms: i64) {
        self.local_pipeline_latency_ms
            .store(local_pipeline_latency_ms, Ordering::Relaxed);
        self.has_local_pipeline_latency_ms
            .store(true, Ordering::Relaxed);
    }

    fn snapshot(&self) -> TelemetrySnapshot {
        TelemetrySnapshot {
            last_agg_id: if self.has_last_agg_id.load(Ordering::Relaxed) {
                Some(self.last_agg_id.load(Ordering::Relaxed))
            } else {
                None
            },
            latency_ms: if self.has_latency_ms.load(Ordering::Relaxed) {
                Some(self.latency_ms.load(Ordering::Relaxed))
            } else {
                None
            },
            raw_exchange_latency_ms: if self.has_raw_exchange_latency_ms.load(Ordering::Relaxed) {
                Some(self.raw_exchange_latency_ms.load(Ordering::Relaxed))
            } else {
                None
            },
            clock_offset_ms: if self.has_clock_offset_ms.load(Ordering::Relaxed) {
                Some(self.clock_offset_ms.load(Ordering::Relaxed))
            } else {
                None
            },
            adjusted_network_latency_ms: if self
                .has_adjusted_network_latency_ms
                .load(Ordering::Relaxed)
            {
                Some(self.adjusted_network_latency_ms.load(Ordering::Relaxed))
            } else {
                None
            },
            local_pipeline_latency_ms: if self.has_local_pipeline_latency_ms.load(Ordering::Relaxed)
            {
                Some(self.local_pipeline_latency_ms.load(Ordering::Relaxed))
            } else {
                None
            },
        }
    }
}

#[derive(Debug, Clone)]
struct RollingWindowU32 {
    values: [u32; PERF_WINDOW_CAPACITY],
    len: usize,
    cursor: usize,
}

impl Default for RollingWindowU32 {
    fn default() -> Self {
        Self {
            values: [0; PERF_WINDOW_CAPACITY],
            len: 0,
            cursor: 0,
        }
    }
}

impl RollingWindowU32 {
    fn push(&mut self, value: u32) {
        self.values[self.cursor] = value;
        self.cursor = (self.cursor + 1) % PERF_WINDOW_CAPACITY;
        if self.len < PERF_WINDOW_CAPACITY {
            self.len += 1;
        }
    }

    fn percentiles(&self) -> (Option<u32>, Option<u32>, Option<u32>) {
        if self.len == 0 {
            return (None, None, None);
        }

        let mut snapshot = Vec::with_capacity(self.len);
        snapshot.extend_from_slice(&self.values[..self.len]);
        snapshot.sort_unstable();

        (
            percentile_from_sorted(&snapshot, 50),
            percentile_from_sorted(&snapshot, 95),
            percentile_from_sorted(&snapshot, 99),
        )
    }
}

#[derive(Debug, Default)]
struct PerformanceTelemetry {
    parse_us: RollingWindowU32,
    apply_us: RollingWindowU32,
    local_pipeline_ms: RollingWindowU32,
    ingest_count: u64,
    emit_count: u64,
}

impl PerformanceTelemetry {
    fn record_ingest(&mut self, parse_us: u32, apply_us: u32) {
        self.parse_us.push(parse_us);
        self.apply_us.push(apply_us);
        self.ingest_count = self.ingest_count.saturating_add(1);
    }

    fn record_emit(&mut self, local_pipeline_latency_ms: Option<i64>) {
        if let Some(latency_ms) = local_pipeline_latency_ms {
            let bounded = latency_ms.max(0).min(u32::MAX as i64) as u32;
            self.local_pipeline_ms.push(bounded);
        }
        self.emit_count = self.emit_count.saturating_add(1);
    }

    fn snapshot(&self, now_ms: i64) -> MarketPerfSnapshot {
        let (parse_p50_us, parse_p95_us, parse_p99_us) = self.parse_us.percentiles();
        let (apply_p50_us, apply_p95_us, apply_p99_us) = self.apply_us.percentiles();
        let (local_pipeline_p50_ms, local_pipeline_p95_ms, local_pipeline_p99_ms) =
            self.local_pipeline_ms.percentiles();

        MarketPerfSnapshot {
            t: now_ms,
            parse_p50_us,
            parse_p95_us,
            parse_p99_us,
            apply_p50_us,
            apply_p95_us,
            apply_p99_us,
            local_pipeline_p50_ms,
            local_pipeline_p95_ms,
            local_pipeline_p99_ms,
            ingest_count: self.ingest_count,
            emit_count: self.emit_count,
        }
    }
}

fn percentile_from_sorted(sorted_values: &[u32], percentile: usize) -> Option<u32> {
    if sorted_values.is_empty() {
        return None;
    }
    let max_index = sorted_values.len().saturating_sub(1);
    let index = max_index.saturating_mul(percentile).saturating_div(100);
    sorted_values.get(index).copied()
}

#[derive(Debug, Default)]
struct ClockSyncEwma {
    initialized: bool,
    value_ms: i64,
}

impl ClockSyncEwma {
    fn update(&mut self, sample_ms: i64, rtt_ms: i64) -> i64 {
        if !self.initialized {
            self.value_ms = sample_ms;
            self.initialized = true;
            return self.value_ms;
        }

        let alpha_permille = if rtt_ms <= 80 {
            280_i64
        } else if rtt_ms <= 180 {
            200_i64
        } else if rtt_ms <= 350 {
            130_i64
        } else {
            90_i64
        };
        let delta = sample_ms.saturating_sub(self.value_ms);
        let bounded_delta = delta.clamp(-300, 300);
        self.value_ms = self
            .value_ms
            .saturating_add(bounded_delta.saturating_mul(alpha_permille) / 1_000);
        self.value_ms
    }
}

#[derive(Debug, Default)]
struct StatusPublishThrottle {
    last_state: Option<MarketConnectionState>,
    last_reason: Option<String>,
    last_emit: Option<Instant>,
}

struct StreamRuntimeContext<'a> {
    config: &'a MarketStreamConfig,
    http_client: &'a Client,
    shared_market_state: &'a Arc<Mutex<ConflatedMarketState>>,
    telemetry: &'a Arc<MarketTelemetryAtomics>,
    perf_telemetry: &'a Arc<Mutex<PerformanceTelemetry>>,
    status_store: &'a Arc<RwLock<MarketStreamStatusSnapshot>>,
    status_throttle: &'a Arc<Mutex<StatusPublishThrottle>>,
    window: &'a WebviewWindow,
    cancel_token: &'a CancellationToken,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TradeApplyOutcome {
    Applied { eligible_for_ui: bool },
    GapDetected { expected: u64, found: u64 },
    Stale { current: u64, last: u64 },
}

pub fn apply_trade_event(
    state: &mut ConflatedMarketState,
    trade: &AggTradeEvent,
    min_notional_usdt: f64,
    timeframe: MarketTimeframe,
    now_unix_ms: i64,
    ingest_started_at: Instant,
) -> TradeApplyOutcome {
    if let Some(last_agg_id) = state.last_agg_id {
        if trade.aggregate_trade_id <= last_agg_id {
            return TradeApplyOutcome::Stale {
                current: trade.aggregate_trade_id,
                last: last_agg_id,
            };
        }

        let expected = last_agg_id.saturating_add(1);
        if trade.aggregate_trade_id != expected {
            return TradeApplyOutcome::GapDetected {
                expected,
                found: trade.aggregate_trade_id,
            };
        }
    }

    state.last_agg_id = Some(trade.aggregate_trade_id);
    state.last_price = Some(trade.price);
    state.last_latency_ms = Some((now_unix_ms.saturating_sub(trade.event_time)).max(0));
    update_candle_from_trade(state, trade, timeframe);
    update_delta_candle_from_trade(state, trade, timeframe);
    state.pending_ingest_started_at = Some(ingest_started_at);

    if trade.notional() >= min_notional_usdt {
        state.pending_price = Some(trade.price);
        state.pending_volume += trade.quantity;
        state.pending_direction = trade.direction();
        state.pending_time = trade.trade_time;
        return TradeApplyOutcome::Applied {
            eligible_for_ui: true,
        };
    }

    TradeApplyOutcome::Applied {
        eligible_for_ui: false,
    }
}

fn update_candle_from_trade(
    state: &mut ConflatedMarketState,
    trade: &AggTradeEvent,
    timeframe: MarketTimeframe,
) {
    let timeframe_ms = timeframe.duration_ms();
    let bucket_open = candle_bucket_open_time(trade.trade_time, timeframe_ms);

    match state.last_candle.as_mut() {
        Some(current) if bucket_open < current.t => (),
        Some(current) if bucket_open == current.t => {
            current.apply_trade(trade.price, trade.quantity);
            state.pending_candle = Some(current.clone());
        }
        _ => {
            let next = UiCandle::from_trade(bucket_open, trade.price, trade.quantity);
            state.pending_candle = Some(next.clone());
            state.last_candle = Some(next);
        }
    }
}

fn update_delta_candle_from_trade(
    state: &mut ConflatedMarketState,
    trade: &AggTradeEvent,
    timeframe: MarketTimeframe,
) {
    let timeframe_ms = timeframe.duration_ms();
    let bucket_open = candle_bucket_open_time(trade.trade_time, timeframe_ms);
    let signed_volume = trade.quantity * f64::from(trade.direction());
    let absolute_volume = trade.quantity;

    match state.last_delta_candle.as_mut() {
        Some(current) if bucket_open < current.t => (),
        Some(current) if bucket_open == current.t => {
            current.apply_signed_volume(signed_volume, absolute_volume);
            state.pending_delta_candle = Some(current.clone());
        }
        _ => {
            let next =
                UiDeltaCandle::from_signed_volume(bucket_open, signed_volume, absolute_volume);
            state.pending_delta_candle = Some(next.clone());
            state.last_delta_candle = Some(next);
        }
    }
}

fn apply_history_snapshot(state: &mut ConflatedMarketState, candles: &[UiCandle]) {
    if let Some(last_candle) = candles.last() {
        let should_replace = state
            .last_candle
            .as_ref()
            .map(|current| last_candle.t >= current.t)
            .unwrap_or(true);
        if should_replace {
            state.last_candle = Some(last_candle.clone());
            state.last_price = Some(last_candle.c);
        }
    }
}

fn apply_delta_history_snapshot(state: &mut ConflatedMarketState, candles: &[UiDeltaCandle]) {
    if let Some(last_candle) = candles.last() {
        let should_replace = state
            .last_delta_candle
            .as_ref()
            .map(|current| last_candle.t >= current.t)
            .unwrap_or(true);
        if should_replace {
            state.last_delta_candle = Some(last_candle.clone());
        }
    }
}

fn candle_bucket_open_time(timestamp_ms: i64, timeframe_ms: i64) -> i64 {
    if timeframe_ms <= 0 {
        return timestamp_ms;
    }
    timestamp_ms - (timestamp_ms.rem_euclid(timeframe_ms))
}

pub fn apply_snapshot(state: &mut ConflatedMarketState, aggregate_trade_id: u64, price: f64) {
    state.last_agg_id = Some(aggregate_trade_id);
    state.last_price = Some(price);
    state.pending_price = None;
    state.pending_volume = 0.0;
    state.pending_direction = 0;
    state.pending_time = 0;
    state.pending_ingest_started_at = None;
}

pub fn drain_ui_tick(state: &mut ConflatedMarketState) -> Option<UiTick> {
    let pending_price = state.pending_price.take()?;
    let pending_volume = state.pending_volume;
    let pending_direction = state.pending_direction;
    let pending_time = state.pending_time;

    state.pending_volume = 0.0;
    state.pending_direction = 0;
    state.pending_time = 0;

    Some(UiTick {
        t: pending_time,
        p: pending_price,
        v: pending_volume,
        d: pending_direction,
    })
}

pub fn drain_ui_candle(state: &mut ConflatedMarketState) -> Option<UiCandle> {
    state.pending_candle.take()
}

pub fn drain_ui_delta_candle(state: &mut ConflatedMarketState) -> Option<UiDeltaCandle> {
    state.pending_delta_candle.take()
}

pub fn drain_market_frame(
    state: &mut ConflatedMarketState,
    emitted_at: Instant,
) -> Option<UiMarketFrameUpdate> {
    let tick = drain_ui_tick(state);
    let candle = drain_ui_candle(state);
    let delta_candle = drain_ui_delta_candle(state);
    if tick.is_none() && candle.is_none() && delta_candle.is_none() {
        return None;
    }

    let local_pipeline_latency_ms = state
        .pending_ingest_started_at
        .take()
        .map(|started| emitted_at.saturating_duration_since(started).as_millis())
        .map(|latency| latency.min(i64::MAX as u128) as i64);

    Some(UiMarketFrameUpdate {
        tick,
        candle,
        delta_candle,
        local_pipeline_latency_ms,
    })
}

enum StreamDirective {
    Continue,
    ImmediateReconnect,
    Cancelled,
}

pub async fn run_market_stream(
    app_handle: AppHandle,
    config: MarketStreamConfig,
    status_store: Arc<RwLock<MarketStreamStatusSnapshot>>,
    cancel_token: CancellationToken,
) {
    let window = match app_handle.get_webview_window("main") {
        Some(window) => window,
        None => {
            let snapshot = MarketStreamStatusSnapshot {
                state: MarketConnectionState::Error,
                symbol: config.symbol,
                timeframe: config.timeframe,
                last_agg_id: None,
                latency_ms: None,
                raw_exchange_latency_ms: None,
                clock_offset_ms: None,
                adjusted_network_latency_ms: None,
                local_pipeline_latency_ms: None,
                reason: Some(AppError::WindowNotFound("main".to_string()).to_string()),
            };
            let mut writable = status_store.write().await;
            *writable = snapshot;
            return;
        }
    };

    let shared_market_state = Arc::new(Mutex::new(ConflatedMarketState::default()));
    let telemetry = Arc::new(MarketTelemetryAtomics::default());
    let perf_telemetry = Arc::new(Mutex::new(PerformanceTelemetry::default()));
    let status_throttle = Arc::new(Mutex::new(StatusPublishThrottle::default()));
    let http_client = Client::new();

    let history_handle = match config.startup_mode {
        MarketStartupMode::HistoryFirst => {
            publish_status(
                &status_store,
                &window,
                &telemetry,
                MarketConnectionState::Connecting,
                &config.symbol,
                config.timeframe,
                Some("loading historical candles".to_string()),
            )
            .await;

            if let Err(error) = load_and_emit_history(
                &config,
                &http_client,
                &window,
                &shared_market_state,
                &telemetry,
                &status_store,
                &cancel_token,
            )
            .await
            {
                publish_status(
                    &status_store,
                    &window,
                    &telemetry,
                    MarketConnectionState::Error,
                    &config.symbol,
                    config.timeframe,
                    Some(format!("failed to load historical candles: {error}")),
                )
                .await;
            }

            None
        }
        MarketStartupMode::LiveFirst => {
            publish_status(
                &status_store,
                &window,
                &telemetry,
                MarketConnectionState::Connecting,
                &config.symbol,
                config.timeframe,
                Some("opening websocket stream while history loads".to_string()),
            )
            .await;

            let history_config = config.clone();
            let history_client = http_client.clone();
            let history_window = window.clone();
            let history_state = Arc::clone(&shared_market_state);
            let history_telemetry = Arc::clone(&telemetry);
            let history_status_store = Arc::clone(&status_store);
            let history_cancel = cancel_token.clone();

            Some(tauri::async_runtime::spawn(async move {
                if history_cancel.is_cancelled() {
                    return;
                }

                if let Err(error) = load_and_emit_history(
                    &history_config,
                    &history_client,
                    &history_window,
                    &history_state,
                    &history_telemetry,
                    &history_status_store,
                    &history_cancel,
                )
                .await
                {
                    let current_state = {
                        let readable = history_status_store.read().await;
                        readable.state
                    };
                    publish_status(
                        &history_status_store,
                        &history_window,
                        &history_telemetry,
                        current_state,
                        &history_config.symbol,
                        history_config.timeframe,
                        Some(format!("historical candles unavailable: {error}")),
                    )
                    .await;
                }
            }))
        }
    };

    let consumer_cancel = cancel_token.clone();
    let consumer_status_store = Arc::clone(&status_store);
    let consumer_state = Arc::clone(&shared_market_state);
    let consumer_telemetry = Arc::clone(&telemetry);
    let consumer_perf_telemetry = Arc::clone(&perf_telemetry);
    let consumer_window = window.clone();
    let consumer_symbol = config.symbol.clone();
    let consumer_interval_ms = config.emit_interval_ms;
    let consumer_emit_legacy_price_event = config.emit_legacy_price_event;
    let consumer_emit_legacy_frame_events = config.emit_legacy_frame_events;
    let consumer_timeframe = config.timeframe;

    let consumer_handle = tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(consumer_interval_ms));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = consumer_cancel.cancelled() => {
                    break;
                }
                _ = ticker.tick() => {
                    let maybe_frame = {
                        let emitted_at = Instant::now();
                        let mut writable = consumer_state.lock();
                        drain_market_frame(&mut writable, emitted_at)
                    };

                    let Some(frame) = maybe_frame else {
                        continue;
                    };

                    if let Some(local_pipeline_latency_ms) = frame.local_pipeline_latency_ms {
                        consumer_telemetry
                            .set_local_pipeline_latency_ms(local_pipeline_latency_ms.max(0));
                    }
                    consumer_perf_telemetry
                        .lock()
                        .record_emit(frame.local_pipeline_latency_ms);

                    if let Err(error) = consumer_window.emit(MARKET_FRAME_UPDATE_EVENT, &frame) {
                        publish_status(
                            &consumer_status_store,
                            &consumer_window,
                            &consumer_telemetry,
                            MarketConnectionState::Error,
                            &consumer_symbol,
                            consumer_timeframe,
                            Some(format!("failed to emit market_frame_update: {error}")),
                        )
                        .await;
                    }

                    if consumer_emit_legacy_price_event {
                        if let Some(ui_tick) = frame.tick.clone() {
                            if let Err(error) = consumer_window.emit(PRICE_UPDATE_EVENT, ui_tick) {
                                publish_status(
                                    &consumer_status_store,
                                    &consumer_window,
                                    &consumer_telemetry,
                                    MarketConnectionState::Error,
                                    &consumer_symbol,
                                    consumer_timeframe,
                                    Some(format!("failed to emit price_update: {error}")),
                                ).await;
                            }
                        }
                    }

                    if consumer_emit_legacy_frame_events {
                        if let Some(candle) = frame.candle.clone() {
                            if let Err(error) = consumer_window.emit(CANDLE_UPDATE_EVENT, candle) {
                                publish_status(
                                    &consumer_status_store,
                                    &consumer_window,
                                    &consumer_telemetry,
                                    MarketConnectionState::Error,
                                    &consumer_symbol,
                                    consumer_timeframe,
                                    Some(format!("failed to emit candle_update: {error}")),
                                ).await;
                            }
                        }

                        if let Some(delta_candle) = frame.delta_candle {
                            if let Err(error) = consumer_window.emit(DELTA_CANDLE_UPDATE_EVENT, delta_candle) {
                                publish_status(
                                    &consumer_status_store,
                                    &consumer_window,
                                    &consumer_telemetry,
                                    MarketConnectionState::Error,
                                    &consumer_symbol,
                                    consumer_timeframe,
                                    Some(format!("failed to emit delta_candle_update: {error}")),
                                ).await;
                            }
                        }
                    }
                }
            }
        }
    });

    let heartbeat_cancel = cancel_token.clone();
    let heartbeat_status_store = Arc::clone(&status_store);
    let heartbeat_telemetry = Arc::clone(&telemetry);
    let heartbeat_perf_telemetry = Arc::clone(&perf_telemetry);
    let heartbeat_window = window.clone();
    let heartbeat_symbol = config.symbol.clone();
    let heartbeat_timeframe = config.timeframe;
    let heartbeat_perf_enabled = config.perf_telemetry;
    let heartbeat_handle = tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(STATUS_HEARTBEAT_MS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = heartbeat_cancel.cancelled() => break,
                _ = ticker.tick() => {
                    let (current_state, current_reason) = {
                        let readable = heartbeat_status_store.read().await;
                        (readable.state, readable.reason.clone())
                    };
                    publish_status(
                        &heartbeat_status_store,
                        &heartbeat_window,
                        &heartbeat_telemetry,
                        current_state,
                        &heartbeat_symbol,
                        heartbeat_timeframe,
                        current_reason,
                    ).await;

                    if heartbeat_perf_enabled {
                        let snapshot = {
                            let readable = heartbeat_perf_telemetry.lock();
                            readable.snapshot(now_unix_ms())
                        };
                        if let Err(error) = heartbeat_window.emit(MARKET_PERF_EVENT, snapshot) {
                            eprintln!("failed to emit market_perf event: {error}");
                        }
                    }
                }
            }
        }
    });

    let clock_cancel = cancel_token.clone();
    let clock_telemetry = Arc::clone(&telemetry);
    let clock_http_client = http_client.clone();
    let clock_sync_base_interval_ms = config.clock_sync_interval_ms;
    let clock_handle = tauri::async_runtime::spawn(async move {
        let mut next_delay_ms = 0_u64;
        let mut ewma = ClockSyncEwma::default();

        loop {
            tokio::select! {
                _ = clock_cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(next_delay_ms)) => {
                    match fetch_clock_offset_ms(&clock_http_client).await {
                        Ok(probe) => {
                            let smoothed_offset = ewma.update(probe.offset_ms, probe.rtt_ms);
                            clock_telemetry.set_clock_offset_ms(smoothed_offset);
                            next_delay_ms = next_clock_sync_delay_ms(
                                clock_sync_base_interval_ms,
                                probe.rtt_ms,
                                probe.offset_ms.saturating_sub(smoothed_offset).abs(),
                            );
                        }
                        Err(error) => {
                            eprintln!("clock sync failed: {error}");
                            next_delay_ms = clock_sync_base_interval_ms.max(CLOCK_SYNC_MIN_DELAY_MS);
                        }
                    }
                }
            }
        }
    });

    if config.mock_mode {
        run_mock_producer(
            &config,
            &shared_market_state,
            &telemetry,
            &status_store,
            &window,
            &cancel_token,
        )
        .await;

        cancel_token.cancel();
        let _ = consumer_handle.await;
        let _ = heartbeat_handle.await;
        let _ = clock_handle.await;
        if let Some(handle) = history_handle {
            let _ = handle.await;
        }

        publish_status(
            &status_store,
            &window,
            &telemetry,
            MarketConnectionState::Stopped,
            &config.symbol,
            config.timeframe,
            Some("mock stream stopped".to_string()),
        )
        .await;
        return;
    }

    let mut reconnect_attempt = 0_u32;
    let stream_context = StreamRuntimeContext {
        config: &config,
        http_client: &http_client,
        shared_market_state: &shared_market_state,
        telemetry: &telemetry,
        perf_telemetry: &perf_telemetry,
        status_store: &status_store,
        status_throttle: &status_throttle,
        window: &window,
        cancel_token: &cancel_token,
    };
    while !cancel_token.is_cancelled() {
        let phase = if reconnect_attempt == 0 {
            MarketConnectionState::Connecting
        } else {
            MarketConnectionState::Reconnecting
        };

        let reason = if reconnect_attempt == 0 {
            Some("opening websocket stream".to_string())
        } else {
            Some(format!("reconnect attempt {reconnect_attempt}"))
        };

        publish_status(
            &status_store,
            &window,
            &telemetry,
            phase,
            &config.symbol,
            config.timeframe,
            reason,
        )
        .await;

        match connect_agg_trade_stream(&config.symbol).await {
            Ok(mut websocket_stream) => {
                reconnect_attempt = 0;
                publish_status(
                    &status_store,
                    &window,
                    &telemetry,
                    MarketConnectionState::Live,
                    &config.symbol,
                    config.timeframe,
                    Some("websocket connected".to_string()),
                )
                .await;

                let mut immediate_reconnect = false;
                loop {
                    let frame = tokio::select! {
                        _ = cancel_token.cancelled() => {
                            break;
                        }
                        next_message = websocket_stream.next() => next_message,
                    };

                    let Some(frame_result) = frame else {
                        break;
                    };

                    match frame_result {
                        Ok(message) => match handle_message(message, &stream_context).await {
                            StreamDirective::Continue => {}
                            StreamDirective::ImmediateReconnect => {
                                immediate_reconnect = true;
                                break;
                            }
                            StreamDirective::Cancelled => {
                                reconnect_attempt = 0;
                                break;
                            }
                        },
                        Err(error) => {
                            publish_status_throttled(
                                &stream_context,
                                MarketConnectionState::Reconnecting,
                                Some(format!("websocket frame error: {error}")),
                            )
                            .await;
                            break;
                        }
                    }
                }

                if cancel_token.is_cancelled() {
                    break;
                }

                if immediate_reconnect {
                    reconnect_attempt = 0;
                    continue;
                }
            }
            Err(error) => {
                publish_status_throttled(
                    &stream_context,
                    MarketConnectionState::Reconnecting,
                    Some(format!("websocket connect error: {error}")),
                )
                .await;
            }
        }

        reconnect_attempt = reconnect_attempt.saturating_add(1);
        let delay = reconnect_delay(reconnect_attempt);
        tokio::select! {
            _ = cancel_token.cancelled() => break,
            _ = tokio::time::sleep(delay) => {}
        }
    }

    cancel_token.cancel();
    let _ = consumer_handle.await;
    let _ = heartbeat_handle.await;
    let _ = clock_handle.await;
    if let Some(handle) = history_handle {
        let _ = handle.await;
    }

    publish_status(
        &status_store,
        &window,
        &telemetry,
        MarketConnectionState::Stopped,
        &config.symbol,
        config.timeframe,
        Some("stream stopped".to_string()),
    )
    .await;
}

async fn load_and_emit_history(
    config: &MarketStreamConfig,
    http_client: &Client,
    window: &WebviewWindow,
    shared_market_state: &Arc<Mutex<ConflatedMarketState>>,
    telemetry: &Arc<MarketTelemetryAtomics>,
    status_store: &Arc<RwLock<MarketStreamStatusSnapshot>>,
    cancel_token: &CancellationToken,
) -> Result<(), AppError> {
    if cancel_token.is_cancelled() {
        return Ok(());
    }

    let (candles, delta_candles) = if config.mock_mode {
        (
            build_mock_history(config.timeframe, config.history_limit, now_unix_ms()),
            build_mock_delta_history(config.timeframe, config.history_limit, now_unix_ms()),
        )
    } else {
        let candles_future = fetch_klines_history(
            http_client,
            &config.symbol,
            config.timeframe,
            config.history_limit,
        );
        let delta_future = fetch_klines_delta_history(
            http_client,
            &config.symbol,
            config.timeframe,
            config.history_limit,
        );
        let (candles_result, delta_result) = tokio::join!(candles_future, delta_future);
        let candles = candles_result?;
        let delta_candles = match delta_result {
            Ok(candles) => candles,
            Err(error) => {
                publish_status(
                    status_store,
                    window,
                    telemetry,
                    MarketConnectionState::Connecting,
                    &config.symbol,
                    config.timeframe,
                    Some(format!("delta history unavailable: {error}")),
                )
                .await;
                Vec::new()
            }
        };
        (candles, delta_candles)
    };

    if cancel_token.is_cancelled() {
        return Ok(());
    }

    {
        let mut writable = shared_market_state.lock();
        apply_history_snapshot(&mut writable, &candles);
        apply_delta_history_snapshot(&mut writable, &delta_candles);
    }

    let payload = UiCandlesBootstrap {
        symbol: config.symbol.clone(),
        timeframe: config.timeframe,
        candles,
    };

    window.emit(CANDLES_BOOTSTRAP_EVENT, payload)?;
    let delta_payload = UiDeltaCandlesBootstrap {
        symbol: config.symbol.clone(),
        timeframe: config.timeframe,
        candles: delta_candles,
    };
    window.emit(DELTA_CANDLES_BOOTSTRAP_EVENT, delta_payload)?;

    publish_status(
        status_store,
        window,
        telemetry,
        current_operational_state(status_store).await,
        &config.symbol,
        config.timeframe,
        Some("historical candles loaded".to_string()),
    )
    .await;

    Ok(())
}

async fn current_operational_state(
    status_store: &Arc<RwLock<MarketStreamStatusSnapshot>>,
) -> MarketConnectionState {
    let readable = status_store.read().await;
    match readable.state {
        MarketConnectionState::Live => MarketConnectionState::Live,
        MarketConnectionState::Reconnecting => MarketConnectionState::Reconnecting,
        MarketConnectionState::Desynced => MarketConnectionState::Desynced,
        _ => MarketConnectionState::Connecting,
    }
}

fn build_mock_history(
    timeframe: MarketTimeframe,
    history_limit: u16,
    now_ms: i64,
) -> Vec<UiCandle> {
    let timeframe_ms = timeframe.duration_ms();
    let aligned_now = candle_bucket_open_time(now_ms, timeframe_ms);
    let start = aligned_now - (history_limit as i64 * timeframe_ms);
    let mut candles = Vec::with_capacity(history_limit as usize);
    let mut price = 100_000.0;

    for step in 0..history_limit {
        let open_time = start + step as i64 * timeframe_ms;
        let drift = ((step % 7) as f64 - 3.0) * 2.1;
        let open = price;
        let close = (open + drift).max(1.0);
        let high = open.max(close) + 1.25;
        let low = open.min(close) - 1.1;
        let volume = 2.0 + (step % 5) as f64 * 0.3;
        candles.push(UiCandle {
            t: open_time,
            o: open,
            h: high,
            l: low,
            c: close,
            v: volume,
        });
        price = close;
    }

    candles
}

fn build_mock_delta_history(
    timeframe: MarketTimeframe,
    history_limit: u16,
    now_ms: i64,
) -> Vec<UiDeltaCandle> {
    let timeframe_ms = timeframe.duration_ms();
    let aligned_now = candle_bucket_open_time(now_ms, timeframe_ms);
    let start = aligned_now - (history_limit as i64 * timeframe_ms);
    let mut candles = Vec::with_capacity(history_limit as usize);

    for step in 0..history_limit {
        let open_time = start + step as i64 * timeframe_ms;
        let direction = if step % 2 == 0 { 1.0 } else { -1.0 };
        let magnitude = 1.0 + (step % 7) as f64 * 0.35;
        let close = direction * magnitude;
        candles.push(UiDeltaCandle {
            t: open_time,
            o: 0.0,
            h: close.max(0.0),
            l: close.min(0.0),
            c: close,
            v: magnitude.abs(),
        });
    }

    candles
}

async fn run_mock_producer(
    config: &MarketStreamConfig,
    shared_market_state: &Arc<Mutex<ConflatedMarketState>>,
    telemetry: &Arc<MarketTelemetryAtomics>,
    status_store: &Arc<RwLock<MarketStreamStatusSnapshot>>,
    window: &WebviewWindow,
    cancel_token: &CancellationToken,
) {
    publish_status(
        status_store,
        window,
        telemetry,
        MarketConnectionState::Connecting,
        &config.symbol,
        config.timeframe,
        Some("starting deterministic mock stream".to_string()),
    )
    .await;

    publish_status(
        status_store,
        window,
        telemetry,
        MarketConnectionState::Live,
        &config.symbol,
        config.timeframe,
        Some("mock mode active".to_string()),
    )
    .await;

    let mut aggregate_trade_id = 0_u64;
    let mut synthetic_price = 100_000.0_f64;
    let mut ticker = tokio::time::interval(Duration::from_millis(4));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    while !cancel_token.is_cancelled() {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            _ = ticker.tick() => {
                aggregate_trade_id = aggregate_trade_id.saturating_add(1);
                let upward_move = aggregate_trade_id.is_multiple_of(2);
                synthetic_price += if upward_move { 0.6 } else { -0.4 };
                let quantity = 0.12 + ((aggregate_trade_id % 5) as f64 * 0.01);
                let now_ms = now_unix_ms();
                let ingest_started_at = Instant::now();
                let synthetic_event = AggTradeEvent {
                    event_time: now_ms,
                    aggregate_trade_id,
                    price: synthetic_price,
                    quantity,
                    trade_time: now_ms,
                    is_buyer_maker: !upward_move,
                };

                {
                    let mut writable = shared_market_state.lock();
                    let _ = apply_trade_event(
                        &mut writable,
                        &synthetic_event,
                        config.min_notional_usdt,
                        config.timeframe,
                        now_ms,
                        ingest_started_at,
                    );
                }
                telemetry.set_last_agg_id(synthetic_event.aggregate_trade_id);
                telemetry.set_network_latencies(0, telemetry.clock_offset_ms(), 0);
            }
        }
    }
}

async fn handle_message(message: Message, context: &StreamRuntimeContext<'_>) -> StreamDirective {
    let ingest_started_at = Instant::now();
    let parse_started_at = Instant::now();
    let trade_event = match message {
        Message::Text(text_payload) => {
            let mut owned_payload = text_payload.into_bytes();
            match parse_agg_trade_payload(owned_payload.as_mut_slice()) {
                Ok(parsed) => parsed,
                Err(error) => {
                    publish_status_throttled(
                        context,
                        MarketConnectionState::Error,
                        Some(format!("failed to decode aggTrade payload: {error}")),
                    )
                    .await;
                    return StreamDirective::Continue;
                }
            }
        }
        Message::Binary(mut binary_payload) => {
            match parse_agg_trade_payload(binary_payload.as_mut_slice()) {
                Ok(parsed) => parsed,
                Err(error) => {
                    publish_status_throttled(
                        context,
                        MarketConnectionState::Error,
                        Some(format!("failed to decode binary aggTrade payload: {error}")),
                    )
                    .await;
                    return StreamDirective::Continue;
                }
            }
        }
        Message::Close(_) => return StreamDirective::ImmediateReconnect,
        _ => return StreamDirective::Continue,
    };
    let parse_elapsed_us = parse_started_at.elapsed().as_micros().min(u32::MAX as u128) as u32;

    let now_ms = now_unix_ms();
    let apply_started_at = Instant::now();
    let outcome = {
        let mut writable = context.shared_market_state.lock();
        apply_trade_event(
            &mut writable,
            &trade_event,
            context.config.min_notional_usdt,
            context.config.timeframe,
            now_ms,
            ingest_started_at,
        )
    };
    let apply_elapsed_us = apply_started_at.elapsed().as_micros().min(u32::MAX as u128) as u32;
    context
        .perf_telemetry
        .lock()
        .record_ingest(parse_elapsed_us, apply_elapsed_us);

    match outcome {
        TradeApplyOutcome::Applied { .. } => {
            context
                .telemetry
                .set_last_agg_id(trade_event.aggregate_trade_id);
            let raw_exchange_latency_ms = signed_time_delta_ms(now_ms, trade_event.event_time);
            let clock_offset_ms = context.telemetry.clock_offset_ms();
            let adjusted_network_latency_ms =
                adjusted_network_latency_ms(raw_exchange_latency_ms, clock_offset_ms);
            context.telemetry.set_network_latencies(
                raw_exchange_latency_ms,
                clock_offset_ms,
                adjusted_network_latency_ms,
            );
            StreamDirective::Continue
        }
        TradeApplyOutcome::Stale { .. } => StreamDirective::Continue,
        TradeApplyOutcome::GapDetected { expected, found } => {
            publish_status(
                context.status_store,
                context.window,
                context.telemetry,
                MarketConnectionState::Desynced,
                &context.config.symbol,
                context.config.timeframe,
                Some(format!(
                    "aggTrade gap detected (expected {expected}, found {found})"
                )),
            )
            .await;

            let resync_ok = resync_with_snapshot(context).await;

            if resync_ok {
                StreamDirective::ImmediateReconnect
            } else {
                StreamDirective::Cancelled
            }
        }
    }
}

async fn resync_with_snapshot(context: &StreamRuntimeContext<'_>) -> bool {
    let mut attempt = 0_u32;
    while !context.cancel_token.is_cancelled() {
        publish_status(
            context.status_store,
            context.window,
            context.telemetry,
            MarketConnectionState::Reconnecting,
            &context.config.symbol,
            context.config.timeframe,
            Some(format!("starting snapshot resync attempt {}", attempt + 1)),
        )
        .await;

        match fetch_latest_agg_trade_snapshot(context.http_client, &context.config.symbol).await {
            Ok(snapshot) => {
                {
                    let mut writable = context.shared_market_state.lock();
                    apply_snapshot(&mut writable, snapshot.aggregate_trade_id, snapshot.price);
                }
                context
                    .telemetry
                    .set_last_agg_id(snapshot.aggregate_trade_id);

                publish_status(
                    context.status_store,
                    context.window,
                    context.telemetry,
                    MarketConnectionState::Live,
                    &context.config.symbol,
                    context.config.timeframe,
                    Some("snapshot resync completed".to_string()),
                )
                .await;
                return true;
            }
            Err(error) => {
                attempt = attempt.saturating_add(1);
                publish_status_throttled(
                    context,
                    MarketConnectionState::Reconnecting,
                    Some(format!("snapshot resync failed: {error}")),
                )
                .await;

                let delay = reconnect_delay(attempt);
                tokio::select! {
                    _ = context.cancel_token.cancelled() => return false,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }

    false
}

async fn publish_status(
    status_store: &Arc<RwLock<MarketStreamStatusSnapshot>>,
    window: &WebviewWindow,
    telemetry: &Arc<MarketTelemetryAtomics>,
    state: MarketConnectionState,
    symbol: &str,
    timeframe: MarketTimeframe,
    reason: Option<String>,
) {
    let telemetry_snapshot = telemetry.snapshot();
    let snapshot = MarketStreamStatusSnapshot {
        state,
        symbol: symbol.to_string(),
        timeframe,
        last_agg_id: telemetry_snapshot.last_agg_id,
        latency_ms: telemetry_snapshot.latency_ms,
        raw_exchange_latency_ms: telemetry_snapshot.raw_exchange_latency_ms,
        clock_offset_ms: telemetry_snapshot.clock_offset_ms,
        adjusted_network_latency_ms: telemetry_snapshot.adjusted_network_latency_ms,
        local_pipeline_latency_ms: telemetry_snapshot.local_pipeline_latency_ms,
        reason,
    };

    {
        let mut writable = status_store.write().await;
        *writable = snapshot.clone();
    }

    if let Err(error) = window.emit(MARKET_STATUS_EVENT, snapshot) {
        eprintln!("failed to emit market status event: {error}");
    }
}

fn allow_status_publish(
    throttle: &Arc<Mutex<StatusPublishThrottle>>,
    state: MarketConnectionState,
    reason: &Option<String>,
) -> bool {
    let mut writable = throttle.lock();
    let now = Instant::now();
    let should_throttle = matches!(
        state,
        MarketConnectionState::Error | MarketConnectionState::Reconnecting
    );

    if should_throttle
        && writable.last_state == Some(state)
        && writable.last_reason == *reason
        && writable
            .last_emit
            .map(|instant| {
                now.duration_since(instant) < Duration::from_millis(STATUS_ERROR_THROTTLE_MS)
            })
            .unwrap_or(false)
    {
        return false;
    }

    writable.last_state = Some(state);
    writable.last_reason = reason.clone();
    writable.last_emit = Some(now);
    true
}

async fn publish_status_throttled(
    context: &StreamRuntimeContext<'_>,
    state: MarketConnectionState,
    reason: Option<String>,
) {
    if !allow_status_publish(context.status_throttle, state, &reason) {
        return;
    }

    publish_status(
        context.status_store,
        context.window,
        context.telemetry,
        state,
        &context.config.symbol,
        context.config.timeframe,
        reason,
    )
    .await;
}

async fn fetch_clock_offset_ms(client: &Client) -> Result<ClockOffsetProbe, AppError> {
    let mut probes: Vec<ClockOffsetProbe> = Vec::with_capacity(CLOCK_SYNC_PROBE_COUNT);

    for probe_index in 0..CLOCK_SYNC_PROBE_COUNT {
        if probe_index > 0 {
            tokio::time::sleep(Duration::from_millis(CLOCK_SYNC_PROBE_SPACING_MS)).await;
        }

        if let Ok(probe) = fetch_clock_offset_probe(client).await {
            if (0..=CLOCK_SYNC_MAX_VALID_RTT_MS).contains(&probe.rtt_ms) {
                probes.push(probe);
            }
        }
    }

    if probes.is_empty() {
        return Err(AppError::InvalidArgument(
            "clock sync probes failed".to_string(),
        ));
    }

    probes.sort_unstable_by_key(|probe| probe.rtt_ms);
    let best = probes[0];

    // NTP-style: trust low RTT samples first, then smooth with median of top candidates.
    let candidate_count = probes.len().min(3);
    let mut candidate_offsets: Vec<i64> = probes
        .iter()
        .take(candidate_count)
        .map(|probe| probe.offset_ms)
        .collect();
    candidate_offsets.sort_unstable();
    let median = candidate_offsets[candidate_offsets.len() / 2];
    let blended_offset = (best.offset_ms.saturating_mul(2)).saturating_add(median) / 3;

    Ok(ClockOffsetProbe {
        offset_ms: blended_offset,
        rtt_ms: best.rtt_ms,
    })
}

async fn fetch_clock_offset_probe(client: &Client) -> Result<ClockOffsetProbe, AppError> {
    let request_started_ms = now_unix_ms();
    let server_time_ms = fetch_server_time_ms(client).await?;
    let request_finished_ms = now_unix_ms();

    let rtt_ms = signed_time_delta_ms(request_finished_ms, request_started_ms).max(0);
    let local_midpoint_ms = request_started_ms.saturating_add(rtt_ms / 2);
    let offset_ms = signed_time_delta_ms(server_time_ms, local_midpoint_ms);

    Ok(ClockOffsetProbe { offset_ms, rtt_ms })
}

fn next_clock_sync_delay_ms(base_interval_ms: u64, rtt_ms: i64, residual_offset_ms: i64) -> u64 {
    let base = base_interval_ms.max(CLOCK_SYNC_MIN_DELAY_MS);
    let stable = rtt_ms <= 120 && residual_offset_ms <= 20;
    let delay = if stable {
        base.saturating_mul(2)
    } else if rtt_ms <= 250 && residual_offset_ms <= 50 {
        base.saturating_mul(3) / 2
    } else {
        base
    };
    delay.clamp(CLOCK_SYNC_MIN_DELAY_MS, CLOCK_SYNC_MAX_DELAY_MS)
}

fn adjusted_network_latency_ms(raw_exchange_latency_ms: i64, clock_offset_ms: Option<i64>) -> i64 {
    // Convert local-time delta into server-time delta:
    // adjusted ~= (now_local + offset_server_minus_local) - event_time_server
    // where raw_exchange_latency_ms = now_local - event_time_server.
    let adjusted = match clock_offset_ms {
        Some(offset) => raw_exchange_latency_ms.saturating_add(offset),
        None => raw_exchange_latency_ms,
    };
    adjusted.max(0)
}

fn signed_time_delta_ms(lhs_ms: i64, rhs_ms: i64) -> i64 {
    let delta = (lhs_ms as i128) - (rhs_ms as i128);
    delta.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.min(6);
    let base_ms = 200_u64.saturating_mul(1_u64 << exponent);
    let jitter_ms = (now_unix_ms().unsigned_abs() % 250).min(249);
    Duration::from_millis((base_ms + jitter_ms).min(5_000))
}

fn now_unix_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_trade(
        id: u64,
        trade_time: i64,
        price: f64,
        qty: f64,
        is_buyer_maker: bool,
    ) -> AggTradeEvent {
        AggTradeEvent {
            event_time: trade_time,
            aggregate_trade_id: id,
            price,
            quantity: qty,
            trade_time,
            is_buyer_maker,
        }
    }

    fn apply_trade_event_for_test(
        state: &mut ConflatedMarketState,
        trade: &AggTradeEvent,
        min_notional_usdt: f64,
        timeframe: MarketTimeframe,
        now_unix_ms: i64,
    ) -> TradeApplyOutcome {
        apply_trade_event(
            state,
            trade,
            min_notional_usdt,
            timeframe,
            now_unix_ms,
            Instant::now(),
        )
    }

    #[test]
    fn adjusts_network_latency_with_positive_clock_offset() {
        // raw_local_delta = -600ms, offset = +650ms => adjusted ~= 50ms
        let adjusted = adjusted_network_latency_ms(-600, Some(650));
        assert_eq!(adjusted, 50);
    }

    #[test]
    fn clamps_negative_adjusted_latency_to_zero() {
        let adjusted = adjusted_network_latency_ms(-80, Some(10));
        assert_eq!(adjusted, 0);
    }

    #[test]
    fn computes_signed_time_delta() {
        assert_eq!(signed_time_delta_ms(1_000, 900), 100);
        assert_eq!(signed_time_delta_ms(900, 1_000), -100);
    }

    #[test]
    fn increases_clock_sync_delay_when_link_is_stable() {
        let delay = next_clock_sync_delay_ms(30_000, 90, 10);
        assert_eq!(delay, 60_000);
    }

    #[test]
    fn keeps_clock_sync_delay_tight_when_link_is_noisy() {
        let delay = next_clock_sync_delay_ms(30_000, 400, 120);
        assert_eq!(delay, 30_000);
    }

    #[test]
    fn detects_sequence_gap() {
        let mut state = ConflatedMarketState::default();
        let first = sample_trade(10, 60_000, 100.0, 1.0, false);
        let second = sample_trade(12, 60_100, 101.0, 2.0, true);

        let first_outcome =
            apply_trade_event_for_test(&mut state, &first, 10.0, MarketTimeframe::M1, 2_000);
        assert_eq!(
            first_outcome,
            TradeApplyOutcome::Applied {
                eligible_for_ui: true
            }
        );

        let second_outcome =
            apply_trade_event_for_test(&mut state, &second, 10.0, MarketTimeframe::M1, 2_000);
        assert_eq!(
            second_outcome,
            TradeApplyOutcome::GapDetected {
                expected: 11,
                found: 12
            }
        );
    }

    #[test]
    fn filters_noise_by_notional_without_losing_state() {
        let mut state = ConflatedMarketState::default();
        let trade = sample_trade(1, 60_000, 20.0, 1.0, false);

        let outcome =
            apply_trade_event_for_test(&mut state, &trade, 100.0, MarketTimeframe::M1, 2_000);
        assert_eq!(
            outcome,
            TradeApplyOutcome::Applied {
                eligible_for_ui: false
            }
        );
        assert_eq!(state.last_agg_id, Some(1));
        assert_eq!(state.last_price, Some(20.0));
        assert!(drain_ui_tick(&mut state).is_none());
    }

    #[test]
    fn conflates_volume_and_keeps_latest_price_direction() {
        let mut state = ConflatedMarketState::default();
        let buy_trade = sample_trade(1, 60_000, 100.0, 0.4, false);
        let sell_trade = sample_trade(2, 60_010, 101.0, 0.6, true);

        let _ = apply_trade_event_for_test(&mut state, &buy_trade, 1.0, MarketTimeframe::M1, 2_000);
        let _ =
            apply_trade_event_for_test(&mut state, &sell_trade, 1.0, MarketTimeframe::M1, 2_010);
        let ui_tick = drain_ui_tick(&mut state).expect("tick should exist after eligible trades");

        assert_eq!(ui_tick.p, 101.0);
        assert_eq!(ui_tick.v, 1.0);
        assert_eq!(ui_tick.d, -1);
    }

    #[test]
    fn updates_same_candle_inside_single_bucket() {
        let mut state = ConflatedMarketState::default();
        let first = sample_trade(1, 60_100, 100.0, 0.2, false);
        let second = sample_trade(2, 60_900, 101.0, 0.4, false);

        let _ = apply_trade_event_for_test(&mut state, &first, 1.0, MarketTimeframe::M1, 60_100);
        let _ = apply_trade_event_for_test(&mut state, &second, 1.0, MarketTimeframe::M1, 60_900);

        let candle = drain_ui_candle(&mut state).expect("candle update should be available");
        assert_eq!(candle.t, 60_000);
        assert_eq!(candle.o, 100.0);
        assert_eq!(candle.h, 101.0);
        assert_eq!(candle.l, 100.0);
        assert_eq!(candle.c, 101.0);
        assert!((candle.v - 0.6).abs() < 1e-9);
    }

    #[test]
    fn opens_new_candle_when_bucket_changes() {
        let mut state = ConflatedMarketState::default();
        let first = sample_trade(1, 60_100, 100.0, 0.2, false);
        let second = sample_trade(2, 120_050, 102.0, 0.5, false);

        let _ = apply_trade_event_for_test(&mut state, &first, 1.0, MarketTimeframe::M1, 60_100);
        let _ = apply_trade_event_for_test(&mut state, &second, 1.0, MarketTimeframe::M1, 120_050);

        let candle = drain_ui_candle(&mut state).expect("new candle should be available");
        assert_eq!(candle.t, 120_000);
        assert_eq!(candle.o, 102.0);
        assert_eq!(candle.c, 102.0);
    }

    #[test]
    fn burst_conflation_emits_single_tick_snapshot() {
        let mut state = ConflatedMarketState::default();

        for trade_id in 1..=100 {
            let trade = sample_trade(trade_id, 60_000, 100.0 + trade_id as f64, 0.1, false);
            let _ = apply_trade_event_for_test(&mut state, &trade, 1.0, MarketTimeframe::M1, 3_000);
        }

        let tick = drain_ui_tick(&mut state).expect("single conflated tick should exist");
        assert_eq!(tick.p, 200.0);
        assert!((tick.v - 10.0).abs() < 1e-9);
        assert_eq!(tick.d, 1);
        assert!(drain_ui_tick(&mut state).is_none());
    }

    #[test]
    fn applies_snapshot_without_resetting_existing_candle() {
        let mut state = ConflatedMarketState::default();
        let trade = sample_trade(7, 60_100, 100.0, 1.0, false);
        let _ = apply_trade_event_for_test(&mut state, &trade, 1.0, MarketTimeframe::M1, 60_100);

        apply_snapshot(&mut state, 100, 500.0);
        assert_eq!(state.last_agg_id, Some(100));
        assert_eq!(state.last_price, Some(500.0));
        assert!(state.last_candle.is_some());
    }
}
