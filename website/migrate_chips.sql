-- Migration: Move tag_number from penguins into penguin_chips table
-- Run AFTER creating the penguin_chips table

-- 1. Create penguin_chips table if not exists
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

-- 2. Add chip_id column to penguin_scans if not exists
ALTER TABLE penguin_scans ADD COLUMN IF NOT EXISTS chip_id INT,
    ADD FOREIGN KEY (chip_id) REFERENCES penguin_chips(chip_id);

-- 3. Add penguin_number and initial_chip_date to penguins if not exists
ALTER TABLE penguins ADD COLUMN IF NOT EXISTS penguin_number VARCHAR(20) AFTER penguin_id;
ALTER TABLE penguins ADD COLUMN IF NOT EXISTS initial_chip_date DATE AFTER penguin_number;

-- 4. Migrate existing tag_number data into penguin_chips
INSERT IGNORE INTO penguin_chips (penguin_id, chip_number, chip_date, is_active)
SELECT penguin_id, tag_number, chip_date, TRUE
FROM penguins
WHERE tag_number IS NOT NULL AND tag_number != '';

-- 5. Set initial_chip_date from chip_date
UPDATE penguins SET initial_chip_date = chip_date WHERE initial_chip_date IS NULL;

-- 6. Backfill chip_id on penguin_scans
UPDATE penguin_scans ps
JOIN penguin_chips pc ON pc.penguin_id = ps.penguin_id
SET ps.chip_id = pc.chip_id
WHERE ps.chip_id IS NULL;
