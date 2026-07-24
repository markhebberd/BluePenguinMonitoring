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
 * Weight given to co-presence when scoring a candidate pair. Two birds recorded
 * in the box together outrank any number of separate visits, so this sits above
 * any plausible sighting count.
 */
export const COPRESENCE_WEIGHT = 1000;
