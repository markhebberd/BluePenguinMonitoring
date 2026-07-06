-- Set-password links: invite emails for new users and forgot-password resets.
-- Tokens are stored hashed (sha256); the raw token only ever lives in the emailed link.
CREATE TABLE IF NOT EXISTS password_resets (
    token_hash CHAR(64) PRIMARY KEY,
    observer_id INT NOT NULL,
    purpose VARCHAR(10) NOT NULL DEFAULT 'reset', -- 'invite' | 'reset'
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (observer_id) REFERENCES observers(observer_id)
);
