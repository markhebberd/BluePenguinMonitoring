/**
 * Plain-English explanation of the breeding-detection (family composition) algorithm,
 * shown on the admin page's Algorithm tab.
 *
 * ── How this stays true ──────────────────────────────────────────────────────────
 * Numbers are never written out here. Every tunable value is imported from
 * src/breedingConstants.ts — the same module the algorithm itself runs on — so
 * changing an offset updates this page automatically. If you find yourself typing a
 * number into this file, add it to breedingConstants.ts instead.
 *
 * The prose is written by hand, and hand-written prose rots. scripts/check-algorithm-doc.mjs
 * fingerprints the source of every function described below; the deploy workflow fails
 * if that fingerprint moved without this explanation being re-reviewed. So: change the
 * algorithm, re-read this page, fix what the change made untrue, then run
 *   node scripts/check-algorithm-doc.mjs --update
 * ─────────────────────────────────────────────────────────────────────────────────
 */
import {
  BREEDING_OFFSETS, SECOND_EGG_LAG_DAYS, COURTSHIP_LEAD_DAYS,
  MAX_OFFSPRING_SHOWN, COPRESENCE_WEIGHT,
} from '../breedingConstants';
import { ALGORITHM_DOC } from '../algorithmFingerprint';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const CSS = `
.algo-doc { max-width: 46em; line-height: 1.6; color: #222; }
.algo-doc h3 { margin: 32px 0 8px; font-size: 17px; color: #1a6b8f; }
.algo-doc h3:first-of-type { margin-top: 16px; }
.algo-doc h4 { margin: 20px 0 4px; font-size: 14px; }
.algo-doc p { margin: 0 0 12px; }
.algo-doc ul { margin: 0 0 12px; padding-left: 22px; }
.algo-doc li { margin-bottom: 6px; }
.algo-doc code { background: #f0f3f5; padding: 1px 5px; border-radius: 3px; font-size: 12.5px; }
.algo-doc .lede { font-size: 15px; color: #444; }
.algo-doc .stamp { background: #f7f9fa; border: 1px solid #dde4e8; border-left: 3px solid #1a6b8f;
  padding: 10px 14px; border-radius: 3px; font-size: 12.5px; color: #555; margin-bottom: 20px; }
.algo-doc .stamp b { color: #222; }
.algo-doc .eg { background: #fbfaf5; border: 1px solid #e6e0cc; border-radius: 3px;
  padding: 10px 14px; margin: 0 0 12px; font-size: 13px; }
.algo-doc .eg-title { font-weight: 600; display: block; margin-bottom: 4px; }
.algo-doc table.stages { border-collapse: collapse; margin: 0 0 12px; font-size: 13px; }
.algo-doc table.stages td, .algo-doc table.stages th { border-bottom: 1px solid #e5e5e5; padding: 5px 16px 5px 0; text-align: left; }
.algo-doc table.stages th { font-weight: 600; color: #666; font-size: 12px; }
.algo-doc .caveats li { margin-bottom: 8px; }
.algo-doc .src { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e5e5e5;
  font-size: 12.5px; color: #666; }
.algo-doc .src code { background: none; padding: 0; color: #444; }
@media print { .algo-doc { max-width: none; } }
`;

/** A day-offset from the laid estimate, written the way the rest of the app writes it. */
const d = (n: number) => `${n} days`;

