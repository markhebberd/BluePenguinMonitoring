/**
 * The breeding-detection algorithm: segmenting a box's observations into breeding attempts,
 * dating when each was laid, and deciding when guard gave way to post-guard.
 *
 * This module is the ONLY implementation. It lives apart from the app because two very
 * different callers need the same answers and must never drift apart:
 *
 *   • the wildwatch SPA, which runs it in the browser against the offline cache; and
 *   • reports.php, which runs it under node (see breedingCli.ts) to serve nestcheck's
 *     "Next breeding dates" card.
 *
 * The server used to carry its own hand-written port of a laid-date estimate, and it
 * diverged — worse, silently, because nothing compared the two. Hence one file, no
 * DOM and no React, bundled for node at deploy time.
 *
 * Every tunable number is imported from ./breedingConstants, which the admin page's
 * Algorithm tab quotes; scripts/check-algorithm-doc.mjs fingerprints the functions here
 * so the logic can't change without that explanation being re-read.
 */
import { DAY, BREEDING_OFFSETS, SECOND_EGG_LAG_DAYS, COURTSHIP_LEAD_DAYS, CHICK_START_MIN_GAP_DAYS, CHIPPED_CHICK_START_MIN_GAP_DAYS } from './breedingConstants';

/** What the algorithm needs of a scan: enough to tell a chick from an adult. */
export interface BreedingScan { chip_date: string | null; chipped_as_adult: number | null; }

/** What the algorithm needs of an observation. The app's own Observation carries more
 *  (notes, editor, gate status); none of it reaches a breeding date, so none of it is
 *  required here — which is also what lets the server pass rows straight out of SQL. */
export interface BreedingObservation {
  observation_id?: number | null;
  observation_time_utc: string;
  adults: number; eggs: number; chicks: number;
  breeding_status: string | null;
  scans: BreedingScan[];
}

export function parseDate(d: string): Date {
  // Server dates arrive three ways: ISO ("…T…Z"), MySQL "YYYY-MM-DD HH:MM:SS", or DATE-ONLY
  // "YYYY-MM-DD" (e.g. chip_date). Normalise all to a form every browser accepts. Safari is
  // strict where Chrome is lenient: it rejects a bare space AND a date-only string with a
  // trailing "Z" ("2026-08-02Z" → Invalid Date). The old idiom turned every date-only value
  // into exactly that, so it reached .toISOString() and white-screened Safari.
  if (!d) return new Date(NaN);
  if (d.includes('T') || d.includes('Z')) return new Date(d);
  if (d.length <= 10) return new Date(d + 'T00:00:00Z');   // date-only → midnight UTC
  return new Date(d.replace(' ', 'T') + 'Z');               // "YYYY-MM-DD HH:MM:SS"
}

/** A bird chipped as a chick is still a chick for this long — the window in which a
 *  chipping tells you what was in the box rather than who visited it. */
export function isChickAtObsDate(chipDate?: string|null, chippedAsAdult?: number|null, observationDate?: string): boolean {
  if (chippedAsAdult || !chipDate) return false;
  return ((observationDate ? new Date(observationDate).getTime() : Date.now()) - new Date(chipDate).getTime()) < 90 * 86400000;
}

export /** One breeding attempt in a season. A clutch starts when eggs appear after an empty
 *  check — or chicks do, after a monitoring gap long enough to have hidden the egg
 *  phase — and its window runs from laying until the check that ends it: ABN, or egg
 *  removal / offspring absence (implies death or fledging). A later egg appearance after
 *  an empty check is a SECOND clutch with its own family. */
