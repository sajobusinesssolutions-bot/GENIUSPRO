/* Small pluralisation helpers.
 *
 * The app was showing "1 items unsold", "1 products · 1 categories" and
 * "Recovered 1 item(s) from your last bill". The "(s)" form is a stand-in for
 * getting the count right, and on a shop floor it reads like unfinished
 * software, so these two helpers pick the correct word instead.
 */

/** "1 item" / "3 items" — irregular plurals can be passed explicitly. */
export function plural(n, one, many) {
  const count = Number(n) || 0;
  return `${count} ${count === 1 ? one : many ?? `${one}s`}`;
}

/** Just the noun, when the number is rendered separately. */
export function pluralWord(n, one, many) {
  return (Number(n) || 0) === 1 ? one : many ?? `${one}s`;
}
