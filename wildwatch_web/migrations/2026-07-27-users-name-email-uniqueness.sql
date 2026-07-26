-- users: identity is (f_name, surname); email is unique only when present.
--
-- WHY: a field volunteer may have no email address at all, so an account must be creatable
-- without one. That makes f_name-alone the wrong unique key (there are already two Marks,
-- distinguished only by an initial baked into the first name) and makes "email is unique"
-- true only of the rows that actually have an email.
--
-- THE NULL-vs-EMPTY ASYMMETRY, WHICH IS DELIBERATE:
--
--   surname is NOT NULL DEFAULT ''      email stays NULLable
--
-- SQL treats NULLs as distinct in a UNIQUE key. That is exactly wrong for surname — two rows
-- of ('Mark', NULL) would both be allowed and the composite key would not bite — and exactly
-- right for email, where every email-less user must be able to coexist. So a blank surname is
-- stored as '' (it participates in the key) and a blank email is stored as NULL (it opts out).
-- admin.php normalises both directions on write; do not "tidy" one to match the other.
--
-- All 8 existing rows have a distinct f_name and a distinct email, so nothing collides.

-- Blank emails would collide with each other under the new key; there are none today, but
-- normalise first so the migration is safe to re-run on a copy that has some.
UPDATE users SET email = NULL WHERE email = '';
UPDATE users SET surname = '' WHERE surname IS NULL;

ALTER TABLE users
  MODIFY COLUMN surname VARCHAR(100) NOT NULL DEFAULT '',
  DROP INDEX f_name,
  ADD UNIQUE KEY uniq_user_name (f_name, surname),
  ADD UNIQUE KEY uniq_user_email (email);

-- Verify:
-- SHOW CREATE TABLE users;
-- SELECT f_name, surname, COUNT(*) n FROM users GROUP BY f_name, surname HAVING n > 1;  -- expect 0
-- SELECT email, COUNT(*) n FROM users WHERE email IS NOT NULL GROUP BY email HAVING n > 1;  -- expect 0
