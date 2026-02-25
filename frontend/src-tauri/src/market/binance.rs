use crate::error::AppError;
use crate::market::types::{
    AggTradeSnapshot, AggTradeSnapshotWire, KlineWire, MarketKind, MarketTimeframe, UiCandle,
    UiDeltaCandle,
};
use reqwest::Client;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{connect_async_with_config, MaybeTlsStream, WebSocketStream};

const BINANCE_SPOT_STREAM_BASE_URL: &str = "wss://stream.binance.com:9443/ws";
const BINANCE_SPOT_REST_BASE_URL: &str = "https://api.binance.com";
const BINANCE_FUTURES_USDM_STREAM_BASE_URL: &str = "wss://fstream.binance.com/ws";
const BINANCE_FUTURES_USDM_REST_BASE_URL: &str = "https://fapi.binance.com";
const BINANCE_MAX_KLINES_PER_REQUEST: usize = 1_000;

pub type BinanceWsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn stream_base_url(market_kind: MarketKind) -> &'static str {
    match market_kind {
        MarketKind::Spot => BINANCE_SPOT_STREAM_BASE_URL,
        MarketKind::FuturesUsdm => BINANCE_FUTURES_USDM_STREAM_BASE_URL,
    }
}

fn rest_base_url(market_kind: MarketKind) -> &'static str {
    match market_kind {
        MarketKind::Spot => BINANCE_SPOT_REST_BASE_URL,
        MarketKind::FuturesUsdm => BINANCE_FUTURES_USDM_REST_BASE_URL,
    }
}

fn ws_endpoint(market_kind: MarketKind, symbol: &str) -> String {
    format!(
        "{}/{}@aggTrade",
        stream_base_url(market_kind),
        symbol.to_ascii_lowercase()
    )
}

fn snapshot_endpoint(market_kind: MarketKind, symbol: &str) -> String {
    let path = match market_kind {
        MarketKind::Spot => "/api/v3/aggTrades",
        MarketKind::FuturesUsdm => "/fapi/v1/aggTrades",
    };

    format!(
        "{}{path}?symbol={}&limit=1",
        rest_base_url(market_kind),
        symbol.to_ascii_uppercase()
    )
}

fn server_time_endpoint(market_kind: MarketKind) -> String {
    let path = match market_kind {
        MarketKind::Spot => "/api/v3/time",
        MarketKind::FuturesUsdm => "/fapi/v1/time",
    };
    format!("{}{path}", rest_base_url(market_kind))
}

fn klines_endpoint(
    market_kind: MarketKind,
    symbol: &str,
    timeframe: MarketTimeframe,
    limit: u16,
    end_time: Option<i64>,
) -> String {
    let path = match market_kind {
        MarketKind::Spot => "/api/v3/klines",
        MarketKind::FuturesUsdm => "/fapi/v1/klines",
    };

    let mut endpoint = format!(
        "{}{path}?symbol={}&interval={}&limit={limit}",
        rest_base_url(market_kind),
        symbol.to_ascii_uppercase(),
        timeframe.as_str()
    );
    if let Some(value) = end_time {
        endpoint.push_str(&format!("&endTime={value}"));
    }
    endpoint
}

fn spot_symbols_endpoint() -> String {
    format!(
        "{}/api/v3/exchangeInfo?permissions=SPOT",
        BINANCE_SPOT_REST_BASE_URL
    )
}

fn futures_usdm_symbols_endpoint() -> String {
    format!(
        "{}/fapi/v1/exchangeInfo",
        BINANCE_FUTURES_USDM_REST_BASE_URL
    )
}

pub async fn connect_agg_trade_stream(
    market_kind: MarketKind,
    symbol: &str,
) -> Result<BinanceWsStream, AppError> {
    let ws_config = WebSocketConfig {
        max_message_size: Some(64 << 20),
        max_frame_size: Some(16 << 20),
        ..Default::default()
    };

    let request = ws_endpoint(market_kind, symbol);
    let (stream, _) = connect_async_with_config(request, Some(ws_config), true).await?;
    Ok(stream)
}

pub async fn fetch_latest_agg_trade_snapshot(
    client: &Client,
    market_kind: MarketKind,
    symbol: &str,
) -> Result<AggTradeSnapshot, AppError> {
    let endpoint = snapshot_endpoint(market_kind, symbol);
    let response = client.get(endpoint).send().await?.error_for_status()?;
    let payload = response.json::<Vec<AggTradeSnapshotWire>>().await?;
    let latest = payload
        .into_iter()
        .next()
        .ok_or_else(|| AppError::InvalidArgument("empty aggTrades snapshot payload".to_string()))?;
    latest.try_into()
}

