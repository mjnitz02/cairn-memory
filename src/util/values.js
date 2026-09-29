/**
 * Small value checks and roundings that several modules need alike. Pure.
 */

/** A plain object: not null, not an array. What every stored and parsed shape is checked against. */
export function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One decimal place, the precision every percentage in the inspector and the log carries. */
export function round1(value) {
    return Math.round(value * 10) / 10;
}