interface Clutch {
  laid: number | null;      // estimated laid time; null when un-estimable
  laidUncertainty: number | null; // ± days on the laid estimate (half the plausible-laying range)
  laidFailed: boolean;      // nothing to measure back from (eggs at the first check ever, or
                            // an abandoned discovery) — data needs fixing
  start: number;            // first obs with offspring present (egg appearance)
  startObsTime: string;     // that first-offspring observation's UTC time (scroll target)
  startKind: 'egg' | 'chick'; // what was in the box at that discovery — when laying can't be
                            // dated, the discovery is the whole of what the record says
  startObsId: number | null;// that observation's id — the anchor a verification is keyed to
  end: number | null;       // obs that ended the attempt; null = still running
  windowStart: number;      // breeding window: laying (estimated), or discovery when un-estimable …
  windowEnd: number;        // … the check that ended it; predicted fledge while still running
  guardEnd: number;         // end of guard (laid + 52d): parents stop attending after this
  attendStart: number;      // courtship/nest-building start: COURTSHIP_LEAD_DAYS before the EARLIEST
                            // plausible laid date. Attendance from here to guardEnd is
                            // parent evidence — the laid estimate is a midpoint, so
                            // measuring from it alone would cut off real courtship visits.
  maxEggs: number;
  maxChicks: number;
}

/** A microchipped chick is in this observation — so the offspring here are close to
 *  fledging, not newly hatched, and the attempt began much further back. */
export const hasChippedChick = (o: BreedingObservation) =>
  o.scans.some(s => isChickAtObsDate(s.chip_date, s.chipped_as_adult, o.observation_time_utc));

/** What one clutch's own observations say about when it was laid. Gathered during the
 *  walk and turned into an estimate once the clutch has run its course — the hatch
 *  evidence arrives long after the discovery does. */
export interface LaidEvidence {
  emptyBefore: number | null;   // last check that found the box empty, before discovery
  firstEggT: number | null;     // discovery, when it had eggs — laying dates straight off this
  firstEggCount: number;
  lastNoChickT: number | null;  // latest check that still had no chicks
  firstChickT: number | null;   // earliest check with chicks
  abnAtStart: boolean;          // discovery already abandoned — nothing to date
}

/**
 * Date laying from the events that can actually be observed either side of it: the box filling
 * with eggs, and the eggs becoming chicks. Each bounds laying; the estimate is the midpoint of
 * where all the bounds agree, and the ± is that overlap's half-width.
 *
 * Every bound is applied at once rather than the best one being picked — which end of the
 * attempt was watched most closely is an accident of visiting, and whichever it was, it
 * tightens the same answer.
 */
export function estimateLaidFrom(ev: LaidEvidence): { laid: number | null; unc: number | null } {
  if (ev.abnAtStart) return { laid: null, unc: null };
  // Midpoint, rounded up to a whole day to match reports.php — but never past the top of the
  // window: with the bounds this tight a window can be hours wide, and rounding up would
  // otherwise put laying after the eggs were seen.
  const halve = (lo: number, hi: number) =>
    ({ laid: Math.min(hi, lo + Math.ceil((hi - lo) / 2 / DAY) * DAY), unc: Math.floor((hi - lo) / 2 / DAY) });

  // What the box itself showed, which laying has to fit between: it was empty, so laying came
  // after; it held eggs, so laying came before — less the second-egg lag, since it's the FIRST
  // egg being dated.
  const seenEmpty = ev.emptyBefore;
  let seenEggs = ev.firstEggT !== null
    ? ev.firstEggT - (ev.firstEggCount > 1 ? SECOND_EGG_LAG_DAYS : 0) * DAY : null;
  // On a box checked every day or two that lag can put the bound before the check that found
  // the box empty. The empty box was seen; the lag is inferred from a count — so the lag is
  // what gives way, not the observation.
  if (seenEggs !== null && seenEmpty !== null && seenEggs < seenEmpty) seenEggs = ev.firstEggT;
  // What the hatch says. The box had no chicks, then it had them, so hatching fell between
  // those two checks and laying an incubation before each — on a box watched closely around
  // hatching this is far the sharper signal, since the hatch is a single event where laying
  // smears over two eggs.
  //
  // ONLY the hatch, though. What a chick's own stage implies — that a chipped one is near
  // fledging, that one still in the nest hasn't fledged — is an inference about the bird's
  // age, not a dated event. Those are good enough to rule a breeding window out (they gate
  // whether chicks may start an attempt at all) but not to date one, so they stay out of here.
  const hatchedBetween = ev.firstChickT !== null && ev.lastNoChickT !== null;
  const chickHi = hatchedBetween ? ev.firstChickT! - BREEDING_OFFSETS.hatch * DAY : null;
  const chickLo = hatchedBetween ? ev.lastNoChickT! - BREEDING_OFFSETS.hatch * DAY : null;

  // Every bound at once, not the better of two: each is a fact about the same unknown, so the
  // answer is where they all agree. Whichever end was watched more closely is what tightens it.
  const notNull = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const los = notNull([seenEmpty, chickLo]), his = notNull([seenEggs, chickHi]);
  if (los.length && his.length) {
    const lo = Math.max(...los), hi = Math.min(...his);
    if (lo <= hi) return halve(lo, hi);
  }
  // No overlap: the chicks contradict the box's own contents — an empty box, or eggs still
  // unhatched, too few days before a chick that needs a whole incubation. One of the two
  // records is wrong, and the box's contents are what was directly seen, so fall back to
  // those alone.
  if (seenEmpty !== null && seenEggs !== null) return halve(seenEmpty, seenEggs);
  return { laid: null, unc: null };
}

