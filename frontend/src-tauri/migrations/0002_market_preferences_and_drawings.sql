CREATE TABLE IF NOT EXISTS market_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('spot', 'futures_usdm')),
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('1m', '5m', '1h', '4h', '1d', '1w', '1M')),
  magnet_strong INTEGER NOT NULL CHECK (magnet_strong IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO market_preferences (id, market_kind, symbol, timeframe, magnet_strong, updated_at_ms)
VALUES (1, 'spot', 'BTCUSDT', '1m', 0, 0);

CREATE TABLE IF NOT EXISTS market_drawings (
  id TEXT PRIMARY KEY,
  market_kind TEXT NOT NULL CHECK (market_kind IN ('spot', 'futures_usdm')),
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('1m', '5m', '1h', '4h', '1d', '1w', '1M')),
  drawing_type TEXT NOT NULL CHECK (drawing_type IN ('trendLine', 'horizontalLine', 'ruler', 'fibRetracement', 'fibExtension')),
  color TEXT NOT NULL,
  label TEXT,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_drawings_scope
  ON market_drawings (market_kind, symbol, timeframe, updated_at_ms);
