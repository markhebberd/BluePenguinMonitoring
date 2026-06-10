-- Add soft-delete columns to penguin_scans (matching observations convention)
ALTER TABLE penguin_scans
    ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE AFTER accuracy,
    ADD COLUMN deleted_at TIMESTAMP NULL AFTER is_deleted,
    ADD COLUMN deleted_by INT AFTER deleted_at,
    ADD FOREIGN KEY (deleted_by) REFERENCES observers(observer_id),
    ADD INDEX idx_deleted (is_deleted);

-- Remove ON DELETE CASCADE
ALTER TABLE penguin_scans DROP FOREIGN KEY penguin_scans_ibfk_1;
ALTER TABLE penguin_scans ADD CONSTRAINT penguin_scans_ibfk_1 FOREIGN KEY (observation_id) REFERENCES observations(observation_id);

-- Add soft-delete columns to penguin_biometric_data (matching observations convention)
ALTER TABLE penguin_biometric_data
    ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE AFTER notes,
    ADD COLUMN deleted_at TIMESTAMP NULL AFTER is_deleted,
    ADD COLUMN deleted_by INT AFTER deleted_at,
    ADD FOREIGN KEY (deleted_by) REFERENCES observers(observer_id);

-- Remove ON DELETE SET NULL
ALTER TABLE penguin_biometric_data DROP FOREIGN KEY penguin_biometric_data_ibfk_2;
ALTER TABLE penguin_biometric_data ADD CONSTRAINT penguin_biometric_data_ibfk_2 FOREIGN KEY (observation_id) REFERENCES observations(observation_id);
