/**
 * @template T
 * @param {Array<T>} array 
 * @returns {Array<T>}
 */
export function distinct(array) {
  return [...new Set(array)];
}