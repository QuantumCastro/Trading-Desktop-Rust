use crate::error::AppError;
use crate::market::types::{
    MarketDrawingDeleteArgs, MarketDrawingDeleteResult, MarketDrawingDto, MarketDrawingUpsertArgs,
    MarketDrawingsScopeArgs, MarketKind, MarketPreferencesSnapshot, MarketTimeframe,
    SaveMarketPreferencesArgs, DEFAULT_MARKET_KIND, DEFAULT_SYMBOL, DEFAULT_TIMEFRAME,
};
use sqlx::{Row, SqlitePool};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_unix_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

fn bool_to_sqlite(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn sqlite_to_bool(value: i64) -> bool {
    value != 0
}

fn map_preferences_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<MarketPreferencesSnapshot, AppError> {
    let market_kind_raw: String = row.try_get("market_kind")?;
    let symbol: String = row.try_get("symbol")?;
    let timeframe_raw: String = row.try_get("timeframe")?;
    let magnet_strong_raw: i64 = row.try_get("magnet_strong")?;
    let updated_at_ms: i64 = row.try_get("updated_at_ms")?;

    Ok(MarketPreferencesSnapshot {
        market_kind: MarketKind::parse_str(&market_kind_raw)?,
        symbol,
        timeframe: MarketTimeframe::parse_str(&timeframe_raw)?,
        magnet_strong: sqlite_to_bool(magnet_strong_raw),
        updated_at_ms,
    })
}

fn map_drawing_row(row: &sqlx::sqlite::SqliteRow) -> Result<MarketDrawingDto, AppError> {
    let market_kind_raw: String = row.try_get("market_kind")?;
    let timeframe_raw: String = row.try_get("timeframe")?;

    Ok(MarketDrawingDto {
        id: row.try_get("id")?,
        market_kind: MarketKind::parse_str(&market_kind_raw)?,
        symbol: row.try_get("symbol")?,
        timeframe: MarketTimeframe::parse_str(&timeframe_raw)?,
        drawing_type: row.try_get("drawing_type")?,
        color: row.try_get("color")?,
        label: row.try_get("label")?,
        payload_json: row.try_get("payload_json")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

async fn ensure_market_preferences_seed(pool: &SqlitePool) -> Result<(), AppError> {
    let updated_at_ms = now_unix_ms();
    sqlx::query(
        "INSERT OR IGNORE INTO market_preferences (id, market_kind, symbol, timeframe, magnet_strong, updated_at_ms) VALUES (1, ?, ?, ?, ?, ?)",
    )
    .bind(DEFAULT_MARKET_KIND.as_str())
    .bind(DEFAULT_SYMBOL)
    .bind(DEFAULT_TIMEFRAME.as_str())
    .bind(0_i64)
    .bind(updated_at_ms)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn get_market_preferences(
    pool: &SqlitePool,
) -> Result<MarketPreferencesSnapshot, AppError> {
    ensure_market_preferences_seed(pool).await?;

    let row = sqlx::query(
        "SELECT market_kind, symbol, timeframe, magnet_strong, updated_at_ms FROM market_preferences WHERE id = 1",
    )
    .fetch_one(pool)
    .await?;

    map_preferences_row(&row)
}

pub async fn save_market_preferences(
    pool: &SqlitePool,
    args: SaveMarketPreferencesArgs,
) -> Result<MarketPreferencesSnapshot, AppError> {
    let normalized = args.normalize()?;
    let updated_at_ms = now_unix_ms();

    sqlx::query(
        "INSERT INTO market_preferences (id, market_kind, symbol, timeframe, magnet_strong, updated_at_ms) VALUES (1, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET market_kind=excluded.market_kind, symbol=excluded.symbol, timeframe=excluded.timeframe, magnet_strong=excluded.magnet_strong, updated_at_ms=excluded.updated_at_ms",
    )
    .bind(normalized.market_kind.as_str())
    .bind(normalized.symbol)
    .bind(normalized.timeframe.as_str())
    .bind(bool_to_sqlite(normalized.magnet_strong))
    .bind(updated_at_ms)
    .execute(pool)
    .await?;

    get_market_preferences(pool).await
}

pub async fn list_market_drawings(
    pool: &SqlitePool,
    scope: MarketDrawingsScopeArgs,
) -> Result<Vec<MarketDrawingDto>, AppError> {
    let normalized = scope.normalize()?;
    let rows = sqlx::query(
        "SELECT id, market_kind, symbol, timeframe, drawing_type, color, label, payload_json, created_at_ms, updated_at_ms \
         FROM market_drawings \
         WHERE market_kind = ? AND symbol = ? AND timeframe = ? \
         ORDER BY updated_at_ms ASC, id ASC",
    )
    .bind(normalized.market_kind.as_str())
    .bind(normalized.symbol)
    .bind(normalized.timeframe.as_str())
    .fetch_all(pool)
    .await?;

    let mut drawings = Vec::with_capacity(rows.len());
    for row in rows {
        drawings.push(map_drawing_row(&row)?);
    }

    Ok(drawings)
}

pub async fn upsert_market_drawing(
    pool: &SqlitePool,
    args: MarketDrawingUpsertArgs,
) -> Result<MarketDrawingDto, AppError> {
    let normalized = args.normalize()?;
    let now_ms = now_unix_ms();
    let created_at_ms = normalized.created_at_ms.unwrap_or(now_ms);
    let drawing_id = normalized.id.clone();

    sqlx::query(
        "INSERT INTO market_drawings (id, market_kind, symbol, timeframe, drawing_type, color, label, payload_json, created_at_ms, updated_at_ms) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           market_kind=excluded.market_kind, \
           symbol=excluded.symbol, \
           timeframe=excluded.timeframe, \
           drawing_type=excluded.drawing_type, \
           color=excluded.color, \
           label=excluded.label, \
           payload_json=excluded.payload_json, \
           updated_at_ms=excluded.updated_at_ms",
    )
    .bind(&drawing_id)
    .bind(normalized.market_kind.as_str())
    .bind(normalized.symbol)
    .bind(normalized.timeframe.as_str())
    .bind(normalized.drawing_type)
    .bind(normalized.color)
    .bind(normalized.label)
    .bind(normalized.payload_json)
    .bind(created_at_ms)
    .bind(now_ms)
    .execute(pool)
    .await?;

    let row = sqlx::query(
        "SELECT id, market_kind, symbol, timeframe, drawing_type, color, label, payload_json, created_at_ms, updated_at_ms \
         FROM market_drawings WHERE id = ?",
    )
    .bind(drawing_id)
    .fetch_one(pool)
    .await?;

    map_drawing_row(&row)
}

pub async fn delete_market_drawing(
    pool: &SqlitePool,
    args: MarketDrawingDeleteArgs,
) -> Result<MarketDrawingDeleteResult, AppError> {
    let normalized = args.normalize()?;

    let result = sqlx::query(
        "DELETE FROM market_drawings WHERE id = ? AND market_kind = ? AND symbol = ? AND timeframe = ?",
    )
    .bind(normalized.id)
    .bind(normalized.market_kind.as_str())
    .bind(normalized.symbol)
    .bind(normalized.timeframe.as_str())
    .execute(pool)
    .await?;

    Ok(MarketDrawingDeleteResult {
        deleted: result.rows_affected() > 0,
    })
}
