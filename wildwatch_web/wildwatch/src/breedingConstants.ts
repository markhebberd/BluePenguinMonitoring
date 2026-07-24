/**
 * Every tunable number the breeding-detection (family composition) algorithm uses.
 *
 * These live here, apart from the algorithm itself, for one reason: the admin
 * page's Algorithm tab imports them too. The written explanation there quotes
 * these values rather than restating them, so the prose can never drift from the
 * numbers the code actually runs on — change a value here and the explanation
 * changes with it.
 *
 * The prose itself is still written by hand (src/components/AlgorithmDoc.tsx).
 * scripts/check-algorithm-doc.mjs fingerprints the algorithm's source so a change
 * to the *logic* can't ship without the explanation being re-reviewed.
 */

/** One day in ms. */
export const DAY = 86400000;

/**
 * Days after the (estimated) first egg that each breeding stage falls due.
 * Mirrors the nestcheck "Next Breeding Dates" card.
 *
 * `hatch` runs in both directions: forward it predicts the hatch date, and backward it
 * dates laying from an observed one — first egg to first chick, the sharper of the two
 * signals whenever a box was watched more closely around hatching than around laying.
 *
 *   hatch  — eggs hatch
 *   pg     — post-guard: parents stop attending the nest, both feed at sea
 *   chip   — start of the window in which chicks are big enough to microchip
 *   fledge — chicks leave the nest; the breeding attempt is over
 */
export const BREEDING_OFFSETS = { hatch: 38, pg: 52, chip: 80, fledge: 87 };

/** Little penguins lay the second egg about this many days after the first. */
export const SECOND_EGG_LAG_DAYS = 2;


/**
 * How long a box must have gone unchecked before chicks found with no egg phase are
 * believed to be a real breeding attempt rather than stale data. Shorter than that and
 * the eggs would have been seen, so the chicks can't be new.
 */
export const CHICK_START_MIN_GAP_DAYS = 35;

/**
 * The same test when the chicks found are already microchipped. A chipped chick is close
 * to fledging, so the whole attempt — laying, incubation, guard — must have passed unseen.
 */
export const CHIPPED_CHICK_START_MIN_GAP_DAYS = 75;

/**
 * How long before laying a pair is already attending the nest (courtship and
 * nest-building). Sightings from this far ahead of the laid estimate count as
 * parent evidence.
 */
export const COURTSHIP_LEAD_DAYS = 30;

/**
 * Cap on offspring drawn for one clutch. A little penguin clutch is two eggs, so
 * anything past this is a data-entry error, not biology — the cap stops one bad
 * number rendering a nest full of chicks.
 */
export const MAX_OFFSPRING_SHOWN = 4;

/**
 * What each kind of evidence is worth when scoring a candidate breeding pair. Every
 * candidate's terms are summed, so a lot of weak evidence CAN outweigh a little strong
 * evidence — deliberately, because a nest watched twice all season shouldn't be answered
 * with the same confidence as one watched weekly.
 *
 * I&G is incubation and guard, from laying to the end of guard, when the parents are
 * actually attending the nest. Pre-breeding is earlier in the same season: courtship and
 * nest-building. Sightings after guard score nothing — both parents are at sea by then —
 * but they still make a bird a candidate, so a barely-monitored nest gets an answer.
 */
export const PAIR_WEIGHTS = {
  sharedIg: 1,    // both birds recorded together during incubation or guard
  ig: 0.8,        // either bird recorded during incubation or guard
  sharedPre: 0.6, // both birds recorded together before laying
  pre: 0.4,       // either bird recorded before laying, this season
  bred: 0.2,      // per bird that bred at this box in an earlier season
};

/**
 * How much of a shared sighting an *implied* one is worth — an unidentified adult recorded
 * beside one half of a pair already known to breed together (it was probably the partner).
 * Half: a good inference, never as good as reading the chip.
 */
export const IMPLIED_SHARE_CONFIDENCE = 0.5;
