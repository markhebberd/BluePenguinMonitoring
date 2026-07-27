-- PenguinMonitor Database Schema Migration
-- Based on Proposed_DB_Schema.md

-- People with a login. Every other table's observer_id / deleted_by / reviewed_by column is
-- an FK to users.id — those column names were left alone when the table was renamed, so the
-- API keeps publishing observer_id / observer_name and installed nestcheck builds keep working.
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    f_name VARCHAR(100) NOT NULL,
    -- NOT NULL (blank is '') so the UNIQUE pair below bites for two people who share a first
    -- name and have no surname recorded — SQL would treat two NULLs as distinct.
    surname VARCHAR(100) NOT NULL DEFAULT '',
    falcon_id VARCHAR(64),          -- identifier for this person in Falcon; free-form, not validated here
    -- The initials a chipping is signed with (penguin_chips.chip_by): 'BS', 'AL'. UNIQUE so an
    -- acronym identifies one person, NULLable because most users never chip.
    chip_acronym VARCHAR(10),
    active BOOLEAN NOT NULL DEFAULT TRUE,  -- deactivated accounts are kept, not deleted (they own observations)
    -- NULL when the person has no email (field volunteers often don't, and login is by email
    -- so they simply can't use one). NULLs are distinct under UNIQUE, which is what allows any
    -- number of them while still rejecting a genuinely duplicated address.
    email VARCHAR(255),
    passphrase_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_name (f_name, surname),
    UNIQUE KEY uniq_user_email (email),
    UNIQUE KEY uniq_user_chip_acronym (chip_acronym)
);

