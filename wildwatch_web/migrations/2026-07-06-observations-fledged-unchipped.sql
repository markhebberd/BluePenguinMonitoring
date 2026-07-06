-- Count of unchipped chicks last seen on an observation that are presumed to have
-- fledged successfully (rather than died). Surfaced in the box breeding summary as a
-- yellow "Unchipped" mini instead of a presumed-died chick icon.
-- Add the column BEFORE deploying the code that selects it (snapshot.php), to avoid the
-- SPA failing to load — same failure mode as the missing biometric columns earlier today.
ALTER TABLE observations ADD COLUMN fledged_unchipped INT DEFAULT 0 AFTER no_scan;
