/**
 * The one place an amount becomes a string.
 *
 * Amounts are stored as bigint minor units (`*_minor` columns) and are never a float, so this
 * module formats a bigint and nothing else. Direction — "you owe" versus "you are owed" — is
 * not decided here: it is words beside the figure, applied by the Money primitive, so a
 * negative amount is never signalled by a minus sign alone (TR-23).
 */

/**
 * How many fraction digits the currency's own display form uses. JPY has none, most currencies
 * have two, and a handful (BHD, KWD) have three — read from Intl rather than from a table we
 * would have to keep correct.
 */
function fractionDigits(currency: string): number {
  // Optional in the type, always present for a currency style in practice; two is the default
  // Intl itself would apply.
  return (
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * An amount in minor units, rendered in the group's currency with its symbol, its separators
 * and its fraction digits (TR-23). `formatMinor(0n, 'EUR')` is '€0.00' — the symbol form is
 * Intl's default and is not overridden.
 *
 * The whole part goes through Intl as a BIGINT, which it formats exactly at any size, and the
 * minor units are substituted into the fraction it produced. The obvious alternative —
 * `format(Number(minor) / 100)` — is the float this is required never to use: above 2^53 it
 * renders a different number from the one that was stored.
 *
 * The locale is pinned because the group's currency is not the reader's locale: an amount
 * recorded in EUR must read the same in every deployment rather than following the server's.
 */
export function formatMinor(minor: bigint, currency: string): string {
  const digits = fractionDigits(currency);
  const scale = 10n ** BigInt(digits);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;

  const whole = negative ? -(absolute / scale) : absolute / scale;
  const fraction = (absolute % scale).toString().padStart(digits, '0');

  return new Intl.NumberFormat('en-US', { style: 'currency', currency })
    .formatToParts(whole)
    .map((part) => (part.type === 'fraction' ? fraction : part.value))
    .join('');
}
