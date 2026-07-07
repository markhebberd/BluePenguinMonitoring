-- Partial Monitor flag on FM date-table entries. A "PM" date is a deliberate
-- partial round of the colony (not every box), so it should read as complete
-- (green) on its own — the full box-set count that flags a normal FM date is
-- skipped for it. Default 0 keeps every existing date a full monitor.
ALTER TABLE date_mappings ADD COLUMN partial_monitor TINYINT(1) NOT NULL DEFAULT 0;
