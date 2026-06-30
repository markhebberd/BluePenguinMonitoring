-- Give penguin_chips a real location_id so chips can be scoped to a colony
-- (previously only chip_box, a name string). Applied via migrate_chip_location.php.
ALTER TABLE penguin_chips ADD COLUMN location_id INT NULL;
UPDATE penguin_chips pc
  JOIN observation_locations ol ON pc.chip_box = ol.location_name
  SET pc.location_id = ol.location_id
  WHERE pc.location_id IS NULL;
ALTER TABLE penguin_chips ADD INDEX idx_chip_location (location_id);
