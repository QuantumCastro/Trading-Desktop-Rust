use crate::error::AppError;
use crate::market::binance::{fetch_market_symbols, fetch_spot_symbols};
use crate::market::pipeline::run_market_stream;
use crate::market::types::{
    MarketConnectionState, MarketStreamSession, MarketStreamStatusSnapshot, MarketStreamStopResult,
    MarketSymbolsArgs, StartMarketStreamArgs,
};
use crate::state::{AppState, MarketStreamHandle};
use reqwest::Client;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio_util::sync::CancellationToken;

#[tauri::command]
pub async fn start_market_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    args: Option<StartMarketStreamArgs>,
) -> Result<MarketStreamSession, AppError> {
    let config = args.unwrap_or_default().normalize()?;

    let existing_handle = {
        let mut stream_slot = state.market_stream.lock().await;
        stream_slot.take()
    };
    if let Some(handle) = existing_handle {
        handle.cancellation_token.cancel();
        let _ = handle.join_handle.await;
    }

    let cancellation_token = CancellationToken::new();
    let task_token = cancellation_token.clone();
    let status_store = Arc::clone(&state.market_status);
    let runtime_config = config.clone();
    let app_handle = app.clone();

    let join_handle = tauri::async_runtime::spawn(async move {
        run_market_stream(app_handle, runtime_config, status_store, task_token).await;
    });

    {
        let mut stream_slot = state.market_stream.lock().await;
        *stream_slot = Some(MarketStreamHandle {
            cancellation_token,
            join_handle,
        });
    }

    Ok(MarketStreamSession::from_config(&config))
}

#[tauri::command]
pub async fn stop_market_stream(
    state: State<'_, AppState>,
) -> Result<MarketStreamStopResult, AppError> {
    let existing_handle = {
        let mut stream_slot = state.market_stream.lock().await;
        stream_slot.take()
    };

    let stopped = if let Some(handle) = existing_handle {
        handle.cancellation_token.cancel();
        let _ = handle.join_handle.await;
        true
    } else {
        false
    };

    {
        let (current_market_kind, current_symbol, current_timeframe) = {
            let readable = state.market_status.read().await;
            (
                readable.market_kind,
                readable.symbol.clone(),
                readable.timeframe,
            )
        };
        let mut writable = state.market_status.write().await;
        *writable = MarketStreamStatusSnapshot {
            state: MarketConnectionState::Stopped,
            market_kind: current_market_kind,
            symbol: current_symbol,
            timeframe: current_timeframe,
            last_agg_id: None,
            latency_ms: None,
            raw_exchange_latency_ms: None,
            clock_offset_ms: None,
            adjusted_network_latency_ms: None,
            local_pipeline_latency_ms: None,
            reason: Some("stream stopped by command".to_string()),
        };
    }

    Ok(MarketStreamStopResult { stopped })
}

#[tauri::command]
pub async fn market_stream_status(
    state: State<'_, AppState>,
) -> Result<MarketStreamStatusSnapshot, AppError> {
    let snapshot = state.market_status.read().await.clone();
    Ok(snapshot)
}

#[tauri::command]
pub async fn market_symbols(args: MarketSymbolsArgs) -> Result<Vec<String>, AppError> {
    let client = Client::new();
    fetch_market_symbols(&client, args.market_kind).await
}

#[tauri::command]
pub async fn market_spot_symbols() -> Result<Vec<String>, AppError> {
    let client = Client::new();
    fetch_spot_symbols(&client).await
}
