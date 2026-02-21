mod commands;
mod db;
mod error;
mod market;
mod state;

use commands::{
    app_info::app_info,
    health::health,
    market_preferences::{
        market_drawing_delete, market_drawing_upsert, market_drawings_list, market_preferences_get,
        market_preferences_save,
    },
    market_stream::{
        market_spot_symbols, market_stream_status, market_symbols, start_market_stream,
        stop_market_stream,
    },
};
use db::initialize_pool;
use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_websocket::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let db_pool =
                tauri::async_runtime::block_on(async move { initialize_pool(&app_handle).await })?;
            app.manage(AppState::new(db_pool));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            app_info,
            start_market_stream,
            stop_market_stream,
            market_stream_status,
            market_symbols,
            market_spot_symbols,
            market_preferences_get,
            market_preferences_save,
            market_drawings_list,
            market_drawing_upsert,
            market_drawing_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
