/**
 * Die sizes and the step ladder (Dice & Pools spec).
 * @module rules/dice
 */

import { DIE_SIZES } from "./types.mjs";

/**
 * @typedef {Object} StepResult
 * @property {import("./types.mjs").DieSize} [size] - present for a plain in-ladder result
 * @property {true} [removed] - a d4 stepped down (rule 3)
 * @property {number} [beyond] - steps past d12 with no bare-size rule (rule 4); paired with
 *   `size: 12`
 */

/**
 * Steps a die size up (positive `steps`) or down (negative `steps`) on the d4-d6-d8-d10-d12
 * ladder, one step at a time (rule 2). A d4 stepped down is removed, and further down-steps
 * leave it removed (rule 3). A step that would push past d12 instead reports how many steps
 * had nowhere to go, since a bare size has no "what happens" rule there (rule 4) — pool-aware
 * callers turn `beyond` into overflow dice (see pool.mjs).
 * @param {import("./types.mjs").DieSize} size
 * @param {number} steps
 * @returns {StepResult}
 */
export function stepDie(size, steps) {
  const start = DIE_SIZES.indexOf(size);
  if ( start === -1 ) throw new Error(`stepDie: not a die size: ${size}`);

  const direction = steps > 0 ? 1 : steps < 0 ? -1 : 0;
  let index = start;
  let beyond = 0;
  let removed = false;

  for ( let taken = 0; taken < Math.abs(steps); taken++ ) {
    if ( removed ) break;
    if ( direction > 0 ) {
      if ( index === DIE_SIZES.length - 1 ) beyond += 1;
      else index += 1;
    }
    else if ( direction < 0 ) {
      if ( index === 0 ) removed = true;
      else index -= 1;
    }
  }

  if ( removed ) return { removed: true };
  if ( beyond > 0 ) return { size: DIE_SIZES[index], beyond };
  return { size: DIE_SIZES[index] };
}