/**
 * @param priorObsT when this box was last checked BEFORE these observations start (null =
 *   never). Callers passing one season's observations must pass it: the gap that decides
 *   whether chicks can start an attempt is the real monitoring gap, not one manufactured
 *   by the season boundary.
 */
export function segmentClutches(sObs: BreedingObservation[], priorObsT: number | null = null): Clutch[] {
  const clutches: Clutch[] = [];
  const evidence: LaidEvidence[] = [];      // one per clutch, same index
  let current: Clutch | null = null;
  let ev: LaidEvidence | null = null;       // the running clutch's laid evidence
  // After an ABN close the doomed eggs may linger in later checks — require an
  // empty check before a new clutch can start.
  let awaitingEmpty = false;
  let prevEmpty: number | null = null;
  let prevObs: number | null = priorObsT;   // last check of ANY kind — the monitoring gap
  for (const o of sObs) {
    const t = parseDate(o.observation_time_utc).getTime();
    const off = (o.eggs || 0) + (o.chicks || 0);
    const abn = o.breeding_status === 'ABN';
    // Chicks with no egg phase are usually stale/carry-forward data — but not if the box
    // went unwatched long enough for the egg phase to have happened unseen. How long
    // depends on what's in there: downy chicks put laying at least a hatch back, already
    // chipped chicks put it most of a breeding cycle back.
    const gapDays = prevObs === null ? Infinity : (t - prevObs) / DAY;
    const chicksCanStart = gapDays >= (hasChippedChick(o) ? CHIPPED_CHICK_START_MIN_GAP_DAYS : CHICK_START_MIN_GAP_DAYS);
    if (current) {
      if (off === 0) {
        current.end = t; current = null; ev = null; prevEmpty = t; awaitingEmpty = false;
      } else {
        current.maxEggs = Math.max(current.maxEggs, o.eggs || 0);
        current.maxChicks = Math.max(current.maxChicks, o.chicks || 0);
        // Hatch evidence: the last check with the eggs still unhatched, and the first with
        // chicks. Only until chicks appear — a chick lost later says nothing about hatching.
        if (ev && ev.firstChickT === null) {
          if ((o.chicks || 0) > 0) ev.firstChickT = t;
          else ev.lastNoChickT = t;
        }
        if (abn) { current.end = t; current = null; ev = null; awaitingEmpty = true; }
      }
    } else if (off === 0) {
      prevEmpty = t; awaitingEmpty = false;
    } else if (!awaitingEmpty && ((o.eggs || 0) > 0 || chicksCanStart)) {
      const chicksAtStart = (o.chicks || 0) > 0;
      ev = {
        emptyBefore: prevEmpty,
        firstEggT: (o.eggs || 0) > 0 ? t : null,
        firstEggCount: o.eggs || 0,
        // Discovered on chicks: the last we knew there were none is the empty check itself.
        lastNoChickT: chicksAtStart ? prevEmpty : t,
        firstChickT: chicksAtStart ? t : null,
        abnAtStart: abn,
      };
      evidence.push(ev);
      current = { laid: null, laidUncertainty: null, laidFailed: false, start: t, startObsTime: o.observation_time_utc, startObsId: o.observation_id ?? null,
        startKind: (o.eggs || 0) > 0 ? 'egg' : 'chick', end: null,
        windowStart: 0, windowEnd: 0, guardEnd: 0, attendStart: 0, maxEggs: o.eggs || 0, maxChicks: o.chicks || 0 };
      clutches.push(current);
      if (abn) { current.end = t; current = null; ev = null; awaitingEmpty = true; }
    }
    prevObs = t;
  }
  clutches.forEach((c, i) => {
    const { laid, unc } = estimateLaidFrom(evidence[i]);
    c.laid = laid; c.laidUncertainty = unc; c.laidFailed = laid === null;
  });
  for (const c of clutches) {
    const anchor = c.laid ?? c.start; // fall back to first sighting when laid unknown
    // The attempt runs from laying to the check that ended it — offspring gone, or ABN. Not
    // from the discovery, which is only when someone happened to look, and not to a predicted
    // fledge, which would cut a window short while the box plainly still held chicks. A window
    // still running has no observed end, so there the predicted fledge stands in: it's what
    // eventually stops an unrevisited box reading as "current".
    c.windowStart = anchor;
    c.guardEnd = Math.min(c.end ?? Infinity, anchor + BREEDING_OFFSETS.pg * DAY);
    c.windowEnd = c.end ?? (anchor + BREEDING_OFFSETS.fledge * DAY);
    c.attendStart = (c.laid !== null ? c.laid - (c.laidUncertainty || 0) * DAY : c.windowStart) - COURTSHIP_LEAD_DAYS * DAY;
  }
  return clutches;
}

