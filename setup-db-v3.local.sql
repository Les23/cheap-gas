-- CheapGas v3 tables: price reports + price history
-- Run ONCE on the VPS MariaDB (same as before: Navicat -> File -> Open
-- External File -> this file -> Ctrl+A -> Run). Safe to re-run.

USE cheapgas;

-- User-submitted price corrections (last report per station+fuel wins)
CREATE TABLE IF NOT EXISTS price_reports (
  station_id VARCHAR(100) NOT NULL,
  fuel VARCHAR(10) NOT NULL,
  cents DECIMAL(6,1) NOT NULL,
  user_id CHAR(36) NOT NULL,
  reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (station_id, fuel),
  CONSTRAINT fk_report_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Daily area price summaries, recorded automatically by the server
-- (area = lat/lng rounded to ~11 km). Powers history charts and savings math.
CREATE TABLE IF NOT EXISTS price_history (
  area CHAR(14) NOT NULL,
  d CHAR(10) NOT NULL,
  fuel VARCHAR(10) NOT NULL,
  cheap DECIMAL(6,1) NOT NULL,
  avg DECIMAL(6,1) NOT NULL,
  PRIMARY KEY (area, d, fuel)
) ENGINE=InnoDB;

SELECT 'v3 tables ready' AS status;
