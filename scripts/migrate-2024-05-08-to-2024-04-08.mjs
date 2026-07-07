#!/usr/bin/env node
/**
 * One-time migration: move everything recorded on NZ day 8 May 2024 to 8 April 2024.
 *
 * Goes through the audited CRUD API (crud.php) so every change lands in audit_log
 * with a change_reason. All moved datetimes are set to 2pm NZ on 8 Apr 2024
 * (02:00 UTC — NZST, same convention as penguins.death_date).
 *
 * Touches:
 *   - observations.observation_time_utc   (NZ day = fixed UTC+12, same as the app)
 *   - penguin_scans.scan_time_utc         (scans of those observations)
 *   - penguin_biometric_data.observation_date
 *   - date_mappings via season_fm_dates   (if 2024-05-08 is a registered FM date)
 *
 * Usage:
 *   WW_EMAIL=... WW_PASSWORD=... node migrate-2024-05-08-to-2024-04-08.mjs           # dry run
 *   WW_EMAIL=... WW_PASSWORD=... node migrate-2024-05-08-to-2024-04-08.mjs --apply   # write
 *
 * Optional: WW_BASE (default https://wildwatch.co.nz/api), WW_TOKEN (skip login).
 */

const FROM_DATE = '2024-05-08';
const TO_DATE = '2024-04-08';
const TO_DATETIME_UTC = '2024-04-08 02:00:00'; // 2pm NZ (NZST, UTC+12)
const REASON = 'One-time migration: data recorded on 8 May 2024 moved to 8 Apr 2024';

const BASE = process.env.WW_BASE || 'https://wildwatch.co.nz/api';
const APPLY = process.argv.includes('--apply');

let token = process.env.WW_TOKEN || null;

async function api(path, body) {
  const res = await fetch(`${BASE}/crud.php?${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}

function nzDay(mysqlDt) {
  // Fixed +12, matching the app's toNzDateStr bucketing
  return new Date(Date.parse(mysqlDt.replace(' ', 'T') + 'Z') + 12 * 3600000)
    .toISOString().slice(0, 10);
}

async function main() {
  if (!token) {
    const email = process.env.WW_EMAIL, password = process.env.WW_PASSWORD;
    if (!email || !password) {
      console.error('Set WW_EMAIL and WW_PASSWORD (or WW_TOKEN).');
      process.exit(1);
    }
    token = (await api('action=login', { email, password })).token;
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} — ${FROM_DATE} -> ${TO_DATE} via ${BASE}\n`);

  // --- Observations -------------------------------------------------------
  const observations = await api(`action=list&table=observations&nz_date=${FROM_DATE}`);
  if (observations.length >= 5000) throw new Error('Result truncated at 5000 rows — aborting');

  const existingOnTarget = await api(`action=list&table=observations&nz_date=${TO_DATE}`);
  if (existingOnTarget.length > 0) {
    console.log(`NOTE: ${TO_DATE} already has ${existingOnTarget.length} observation(s); moved rows will join them.`);
    const clash = new Set(existingOnTarget.map(o => o.location_id));
    const dup = observations.filter(o => clash.has(o.location_id));
    if (dup.length) console.log(`WARNING: ${dup.length} moved observation(s) share a box with an existing ${TO_DATE} observation: ids ${dup.map(o => o.observation_id).join(', ')}`);
  }

  console.log(`Observations on ${FROM_DATE}: ${observations.length}`);
  let scanCount = 0;
  if (nzDay(TO_DATETIME_UTC) !== TO_DATE) throw new Error('TO_DATETIME_UTC does not land on TO_DATE');
  for (const obs of observations) {
    if (nzDay(obs.observation_time_utc) !== FROM_DATE)
      throw new Error(`Observation ${obs.observation_id} not on ${FROM_DATE}: ${obs.observation_time_utc}`);

    const flags = obs.is_deleted && Number(obs.is_deleted) ? ' [soft-deleted]' : '';
    console.log(`  obs ${obs.observation_id} (loc ${obs.location_id})${flags}: ${obs.observation_time_utc} -> ${TO_DATETIME_UTC}`);
    if (APPLY) await api(`action=update&table=observations&id=${obs.observation_id}`, { observation_time_utc: TO_DATETIME_UTC, _reason: REASON });

    const scans = await api(`action=list&table=penguin_scans&observation_id=${obs.observation_id}`);
    for (const scan of scans) {
      console.log(`    scan ${scan.scan_id}: ${scan.scan_time_utc} -> ${TO_DATETIME_UTC}`);
      if (APPLY) await api(`action=update&table=penguin_scans&id=${scan.scan_id}`, { scan_time_utc: TO_DATETIME_UTC, _reason: REASON });
      scanCount++;
    }
  }

  // --- Biometrics ---------------------------------------------------------
  const biometrics = await api(`action=list&table=penguin_biometric_data&observation_date=${FROM_DATE}`);
  console.log(`Biometric rows dated ${FROM_DATE}: ${biometrics.length}`);
  for (const bio of biometrics) {
    console.log(`  biometric ${bio.biometric_id} (obs ${bio.observation_id ?? '-'}): ${FROM_DATE} -> ${TO_DATE}`);
    if (APPLY) await api(`action=update&table=penguin_biometric_data&id=${bio.biometric_id}`, { observation_date: TO_DATE, _reason: REASON });
  }

  // --- FM date mappings ---------------------------------------------------
  const fmDates = await api('action=all_fm_dates');
  const hit = fmDates.find(d => String(d.actual_date).slice(0, 10) === FROM_DATE);
  if (hit) {
    console.log(`FM date mapping: season ${hit.season_year} day ${hit.date_number} is ${FROM_DATE} -> ${TO_DATE}`);
    if (APPLY) {
      const season = await api(`action=season_fm_dates&season=${hit.season_year}`);
      const rows = season.map(r => ({
        n: r.date_number,
        date: String(r.actual_date).slice(0, 10) === FROM_DATE ? TO_DATE : String(r.actual_date).slice(0, 10),
      })).sort((a, b) => a.date.localeCompare(b.date)).map((r, i) => ({ n: i + 1, date: r.date }));
      await api(`action=season_fm_dates&season=${hit.season_year}`, rows);
    }
  } else {
    console.log(`No FM date mapping registered for ${FROM_DATE}.`);
  }

  console.log(`\n${APPLY ? 'Done' : 'Dry run complete'}: ${observations.length} observations, ${scanCount} scans, ${biometrics.length} biometric rows${hit ? ', 1 FM date mapping' : ''}.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