export /**
 * When each breeding attempt at a box left guard behind.
 *
 * Guard ends when the chicks are first left on their own: the parents stop brooding them
 * and both feed at sea, coming back only to feed. It isn't a clean switch — a pair
 * commonly leaves the chicks for a day and one of them is back the next, and the two
 * parents don't stop together — so post-guard is dated from the FIRST check that found
 * the chicks with neither parent there, and the nest stays post-guard from that check on
 * whatever a later one finds.
 *
 * The chicks have to be old enough first. Nothing counts before {@link BREEDING_OFFSETS.pg}
 * days after laying, which is two weeks past the estimated hatch: earlier than that a
 * check finding no adult caught a parent briefly off the nest, not the end of guard.
 *
 * One range per attempt that reached post-guard — from that first check to whatever ended
 * the attempt (offspring gone, or ABN; open-ended while it's still running).
 */
function postGuardRanges(observations: BreedingObservation[]): { from: number; to: number }[] {
  const chrono = [...observations].sort((a, b) => parseDate(a.observation_time_utc).getTime() - parseDate(b.observation_time_utc).getTime());
  const ranges: { from: number; to: number }[] = [];
  for (const c of segmentClutches(chrono)) {
    // Laid + 52d, from the same estimate the timeline and the breeding calendar date PG by.
    // A clutch whose laying can't be estimated falls back to its discovery, as guardEnd does.
    const earliest = Math.max((c.laid ?? c.start) + BREEDING_OFFSETS.pg * DAY, c.start);
    const end = c.end ?? Infinity;
    const alone = chrono.find(o => {
      const t = parseDate(o.observation_time_utc).getTime();
      return t >= earliest && t <= end && (o.chicks || 0) > 0 && (o.adults || 0) === 0;
    });
    if (alone) ranges.push({ from: parseDate(alone.observation_time_utc).getTime(), to: end });
  }
  return ranges;
}

/** What the record can say about chicks leaving, beyond the dates. */
export interface FledgeEvidence {
  /** When chicks were microchipped in this nest (ms). The strongest evidence there is. */
  chickChipTimes?: number[];
  /** A monitor recorded unchipped chicks as presumed fledged (the fledged_unchipped field). */
  recordedFledged?: boolean;
}

