use crate::error::AppError;
use crate::market::types::{
    AggTradeSnapshot, AggTradeSnapshotWire, KlineWire, MarketTimeframe, UiCandle, UiDeltaCandle,
};
use reqwest::Client;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{connect_async_with_config, MaybeTlsStream, WebSocketStream};

const BINANCE_STREAM_BASE_URL: &str = "wss://stream.binance.com:9443/ws";
const BINANCE_REST_BASE_URL: &str = "https://api.binance.com";
const BINANCE_MAX_KLINES_PER_REQUEST: usize = 1_000;

pub type BinanceWsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn ws_endpoint(symbol: &str) -> String {
    format!(
        "{BINANCE_STREAM_BASE_URL}/{}@aggTrade",
        symbol.to_ascii_lowercase()
    )
}

fn snapshot_endpoint(symbol: &str) -> String {
    format!("{BINANCE_REST_BASE_URL}/api/v3/aggTrades")
        + &format!("?symbol={}&limit=1", symbol.to_ascii_uppercase())
}

fn server_time_endpoint() -> String {
    format!("{BINANCE_REST_BASE_URL}/api/v3/time")
}

fn klines_endpoint(
    symbol: &str,
    timeframe: MarketTimeframe,
    limit: u16,
    end_time: Option<i64>,
) -> String {
    let mut endpoint = format!("{BINANCE_REST_BASE_URL}/api/v3/klines")
        + &format!(
            "?symbol={}&interval={}&limit={limit}",
            symbol.to_ascii_uppercase(),
            timeframe.as_str()
        );
    if let Some(value) = end_time {
        endpoint.push_str(&format!("&endTime={value}"));
    }
    endpoint
}

fn spot_symbols_endpoint() -> String {
    format!("{BINANCE_REST_BASE_URL}/api/v3/exchangeInfo?permissions=SPOT")
}

pub async fn connect_agg_trade_stream(symbol: &str) -> Result<BinanceWsStream, AppError> {
    let ws_config = WebSocketConfig {
        max_message_size: Some(64 << 20),
        max_frame_size: Some(16 << 20),
        ..Default::default()
    };

    let request = ws_endpoint(symbol);
    let (stream, _) = connect_async_with_config(request, Some(ws_config), true).await?;
    Ok(stream)
}

pub async fn fetch_latest_agg_trade_snapshot(
    client: &Client,
    symbol: &str,
) -> Result<AggTradeSnapshot, AppError> {
    let endpoint = snapshot_endpoint(symbol);
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

pub async fn fetch_server_time_ms(client: &Client) -> Result<i64, AppError> {
    let endpoint = server_time_endpoint();
    let response = client.get(endpoint).send().await?.error_for_status()?;
    let payload = response.json::<BinanceServerTimeWire>().await?;
    Ok(payload.server_time)
}

pub async fn fetch_klines_history(
    client: &Client,
    symbol: &str,
    timeframe: MarketTimeframe,
    limit: u16,
) -> Result<Vec<UiCandle>, AppError> {
    let payload = fetch_klines_wire_history(client, symbol, timeframe, limit).await?;

    let mut candles = Vec::with_capacity(payload.len());
    for kline in payload {
        candles.push(kline.try_into()?);
    }
    Ok(candles)
}

pub async fn fetch_klines_delta_history(
    client: &Client,
    symbol: &str,
    timeframe: MarketTimeframe,
    limit: u16,
) -> Result<Vec<UiDeltaCandle>, AppError> {
    let payload = fetch_klines_wire_history(client, symbol, timeframe, limit).await?;

    let mut candles = Vec::with_capacity(payload.len());
    for kline in payload {
        let volume = kline.5.parse::<f64>()?;
        let taker_buy_volume = kline.9.parse::<f64>()?;
        if !volume.is_finite()
            || !taker_buy_volume.is_finite()
            || volume < 0.0
            || taker_buy_volume < 0.0
        {
            return Err(AppError::InvalidArgument(
                "kline volume values must be finite and non-negative".to_string(),
            ));
        }
        let signed_delta = taker_buy_volume - (volume - taker_buy_volume);
        candles.push(UiDeltaCandle {
            t: kline.0,
            o: 0.0,
            h: signed_delta.max(0.0),
            l: signed_delta.min(0.0),
            c: signed_delta,
            v: volume,
        });
    }

    Ok(candles)
}

async fn fetch_klines_wire_history(
    client: &Client,
    symbol: &str,
    timeframe: MarketTimeframe,
    limit: u16,
) -> Result<Vec<KlineWire>, AppError> {
    let target_limit = usize::from(limit);
    let mut remaining = target_limit;
    let mut end_time: Option<i64> = None;
    let mut klines = Vec::with_capacity(target_limit);

    while remaining > 0 {
        let request_limit = remaining.min(BINANCE_MAX_KLINES_PER_REQUEST) as u16;
        let endpoint = klines_endpoint(symbol, timeframe, request_limit, end_time);
        let response = client.get(endpoint).send().await?.error_for_status()?;
        let mut payload = response.json::<Vec<KlineWire>>().await?;
        if payload.is_empty() {
            break;
        }

        let oldest_open_time = payload.first().map(|kline| kline.0).unwrap_or_default();
        remaining = remaining.saturating_sub(payload.len());
        klines.append(&mut payload);

        if oldest_open_time <= 0 {
            break;
        }
        end_time = Some(oldest_open_time - 1);
    }

    klines.sort_unstable_by_key(|kline| kline.0);
    klines.dedup_by_key(|kline| kline.0);

    if klines.len() > target_limit {
        let overflow = klines.len() - target_limit;
        klines.drain(0..overflow);
    }

    Ok(klines)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_endpoint_uses_lowercase_symbol() {
        let endpoint = ws_endpoint("BTCUSDT");
        assert!(endpoint.ends_with("/btcusdt@aggTrade"));
    }

    #[test]
    fn snapshot_endpoint_uses_uppercase_symbol() {
        let endpoint = snapshot_endpoint("btcusdt");
        assert!(endpoint.contains("symbol=BTCUSDT"));
        assert!(endpoint.contains("limit=1"));
    }

    #[test]
    fn server_time_endpoint_is_correct() {
        let endpoint = server_time_endpoint();
        assert!(endpoint.ends_with("/api/v3/time"));
    }

    #[test]
    fn klines_endpoint_uses_timeframe_and_limit() {
        let endpoint = klines_endpoint("btcusdt", MarketTimeframe::W1, 300, None);
        assert!(endpoint.contains("symbol=BTCUSDT"));
        assert!(endpoint.contains("interval=1w"));
        assert!(endpoint.contains("limit=300"));
    }

    #[test]
    fn klines_endpoint_includes_end_time_when_present() {
        let endpoint = klines_endpoint(
            "btcusdt",
            MarketTimeframe::M1,
            1000,
            Some(1_735_000_000_000),
        );
        assert!(endpoint.contains("endTime=1735000000000"));
    }

    #[test]
    fn spot_symbols_endpoint_requests_spot_permissions() {
        let endpoint = spot_symbols_endpoint();
        assert!(endpoint.contains("/api/v3/exchangeInfo"));
        assert!(endpoint.contains("permissions=SPOT"));
    }
}
