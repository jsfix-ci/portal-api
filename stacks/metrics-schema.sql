CREATE TABLE IF NOT EXISTS relay (
  applicationPublicKey String,
  nodePublicKey String,
  method String,
  result String,
  blockchain String,
  host String,
  region String,
  bytes Float,
  elapsedTime Float,
  timestamp Datetime
) PRIMARY KEY (applicationPublicKey, timestamp);
CREATE TABLE IF NOT EXISTS origin (
  applicationPublicKey String,
  origin String timestamp Datetime
) PRIMARY KEY (applicationPublicKey, timestamp);