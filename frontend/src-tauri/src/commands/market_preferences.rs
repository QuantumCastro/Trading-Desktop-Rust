use crate::error::AppError;
use crate::market::persistence::{
    delete_market_drawing, get_market_preferences, list_market_drawings, save_market_preferences,
    upsert_market_drawing,
};
use crate::market::types::{
    MarketDrawingDeleteArgs, MarketDrawingDeleteResult, MarketDrawingDto, MarketDrawingUpsertArgs,
    MarketDrawingsScopeArgs, MarketPreferencesSnapshot, SaveMarketPreferencesArgs,
};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn market_preferences_get(
    state: State<'_, AppState>,
) -> Result<MarketPreferencesSnapshot, AppError> {
    get_market_preferences(&state.db_pool).await
}

#[tauri::command]
pub async fn market_preferences_save(
    state: State<'_, AppState>,
    args: SaveMarketPreferencesArgs,
) -> Result<MarketPreferencesSnapshot, AppError> {
    save_market_preferences(&state.db_pool, args).await
}

#[tauri::command]
pub async fn market_drawings_list(
    state: State<'_, AppState>,
    args: MarketDrawingsScopeArgs,
) -> Result<Vec<MarketDrawingDto>, AppError> {
    list_market_drawings(&state.db_pool, args).await
}

#[tauri::command]
pub async fn market_drawing_upsert(
    state: State<'_, AppState>,
    args: MarketDrawingUpsertArgs,
) -> Result<MarketDrawingDto, AppError> {
    upsert_market_drawing(&state.db_pool, args).await
}

#[tauri::command]
pub async fn market_drawing_delete(
    state: State<'_, AppState>,
    args: MarketDrawingDeleteArgs,
) -> Result<MarketDrawingDeleteResult, AppError> {
    delete_market_drawing(&state.db_pool, args).await
}
