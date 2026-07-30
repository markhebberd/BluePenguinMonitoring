/**
 * The breeding algorithm as a pipe, so the server can run the same code the browser does.
 *
 * reports.php spawns this with node and writes one JSON object on stdin:
 *
 *   { "12": [ { observation_time_utc, adults, eggs, chicks, breeding_status,
 *               scans: [ { chip_date, chipped_as_adult } ] }, … ], … }
 *
 * — every live observation of every box in the colony, exactly as they come out of SQL —
 * and reads back a map of box name to predicted dates, ready to serialise to nestcheck:
 *
 *   { "12": { boxNumber, estHatchDate, estPGDate, chipWindowStart, … }, … }
 *
 * Boxes with no current breeding attempt are simply absent, which is what the old PHP
 * did by skipping them. All the reasoning lives in ./breeding.ts; this file is I/O and
 * nothing else, so there is nothing here that can drift from what the app computes.
 *
 * Built to penguin-api/breeding-cli.mjs at deploy time (npm run build:cli) — the mirror
 * copies that artifact from production rather than building it.
 */
import { predictedDates } from './breeding';
import type { BreedingObservation, PredictedDates } from './breeding';

function read(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (c: string) => { buf += c; });
    stream.on('end', () => resolve(buf));
    stream.on('error', reject);
  });
}

async function main() {
  const input = await read(process.stdin);
  const byBox: Record<string, BreedingObservation[]> = JSON.parse(input || '{}');
  const out: Record<string, PredictedDates> = {};
  for (const [box, observations] of Object.entries(byBox)) {
    const dates = predictedDates(observations || [], box);
    if (dates) out[box] = dates;
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((e: unknown) => {
  // stderr, never stdout: the caller parses stdout as JSON and must be able to tell a
  // failure from an empty result. A non-zero exit is what reports.php checks.
  process.stderr.write(`breeding-cli: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
