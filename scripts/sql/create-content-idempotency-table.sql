CREATE TABLE IF NOT EXISTS content_idempotency (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  endpoint VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  status ENUM('processing','completed') NOT NULL DEFAULT 'processing',
  response_status INT NULL,
  response_body JSON NULL,
  resource_id VARCHAR(128) NULL,
  expires_at DATETIME NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_content_idempotency_user_endpoint_key (user_id, endpoint, idempotency_key),
  KEY idx_content_idempotency_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