/**
 * Did the chicks leave, or were they lost?
 *
 * A nest that held chicks and is now empty says nothing on its own — the same empty box
 * follows a successful fledging and a predation. Three things can tell them apart, in
 * descending order of how directly they were witnessed.
 *
 * A monitor recording unchipped chicks as presumed fledged is a person stating the outcome,
 * so it settles the question outright.
 *
 * A chick microchipped in the nest is nearly as good and far more common: nobody chips a
 * bird that then dies in the nest, and the chipping is someone's record of having held it,
 * grown. So a chipping means fledged — and the window for accepting one is deliberately
 * loose, running from the start of the attempt to the predicted fledge or the check that
 * ended it, whichever is later. A chipping entered a few days late is a filing detail, not
 * evidence against the chick.
 *
 * Failing both, the dates: chicks last seen at or past the chip window opening
 * ({@link BREEDING_OFFSETS.chip} days after laying) were big enough to microchip, and a chick
 * big enough to chip is big enough to go. This reads the LAST SIGHTING rather than the check
 * that found the box empty — those can be months apart, and a nest nobody looked at for a
 * season should not be credited with a fledging no one was near enough to infer.
 */
export function looksFledged(clutch: Clutch, lastSeenWithChicks: number, evidence: FledgeEvidence = {}): boolean {
  if (evidence.recordedFledged) return true;
  const anchor = clutch.laid ?? clutch.start;
  const until = Math.max(clutch.end ?? clutch.windowEnd, anchor + BREEDING_OFFSETS.fledge * DAY);
  if ((evidence.chickChipTimes || []).some(t => t >= clutch.start && t <= until)) return true;
  return lastSeenWithChicks >= anchor + BREEDING_OFFSETS.chip * DAY;
}

/** The shape nestcheck's "Next breeding dates" card consumes, one entry per box.
 *  Dates are NZ calendar days (YYYY-MM-DD); '' means "not applicable to this attempt". */
export interface PredictedDates {
  boxNumber: number;
  estHatchDate: string;
  estPGDate: string;
  chipWindowStart: string;
  chipWindowFinish: string;
  estFledgeDate: string;
  probableLaidDate: string;
  uncertaintyDays: number;
}

/** NZ calendar day of a timestamp. Every date this module publishes is a day a monitor
 *  would write down, not an instant — the offsets are whole days and so are the answers. */
function nzDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
}

/**
 * Predicted milestones for a box's CURRENT breeding attempt, or null if it hasn't got one.
 *
 * "Current" means the last attempt the segmentation found, still running: no check has
 * ended it. A finished attempt needs no predictions — what happened is on the record — and
 * an abandoned one is excluded by the segmentation itself, which closes a clutch on ABN.
 *
 * The hatch is published only while the clutch is still eggs. Once chicks are in the box
 * the hatch is an observed fact and a prediction of it would be worse than the record.
 */
export function predictedDates(observations: BreedingObservation[], boxName: string): PredictedDates | null {
  const chrono = [...observations].sort((a, b) => parseDate(a.observation_time_utc).getTime() - parseDate(b.observation_time_utc).getTime());
  const clutches = segmentClutches(chrono);
  const cur = clutches[clutches.length - 1];
  if (!cur || cur.end !== null) return null;          // no attempt, or the last one is over
  if (cur.laid === null) return null;                 // nothing to measure from — see laidFailed

  const inClutch = chrono.filter(o => parseDate(o.observation_time_utc).getTime() >= cur.start);
  const latest = inClutch[inClutch.length - 1];
  if (!latest || (latest.eggs || 0) + (latest.chicks || 0) === 0) return null;  // not breeding now

  const at = (offset: number) => nzDay(cur.laid! + offset * DAY);
  const stillEggs = cur.maxEggs > 0 && (latest.chicks || 0) === 0;
  return {
    boxNumber: /^\d+$/.test(boxName) ? parseInt(boxName, 10) : 0,
    estHatchDate: stillEggs ? at(BREEDING_OFFSETS.hatch) : '',
    estPGDate: at(BREEDING_OFFSETS.pg),
    chipWindowStart: at(BREEDING_OFFSETS.chip),
    chipWindowFinish: at(BREEDING_OFFSETS.fledge),
    estFledgeDate: at(BREEDING_OFFSETS.fledge),
    probableLaidDate: nzDay(cur.laid),
    uncertaintyDays: cur.laidUncertainty ?? 0,
  };
}