#[derive(Debug, Deserialize)]
struct BinanceServerTimeWire {
    #[serde(rename = "serverTime")]
    server_time: i64,
}

pub async fn fetch_server_time_ms(
    client: &Client,
    market_kind: MarketKind,
) -> Result<i64, AppError> {
    let endpoint = server_time_endpoint(market_kind);
    let response = client.get(endpoint).send().await?.error_for_status()?;
    let payload = response.json::<BinanceServerTimeWire>().await?;
    Ok(payload.server_time)
}

#[derive(Debug, Clone, Copy)]
pub struct KlineHistoryProgress {
    pub pages_fetched: u32,
    pub candles_fetched: u64,
    pub estimated_total_candles: Option<u64>,
    pub progress_pct: Option<f64>,
    pub done: bool,
}

pub async fn fetch_klines_history_bundle(
    client: &Client,
    market_kind: MarketKind,
    symbol: &str,
    timeframe: MarketTimeframe,
    limit: u32,
    history_all: bool,
) -> Result<(Vec<UiCandle>, Vec<UiDeltaCandle>), AppError> {
    fetch_klines_history_bundle_with_progress(
        client,
        market_kind,
        symbol,
        timeframe,
        limit,
        history_all,
        |_| Ok(()),
    )
    .await
}

pub async fn fetch_klines_history_bundle_with_progress<F>(
    client: &Client,
    market_kind: MarketKind,
    symbol: &str,
    timeframe: MarketTimeframe,
    limit: u32,
    history_all: bool,
    mut on_progress: F,
) -> Result<(Vec<UiCandle>, Vec<UiDeltaCandle>), AppError>
where
    F: FnMut(KlineHistoryProgress) -> Result<(), AppError>,
{
    if !history_all && limit == 0 {
        return Ok((Vec::new(), Vec::new()));
    }

    let target_limit = if history_all {
        None
    } else {
        Some(limit as usize)
    };

    let mut candles_rev = target_limit.map_or_else(Vec::new, Vec::with_capacity);
    let mut delta_candles_rev = target_limit.map_or_else(Vec::new, Vec::with_capacity);
    let mut end_time: Option<i64> = None;
    let mut previous_oldest_open_time: Option<i64> = None;
    let timeframe_ms = timeframe.duration_ms().max(1);
    let mut pages_fetched: u32 = 0;
    let oldest_open_time_known = if history_all {
        fetch_oldest_kline_open_time(client, market_kind, symbol, timeframe).await?
    } else {
        None
    };
    let mut newest_open_time_seen: Option<i64> = None;

    loop {
        let request_limit = target_limit
            .map(|target| {
                let remaining = target.saturating_sub(candles_rev.len());
                remaining.min(BINANCE_MAX_KLINES_PER_REQUEST)
            })
            .unwrap_or(BINANCE_MAX_KLINES_PER_REQUEST);

        if request_limit == 0 {
            break;
        }

        let endpoint = klines_endpoint(
            market_kind,
            symbol,
            timeframe,
            request_limit as u16,
            end_time,
        );
        let response = client.get(endpoint).send().await?.error_for_status()?;
        let page = response.json::<Vec<KlineWire>>().await?;
        if page.is_empty() {
            break;
        }

        let oldest_open_time = page[0].0;
        if newest_open_time_seen.is_none() {
            newest_open_time_seen = page.last().map(|entry| entry.0);
        }
        let received = page.len();
        pages_fetched = pages_fetched.saturating_add(1);
        for kline in page.into_iter().rev() {
            let (candle, delta_candle) = kline_to_domain_pair(kline)?;
            candles_rev.push(candle);
            delta_candles_rev.push(delta_candle);
        }

        if history_all {
            let progress = compute_history_progress(
                pages_fetched,
                candles_rev.len() as u64,
                oldest_open_time_known,
                newest_open_time_seen,
                oldest_open_time,
                timeframe_ms,
                false,
            );
            on_progress(progress)?;
        }

        if let Some(target) = target_limit {
            if candles_rev.len() >= target {
                break;
            }
        }

        if received < request_limit {
            break;
        }
        if let Some(previous_oldest) = previous_oldest_open_time {
            if oldest_open_time >= previous_oldest {
                break;
            }
        }
        if oldest_open_time <= 0 {
            break;
        }

        previous_oldest_open_time = Some(oldest_open_time);
        end_time = Some(oldest_open_time - 1);
    }

    if let Some(target) = target_limit {
        if candles_rev.len() > target {
            candles_rev.truncate(target);
        }
        if delta_candles_rev.len() > target {
            delta_candles_rev.truncate(target);
        }
    }

    if history_all {
        let done_progress = compute_history_progress(
            pages_fetched,
            candles_rev.len() as u64,
            oldest_open_time_known,
            newest_open_time_seen,
            oldest_open_time_known.unwrap_or_default(),
            timeframe_ms,
            true,
        );
        on_progress(done_progress)?;
    }

    candles_rev.reverse();
    delta_candles_rev.reverse();

    Ok((candles_rev, delta_candles_rev))
}