export default function AlgorithmDoc({ seasonStartMonth, seasonStartDay }: { seasonStartMonth: number; seasonStartDay: number }) {
  const seasonStart = `${seasonStartDay} ${MONTHS[seasonStartMonth - 1]}`;
  return (
    <div className="algo-doc">
      <style>{CSS}</style>

      <div className="stamp">
        {ALGORITHM_DOC.reviewed
          ? <>This explanation was last checked against the code on <b>{ALGORITHM_DOC.reviewed}</b> (algorithm fingerprint <code>{ALGORITHM_DOC.fingerprint}</code>).</>
          : <>This explanation has not yet been stamped against the code.</>}
          {' '}The deploy checks the two still match: if the algorithm changes and this page
          isn’t re-reviewed, the deploy fails. Every number below is read live from the code.
      </div>

      <p className="lede">
        Nobody records which two penguins bred together. Monitors record what was in a box on a
        day — adults, eggs, chicks — and which microchipped birds were scanned there. Everything
        the app shows about families and breeding attempts is <em>inferred</em> from those two
        records. This page describes exactly how, in the order the code does it.
      </p>

      <h3>1. What it produces</h3>
      <p>
        For every nest box, for every season, the algorithm produces a list of <b>breeding
        attempts</b> (clutches). Each attempt carries: a date window, up to two parents, the
        chicks microchipped in that nest, and a tally of the eggs and chicks that didn’t make it.
      </p>

      <h3>2. What it reads</h3>
      <ul>
        <li><b>Observations</b> — one box, one day: adults, eggs, chicks, breeding status, notes.</li>
        <li><b>Scans</b> — the microchipped birds read inside an observation.</li>
        <li><b>Chipping records</b> — a bird given its chip at this box on a date.</li>
        <li><b>Penguin records</b> — confirmed sex where known, and the biometric observed-sex calls a monitor made when handling the bird.</li>
      </ul>
      <p>It reads no other signal. If it wasn’t observed or scanned, the algorithm cannot know it.</p>

      <h3>3. Seasons</h3>
      <p>
        A season runs from {seasonStart} to the day before the next {seasonStart}, and is labelled by
        the year it starts in — “2026” means 2026/27. Everything below runs per box, per season,
        independently. A bird chipped at a box one season and scanned there the next produces two
        separate single-season records; it never carries a box’s whole history with it.
      </p>

      <h3>4. Sightings: what counts as “this bird was here”</h3>
      <p>
        A <b>sighting</b> is one bird, at one box, on one day. Two things create one:
        a scan inside an observation, and a chipping record at that box. Both are merged into a
        single chronological list before anything else happens.
      </p>
      <ul>
        <li>A bird scanned twice in one observation is <b>one</b> sighting.</li>
        <li>A bird scanned <em>and</em> chipped at the box on the same day is <b>one</b> sighting — the scan wins, because it carries the box contents with it.</li>
      </ul>
      <p>
        Counting chippings as sightings matters: an adult chipped while guarding chicks was
        plainly attending that nest, even if no observation was filed that day. Without this,
        such a bird would be invisible to parent detection.
      </p>

      <h3>5. Splitting a season into breeding attempts</h3>
      <p>The season’s observations are walked in date order:</p>
      <ul>
        <li>Eggs appearing in a box that was last seen empty <b>starts</b> an attempt. That observation is the <em>discovery</em>.</li>
        <li>Only <b>eggs</b> can start an attempt. Chicks appearing with no egg phase, after an attempt has already finished, is biologically impossible — it’s stale or carried-forward data, so it’s ignored. The one exception is a season’s <em>first</em> attempt, which may start on chicks when the egg phase was simply never observed.</li>
        <li>An attempt <b>ends</b> at the first check that finds the box empty (offspring removed or dead), or at an observation marked <code>ABN</code> (abandoned) — whichever comes first.</li>
        <li>After an <code>ABN</code>, doomed eggs often linger in later checks. A new attempt cannot start until an empty check has actually been seen, so those leftovers can’t masquerade as a second clutch.</li>
        <li>The highest egg count and highest chick count seen anywhere in the attempt are kept — they drive the offspring tally in step 10.</li>
      </ul>

      <h3>6. Estimating when the eggs were laid</h3>
      <p>
        The laid date is a <b>midpoint</b>: halfway between the last check that found the box
        empty and the check that found eggs. If {SECOND_EGG_LAG_DAYS}+ eggs were already there at
        discovery, {SECOND_EGG_LAG_DAYS} days come off first, because the second egg is laid about
        {' '}{SECOND_EGG_LAG_DAYS} days after the first and it’s the <em>first</em> egg being dated.
        The uncertainty quoted alongside it (<code>± n days</code>) is half the gap between those
        two checks — so it is a direct measure of how often that box was visited.
      </p>
      <div className="eg">
        <span className="eg-title">Example</span>
        Box empty on 1 July. Next check, 15 July, finds 2 eggs. Discovery is pulled back
        {' '}{SECOND_EGG_LAG_DAYS} days to 13 July; the midpoint of 1–13 July is 7 July.
        Laid ≈ <b>7 July, ± 6 days</b>. Had the box been checked weekly, the same clutch would
        read ± 3 days.
      </div>
      <p>
        There is <b>no</b> estimate when the season’s first observation already had eggs in it
        (nothing to measure back to), or when the discovery itself is marked abandoned. Such an
        attempt still appears, but with no predicted dates — that’s a real data gap, and it’s
        worth fixing at the source.
      </p>

      <h3>7. The dates that follow from it</h3>
      <p>
        Every other breeding date is the laid estimate plus a fixed offset — the same offsets the
        nestcheck app’s Next Breeding Dates card uses. These are <b>predictions</b>, never
        observations, and they’re shown only while an attempt is still running.
      </p>
      <table className="stages">
        <thead><tr><th>Stage</th><th>After laying</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>Hatch</td><td>{d(BREEDING_OFFSETS.hatch)}</td><td>Eggs hatch (shown only while the clutch is still eggs)</td></tr>
          <tr><td>Guard ends</td><td>{d(BREEDING_OFFSETS.pg)}</td><td>Parents stop attending the nest; both feed at sea</td></tr>
          <tr><td>Chip window</td><td>{BREEDING_OFFSETS.chip}–{BREEDING_OFFSETS.fledge} days</td><td>Chicks big enough to microchip</td></tr>
          <tr><td>Fledge</td><td>{d(BREEDING_OFFSETS.fledge)}</td><td>Chicks leave; the attempt is over</td></tr>
        </tbody>
      </table>

      <h3>8. Two different windows</h3>
      <p>The algorithm uses two date ranges per attempt, and they are not the same range:</p>
      <ul>
        <li>
          <b>The breeding window</b> — discovery through fledge (laid + {BREEDING_OFFSETS.fledge} days),
          cut short by whatever ended the attempt. This is the window drawn on the box page and the
          one chicks are matched against.
        </li>
        <li>
          <b>The attendance window</b> — from {COURTSHIP_LEAD_DAYS} days before the <em>earliest
          plausible</em> laid date (the estimate minus its uncertainty) through the end of guard
          (laid + {BREEDING_OFFSETS.pg} days). This one, and only this one, decides who the parents are.
        </li>
      </ul>
      <p>
        Both ends of the attendance window are deliberate. It opens early because courtship and
        nest-building run for about a month before laying, so a male seen only before the eggs
        appeared is still a parent. It closes at the end of guard because after that both parents
        are at sea and the nest is unattended — a bird recorded in the box past then is evidence
        of nothing.
      </p>

      <h3>9. Choosing the pair</h3>
      <p>
        Every bird sighted inside the attendance window is a candidate, excluding birds that were
        chipped as chicks in this same season (they are the offspring, not the parents). A single
        sighting is enough to be a candidate — the scoring below decides whether it’s enough to win.
      </p>
      <h4>Sex</h4>
      <p>
        A bird’s sex is its confirmed <code>M</code>/<code>F</code> if the penguin record has one.
        Otherwise it’s the majority of the biometric observed-sex calls recorded when the bird was
        handled (probable/measured male vs probable/measured female); an even split leaves the bird
        unsexed. A valid pair is <b>one male and one female where at least one of the two sexes is
        confirmed</b> — two guesses never form a pair, however strong each guess is on its own.
      </p>
      <h4>Scoring</h4>
      <p>Each possible pair scores:</p>
      <ul>
        <li><b>Co-presence × {COPRESENCE_WEIGHT}</b> — the number of times both birds were recorded in the box <em>together</em> (same observation, or chipped there the same day).</li>
        <li><b>plus</b> the two birds’ total sighting counts in the window.</li>
      </ul>
      <p>
        The multiplier means a pair actually seen together always beats a pair that merely shared
        the season. When two pairs score identically — typically two once-seen birds — the pair
        sighted closest to the laid date wins, so the answer doesn’t depend on which bird happened
        to be scanned first.
      </p>
      <div className="eg">
        <span className="eg-title">Example</span>
        #118 (confirmed female) and #201 (unsexed, but 3 of 4 biometrics say male) were scanned in
        the box together twice, {5} sightings between them → {2 * COPRESENCE_WEIGHT + 5}.
        #77 (confirmed male) and #92 (confirmed female) were each in the box often but never on
        the same day, 9 sightings between them → 9. The first pair wins.
      </div>
      <h4>When there’s no pair</h4>
      <p>
        If no valid male–female pair exists, the best-evidenced single candidate becomes a
        <b> lone parent</b> — most sightings, ties broken by nearest to laying. Its sex needn’t be
        known; it fills the male slot unless something says female. The family then shows one adult
        and the offspring. If not one candidate bird was sighted, the attempt has no parents at all,
        which is normal for a box of unchipped birds.
      </p>

      <h3>10. Matching chicks to an attempt</h3>
      <p>
        A bird counts as this season’s chick if it was chipped <em>as a chick</em> (not as an adult)
        and its chip date falls inside this season. A returning adult that happens to have been
        chick-chipped years ago is a visitor, not a chick.
      </p>
      <p>
        Each such chick is assigned to the attempt whose breeding window contains its chip date.
        Chipping happens near the end of an attempt, so a chick that lands outside every window
        defaults to the last attempt that has a detected pair.
      </p>

      <h3>11. What didn’t make it</h3>
      <p>Offspring are counted at their <b>final</b> life stage, once the attempt has closed:</p>
      <ul>
        <li><b>Failed eggs</b> = highest egg count − highest chick count. Eggs that never became a chick.</li>
        <li><b>Unchipped chicks</b> = highest chick count − chicks actually chipped in the nest.</li>
        <li>Of those unchipped chicks, any a monitor explicitly logged as <em>presumed fledged</em> are shown as fledged. The rest are assumed to have died.</li>
        <li>All of these are capped at {MAX_OFFSPRING_SHOWN} per attempt. A little penguin clutch is two eggs; anything beyond the cap is a data-entry error, and the cap stops one bad number drawing a nest full of chicks.</li>
      </ul>
      <p>
        While an attempt is still running none of this is marked as failure — an egg in the nest is
        just an egg in the nest. The failure marks appear only once the window has closed.
      </p>

      <h3>12. Human verification overrides all of it</h3>
      <p>
        Each breeding attempt carries a tick with two halves — the <b>adults</b> and the
        <b> offspring</b> — that a monitor can accept or reject. Accepting snapshots the detected
        answer as ground truth, stored separately from anything the algorithm computes.
      </p>
      <ul>
        <li><b>Grey</b> — not yet reviewed.</li>
        <li><b>Green</b> — reviewed, accepted, and the algorithm still produces the same answer.</li>
        <li><b>Red</b> — rejected, <em>or</em> accepted-then-drifted: the code now says something different from what a human confirmed. That’s the case worth looking at, and it’s why the drift is surfaced rather than silently resolved.</li>
      </ul>
      <p>
        The offspring half can only be verified once the attempt’s window has closed — until then
        there is nothing final to confirm. Verified truth is never overwritten by the algorithm.
      </p>

      <h3>13. What it cannot do</h3>
      <ul className="caveats">
        <li><b>Unchipped adults are invisible.</b> A pair that was never scanned cannot be detected, no matter how faithfully the box was monitored.</li>
        <li><b>Two guessed sexes never pair.</b> Deliberate: it would rather show one parent than invent a pair from two guesses.</li>
        <li><b>Laid dates are only as good as the visit interval.</b> A three-week gap between checks produces a ±10-day estimate, and every predicted stage inherits that error.</li>
        <li><b>A visitor can take a slot.</b> Where the real parent was never scanned, a bird that merely passed through during the attendance window can win by default.</li>
        <li><b>Stale or carried-forward entries distort attempts.</b> Duplicate observations and impossible counts can create or hide an attempt; the Data validation tab exists to catch them.</li>
        <li><b>It is an inference, not a record.</b> Where it’s wrong, the verification tick is the fix — human truth wins and is stored as such.</li>
      </ul>

      <div className="src">
        The code this describes: <code>segmentClutches</code> (step 5–6), <code>boxSightings</code> (step 4),
        {' '}<code>detectClutchPair</code> (step 9), <code>computeBoxFamilies</code> (steps 3, 10–11) and
        {' '}<code>computeClutchVerify</code> (step 12) in <code>src/App.tsx</code>; all numbers in
        {' '}<code>src/breedingConstants.ts</code>. Both the box breeding overview and the bird panel’s
        family view consume the same functions, so what you read here is what both screens show.
      </div>
    </div>
  );
}