CREATE TABLE IF NOT EXISTS regions (
    region_id INT AUTO_INCREMENT PRIMARY KEY,
    region_name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS colonies (
    colony_id INT AUTO_INCREMENT PRIMARY KEY,
    region_id INT NOT NULL,
    colony_name VARCHAR(100) NOT NULL,
    location_sets_string TEXT,
    fm_excluded_boxes VARCHAR(255) NOT NULL DEFAULT '0,AA,AB,AC', -- locations excluded from Full Monitor detection
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (region_id, colony_name),
    FOREIGN KEY (region_id) REFERENCES regions(region_id)
);

CREATE TABLE IF NOT EXISTS colony_permissions (
    permission_id INT AUTO_INCREMENT PRIMARY KEY,
    colony_id INT NOT NULL,
    observer_id INT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'view',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (colony_id, observer_id),
    FOREIGN KEY (colony_id) REFERENCES colonies(colony_id),
    FOREIGN KEY (observer_id) REFERENCES users(id),
    INDEX idx_observer (observer_id)
);

CREATE TABLE IF NOT EXISTS observation_locations (
    location_id INT AUTO_INCREMENT PRIMARY KEY,
    colony_id INT NOT NULL,
    location_name VARCHAR(50) NOT NULL,
    location_type VARCHAR(20) DEFAULT 'box',
    persistent_notes TEXT,
    watched TINYINT(1) NOT NULL DEFAULT 0,
    rfid_tag_number VARCHAR(50),
    rfid_scan_time_utc DATETIME,
    rfid_latitude DOUBLE,
    rfid_longitude DOUBLE,
    rfid_accuracy FLOAT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (colony_id, location_name),
    UNIQUE KEY (colony_id, rfid_tag_number),
    FOREIGN KEY (colony_id) REFERENCES colonies(colony_id),
    INDEX idx_location_type (location_type)
);

CREATE TABLE IF NOT EXISTS observations (
    observation_id INT AUTO_INCREMENT PRIMARY KEY,
    location_id INT NOT NULL,
    observer_id INT NOT NULL,
    observation_time_utc DATETIME NOT NULL,
    adults INT DEFAULT 0,
    eggs INT DEFAULT 0,
    chicks INT DEFAULT 0,
    no_scan INT DEFAULT 0,
    breeding_status VARCHAR(50),
    gate_status VARCHAR(50),
    notes TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    deletion_reason TEXT,
    deleted_at TIMESTAMP NULL,
    deleted_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (location_id) REFERENCES observation_locations(location_id),
    FOREIGN KEY (observer_id) REFERENCES users(id),
    FOREIGN KEY (deleted_by) REFERENCES users(id),
    INDEX idx_obs_time (observation_time_utc),
    INDEX idx_loc_time (location_id, observation_time_utc),
    INDEX idx_observer (observer_id),
    INDEX idx_deleted (is_deleted)
);

-- One free-text note per colony per monitoring day — what the day's work was, in a person's
-- words ("Full monitor with Mark"). note_date is an NZ calendar date and is deliberately not
-- an FK: a note can outlive, or precede, the observations it describes.
-- Authorship and edit history live in audit_log (see migrations/2026-07-24c-day-notes.sql).
CREATE TABLE IF NOT EXISTS day_notes (
    day_note_id INT AUTO_INCREMENT PRIMARY KEY,
    colony_id   INT NOT NULL,
    note_date   DATE NOT NULL,
    note        VARCHAR(255) NULL,        -- what happened that day
    observer_id INT NULL,                 -- who was looking in the boxes
    recorder_id INT NULL,                 -- who was working the phone
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_colony_date (colony_id, note_date),
    KEY idx_note_date (note_date),
    -- An all-blank row is deleted instead (crud.php save_day_note), so "nothing recorded for
    -- this day" has exactly one representation.
    CONSTRAINT chk_dn_any CHECK (
          CHAR_LENGTH(TRIM(COALESCE(note, ''))) > 0
       OR observer_id IS NOT NULL
       OR recorder_id IS NOT NULL),
    CONSTRAINT fk_dn_colony FOREIGN KEY (colony_id) REFERENCES colonies (colony_id),
    CONSTRAINT fk_dn_observer FOREIGN KEY (observer_id) REFERENCES users (id),
    CONSTRAINT fk_dn_recorder FOREIGN KEY (recorder_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS penguins (
    penguin_id INT AUTO_INCREMENT PRIMARY KEY,
    penguin_number VARCHAR(20),
    tag_number VARCHAR(17) UNIQUE,
    initial_chip_date DATE,
    chip_date DATE,
    chipped_as_adult BOOLEAN DEFAULT FALSE,
    sex VARCHAR(10),
    death_date DATETIME NULL, -- 2pm NZ (02:00 UTC) on the death date; NULL = alive
    is_dead BOOLEAN GENERATED ALWAYS AS (death_date IS NOT NULL) STORED,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS penguin_chips (
    chip_id INT AUTO_INCREMENT PRIMARY KEY,
    penguin_id INT NOT NULL,
    chip_number VARCHAR(17) NOT NULL UNIQUE,
    chip_date DATE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (penguin_id) REFERENCES penguins(penguin_id),
    INDEX idx_penguin (penguin_id),
    INDEX idx_chip_number (chip_number)
);

CREATE TABLE IF NOT EXISTS penguin_scans (
    scan_id INT AUTO_INCREMENT PRIMARY KEY,
    observation_id INT NOT NULL,
    penguin_id INT NOT NULL,
    chip_id INT,
    scan_time_utc DATETIME NOT NULL,
    latitude DOUBLE,
    longitude DOUBLE,
    accuracy FLOAT,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (observation_id) REFERENCES observations(observation_id),
    FOREIGN KEY (penguin_id) REFERENCES penguins(penguin_id),
    FOREIGN KEY (chip_id) REFERENCES penguin_chips(chip_id),
    FOREIGN KEY (deleted_by) REFERENCES users(id),
    INDEX idx_observation (observation_id),
    INDEX idx_penguin (penguin_id),
    INDEX idx_deleted (is_deleted)
);

CREATE TABLE IF NOT EXISTS penguin_biometric_data (
    biometric_id INT AUTO_INCREMENT PRIMARY KEY,
    penguin_id INT NOT NULL,
    observation_id INT,
    observation_date DATE NOT NULL,
    weight DECIMAL(6,2),
    sex VARCHAR(10),
    flipper_length DECIMAL(5,2),
    body_length DECIMAL(5,2),
    beak_length DECIMAL(5,2),
    condition_healthy BOOLEAN DEFAULT FALSE,
    condition_ticks BOOLEAN DEFAULT FALSE,
    notes TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (penguin_id) REFERENCES penguins(penguin_id),
    FOREIGN KEY (observation_id) REFERENCES observations(observation_id),
    FOREIGN KEY (deleted_by) REFERENCES users(id),
    INDEX idx_penguin_date (penguin_id, observation_date)
);

CREATE TABLE IF NOT EXISTS audit_log (
    audit_id INT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(50) NOT NULL,
    record_id INT NOT NULL,
    action VARCHAR(20) NOT NULL,
    observer_id INT NOT NULL,
    changed_fields JSON,
    change_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (observer_id) REFERENCES users(id),
    INDEX idx_record (table_name, record_id),
    INDEX idx_observer (observer_id),
    INDEX idx_timestamp (change_timestamp)
);

-- Seed data: Nelson region and Tarakohe colony
INSERT IGNORE INTO users (id, f_name, email, passphrase_hash)
VALUES (1, 'legacy_import', 'mark@wildwatch.co.nz', '$2y$10$placeholder');

INSERT IGNORE INTO regions (region_id, region_name)
VALUES (1, 'Nelson/Tasman');

INSERT IGNORE INTO colonies (colony_id, region_id, colony_name, location_sets_string)
VALUES (1, 1, 'Tarakohe', '{1-150,AA-AC},{N1-N6}');