fn compute_history_progress(
    pages_fetched: u32,
    candles_fetched: u64,
    oldest_known: Option<i64>,
    newest_seen: Option<i64>,
    oldest_fetched: i64,
    timeframe_ms: i64,
    done: bool,
) -> KlineHistoryProgress {
    let estimated_total_candles = oldest_known.and_then(|oldest| {
        newest_seen.and_then(|newest| {
            if newest < oldest {
                return None;
            }
            let total = ((newest - oldest) / timeframe_ms) + 1;
            u64::try_from(total).ok()
        })
    });

    let progress_pct = if done {
        Some(100.0)
    } else if let (Some(oldest), Some(newest)) = (oldest_known, newest_seen) {
        if newest < oldest {
            None
        } else {
            let total_span = (newest - oldest + timeframe_ms).max(1);
            let covered_span = (newest - oldest_fetched + timeframe_ms).max(0);
            let pct = (covered_span as f64 / total_span as f64) * 100.0;
            Some(pct.clamp(0.0, 99.9))
        }
    } else {
        None
    };

    KlineHistoryProgress {
        pages_fetched,
        candles_fetched,
        estimated_total_candles,
        progress_pct,
        done,
    }
}

async fn fetch_oldest_kline_open_time(
    client: &Client,
    market_kind: MarketKind,
    symbol: &str,
    timeframe: MarketTimeframe,
) -> Result<Option<i64>, AppError> {
    let mut endpoint = klines_endpoint(market_kind, symbol, timeframe, 1, None);
    endpoint.push_str("&startTime=0");

    let response = client.get(endpoint).send().await?.error_for_status()?;
    let payload = response.json::<Vec<KlineWire>>().await?;
    Ok(payload.first().map(|kline| kline.0))
}

fn kline_to_domain_pair(kline: KlineWire) -> Result<(UiCandle, UiDeltaCandle), AppError> {
    let open = kline.1.parse::<f64>()?;
    let high = kline.2.parse::<f64>()?;
    let low = kline.3.parse::<f64>()?;
    let close = kline.4.parse::<f64>()?;
    let volume = kline.5.parse::<f64>()?;
    let taker_buy_volume = kline.9.parse::<f64>()?;

    if !open.is_finite()
        || !high.is_finite()
        || !low.is_finite()
        || !close.is_finite()
        || !volume.is_finite()
        || !taker_buy_volume.is_finite()
        || volume < 0.0
        || taker_buy_volume < 0.0
    {
        return Err(AppError::InvalidArgument(
            "kline values must be finite and volume non-negative".to_string(),
        ));
    }

    let candle = UiCandle {
        t: kline.0,
        o: open,
        h: high,
        l: low,
        c: close,
        v: volume,
    };
    let signed_delta = taker_buy_volume - (volume - taker_buy_volume);
    let delta_candle = UiDeltaCandle {
        t: kline.0,
        o: 0.0,
        h: signed_delta.max(0.0),
        l: signed_delta.min(0.0),
        c: signed_delta,
        v: volume,
    };
    Ok((candle, delta_candle))
}

#[derive(Debug, Deserialize)]
struct BinanceExchangeInfoWire {
    symbols: Vec<BinanceExchangeSymbolWire>,
}

#[derive(Debug, Deserialize)]
struct BinanceExchangeSymbolWire {
    symbol: String,
    status: String,
    #[serde(rename = "isSpotTradingAllowed")]
    is_spot_trading_allowed: bool,
}

#[derive(Debug, Deserialize)]
struct BinanceFuturesExchangeInfoWire {
    symbols: Vec<BinanceFuturesSymbolWire>,
}

#[derive(Debug, Deserialize)]
struct BinanceFuturesSymbolWire {
    symbol: String,
    status: String,
    #[serde(rename = "contractType")]
    contract_type: String,
}

pub async fn fetch_market_symbols(
    client: &Client,
    market_kind: MarketKind,
) -> Result<Vec<String>, AppError> {
    match market_kind {
        MarketKind::Spot => fetch_spot_symbols(client).await,
        MarketKind::FuturesUsdm => fetch_futures_usdm_symbols(client).await,
    }
}

pub async fn fetch_spot_symbols(client: &Client) -> Result<Vec<String>, AppError> {
    let endpoint = spot_symbols_endpoint();
    let response = client.get(endpoint).send().await?.error_for_status()?;
    let payload = response.json::<BinanceExchangeInfoWire>().await?;

    let mut symbols: Vec<String> = payload
        .symbols
        .into_iter()
        .filter(|entry| {
            entry.is_spot_trading_allowed && entry.status.eq_ignore_ascii_case("TRADING")
        })
        .map(|entry| entry.symbol)
        .collect();

    symbols.sort_unstable();
    symbols.dedup();
    Ok(symbols)
}

pub async fn fetch_futures_usdm_symbols(client: &Client) -> Result<Vec<String>, AppError> {
    let endpoint = futures_usdm_symbols_endpoint();
    let response = client.get(endpoint).send().await?.error_for_status()?;
    let payload = response.json::<BinanceFuturesExchangeInfoWire>().await?;

    let mut symbols: Vec<String> = payload
        .symbols
        .into_iter()
        .filter(|entry| {
            entry.status.eq_ignore_ascii_case("TRADING")
                && entry.contract_type.eq_ignore_ascii_case("PERPETUAL")
        })
        .map(|entry| entry.symbol)
        .collect();

    symbols.sort_unstable();
    symbols.dedup();
    Ok(symbols)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_endpoint_uses_lowercase_symbol() {
        let endpoint = ws_endpoint(MarketKind::Spot, "BTCUSDT");
        assert!(endpoint.ends_with("/btcusdt@aggTrade"));

        let futures_endpoint = ws_endpoint(MarketKind::FuturesUsdm, "BTCUSDT");
        assert!(futures_endpoint.contains("fstream.binance.com"));
        assert!(futures_endpoint.ends_with("/btcusdt@aggTrade"));
    }

    #[test]
    fn snapshot_endpoint_uses_uppercase_symbol() {
        let endpoint = snapshot_endpoint(MarketKind::Spot, "btcusdt");
        assert!(endpoint.contains("symbol=BTCUSDT"));
        assert!(endpoint.contains("limit=1"));
        assert!(endpoint.contains("/api/v3/aggTrades"));

        let futures_endpoint = snapshot_endpoint(MarketKind::FuturesUsdm, "btcusdt");
        assert!(futures_endpoint.contains("/fapi/v1/aggTrades"));
    }

    #[test]
    fn server_time_endpoint_is_correct() {
        let endpoint = server_time_endpoint(MarketKind::Spot);
        assert!(endpoint.ends_with("/api/v3/time"));

        let futures_endpoint = server_time_endpoint(MarketKind::FuturesUsdm);
        assert!(futures_endpoint.ends_with("/fapi/v1/time"));
    }

    #[test]
    fn klines_endpoint_uses_timeframe_and_limit() {
        let endpoint = klines_endpoint(MarketKind::Spot, "btcusdt", MarketTimeframe::W1, 300, None);
        assert!(endpoint.contains("symbol=BTCUSDT"));
        assert!(endpoint.contains("interval=1w"));
        assert!(endpoint.contains("limit=300"));
        assert!(endpoint.contains("/api/v3/klines"));

        let futures_endpoint = klines_endpoint(
            MarketKind::FuturesUsdm,
            "btcusdt",
            MarketTimeframe::W1,
            300,
            None,
        );
        assert!(futures_endpoint.contains("/fapi/v1/klines"));
    }

    #[test]
    fn klines_endpoint_includes_end_time_when_present() {
        let endpoint = klines_endpoint(
            MarketKind::Spot,
            "btcusdt",
            MarketTimeframe::M1,
            1000,
            Some(1_735_000_000_000),
        );
        assert!(endpoint.contains("endTime=1735000000000"));
    }

    #[test]
    fn symbols_endpoints_are_correct() {
        let endpoint = spot_symbols_endpoint();
        assert!(endpoint.contains("/api/v3/exchangeInfo"));
        assert!(endpoint.contains("permissions=SPOT"));

        let futures_endpoint = futures_usdm_symbols_endpoint();
        assert!(futures_endpoint.ends_with("/fapi/v1/exchangeInfo"));
    }
}
