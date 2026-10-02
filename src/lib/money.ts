import type { ExpenseSplitType } from '@/db/schema';

/**
 * The one place an amount becomes a string, and the one place an amount is divided.
 *
 * Amounts are stored as bigint minor units (`*_minor` columns) and are never a float, so this
 * module formats a bigint and nothing else. Direction — "you owe" versus "you are owed" — is
 * not decided here: it is words beside the figure, applied by the Money primitive, so a
 * negative amount is never signalled by a minus sign alone (TR-23).
 *
 * Everything here is a pure function of its arguments — no database, no clock, no randomness —
 * which is what lets the expense form resolve a split live with the same `split()` the server
 * calls before it writes (TRD, src/lib/money).
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

/**
 * The currency's symbol on its own, for the fixed prefix beside an amount input. Read from the
 * same Intl the formatter uses, so the symbol a person types against cannot disagree with the
 * one their amount is later rendered with.
 */
export function currencySymbol(currency: string): string {
  return (
    new Intl.NumberFormat('en-US', { style: 'currency', currency })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? currency
  );
}

// --- parsing ------------------------------------------------------------------------

/** Why a typed amount was refused. Each maps to one sentence, built by parseDecimal. */
export type AmountRefusal =
  | 'empty'
  | 'signed'
  | 'non-ascii-digits'
  | 'grouping-separators'
  | 'not-a-number'
  | 'too-many-fraction-digits';

export type ParseAmountResult =
  | { ok: true; minor: bigint }
  | { ok: false; refusal: AmountRefusal; message: string };

/** Any character above ASCII — a digit somewhere else, such as an Arabic-Indic '٣' or a fullwidth '３'. */
const NON_ASCII = /[\u0080-\uffff]/;

/**
 * Commas, underscores, apostrophes and any whitespace inside the number: '1,234' and '1 234'.
 * The two named spaces are the non-breaking and narrow no-break ones, which `\s` does not
 * cover and which are exactly what a copied-and-pasted amount arrives carrying.
 */
const GROUPING = /[\s,_'\u00a0\u202f]/;

/**
 * A decimal string to an integer count of `fractionDigits` fractional units, with no float
 * anywhere on the path.
 *
 * The whole part is built with BigInt and the fraction is PADDED, never divided: '0.1' in a
 * two-digit currency is `1n * 10n` + `0n`, so an amount above 2^53 survives the round trip that
 * `Number(text) * 100` would lose. The refusals are typed and each carries the sentence that
 * names what is off, because a caller that renders the message beside a field is the only way
 * "rejected beside the field that caused it" is a thing a person can act on.
 */
export function parseDecimal(text: string, fractionDigits: number): ParseAmountResult {
  const trimmed = text.trim();
  const refuse = (refusal: AmountRefusal, message: string): ParseAmountResult => ({
    ok: false,
    refusal,
    message,
  });

  if (trimmed === '') return refuse('empty', 'Enter an amount.');
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
    return refuse('signed', 'Enter a positive amount, without a sign.');
  }
  // Checked before the shape, so '١٢٣' is told it is written in the wrong digits rather than
  // that it is not a number. The test is per character and asks whether THAT character is a
  // digit somewhere else: `\p{Nd}` alone matches '7', so pairing it with a non-ASCII test on the
  // whole string would call '1 234' — an ASCII number carrying a narrow no-break space — a
  // wrong-digit problem and hide the separator from the check below.
  if ([...trimmed].some((character) => NON_ASCII.test(character) && /\p{Nd}/u.test(character))) {
    return refuse('non-ascii-digits', 'Use the digits 0 to 9.');
  }
  if (GROUPING.test(trimmed)) {
    return refuse('grouping-separators', 'Enter the amount without separators, like 1234.56.');
  }

  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  const whole = match?.[1] ?? '';
  const fraction = match?.[2] ?? '';
  if (!match || whole.length + fraction.length === 0) {
    return refuse('not-a-number', 'Enter the amount as a number, like 12.34.');
  }
  if (fraction.length > fractionDigits) {
    return refuse(
      'too-many-fraction-digits',
      fractionDigits === 0
        ? 'This one is counted in whole units, with no decimal places.'
        : `Use at most ${fractionDigits} decimal places.`,
    );
  }

  const minor = BigInt(whole) * 10n ** BigInt(fractionDigits) + BigInt(fraction.padEnd(fractionDigits, '0') || '0');
  return { ok: true, minor };
}

/**
 * An amount a person typed, in the group's own currency. The currency decides how many decimal
 * places the amount may have — 1234 is ¥1,234 but €12.34 — so the parse and the format agree
 * about what the same string means.
 */
export function parseMajorUnits(text: string, currency: string): ParseAmountResult {
  return parseDecimal(text, fractionDigits(currency));
}

/** A percentage a person typed, as hundredths of a percent: '33.33' is 3333n. */
export function parsePercent(text: string): ParseAmountResult {
  return parseDecimal(text, 2);
}

/** What a percentage's hundredths read as: 3333n is '33.33%'. */
export function formatPercent(hundredths: bigint): string {
  const negative = hundredths < 0n;
  const absolute = negative ? -hundredths : hundredths;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}%`;
}

// --- stored inputs back to text -----------------------------------------------------

/**
 * An integer count of `fractionDigits` fractional units as plain editable text — the inverse of
 * parseDecimal, and the one formatter here that emits neither a symbol nor a grouping separator.
 *
 * It has to be exactly what the parser accepts, because the edit form's whole promise is that
 * reopening an expense and saving it unchanged writes the same expense again: '1,234.56' would
 * come back refused with "enter the amount without separators", and a JPY amount rendered as
 * '¥1,234' would not parse at all. The fraction is trimmed of trailing zeros so the shortest
 * form is shown — '12.30' reads as '12.3' — and both parse to the same minor units.
 */
export function formatDecimalUnits(value: bigint, fractionDigits: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / 10n ** BigInt(fractionDigits)).toString();
  if (fractionDigits === 0) return `${negative ? '-' : ''}${whole}`;

  const fraction = (absolute % 10n ** BigInt(fractionDigits))
    .toString()
    .padStart(fractionDigits, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * An amount in the group's currency as plain editable text, which is the inverse of
 * parseMajorUnits: minor units in, a number a person could have typed out, in the currency's own
 * number of decimal places — ¥1,234 is '1234' and €12.34 is '12.34'.
 */
export function formatMajorUnits(minor: bigint, currency: string): string {
  return formatDecimalUnits(minor, fractionDigits(currency));
}

/**
 * The plain editable text for one stored split input, in the unit its split type counts in:
 * minor units for `exact`, hundredths of a percent for `percentage`, a plain count for `shares`.
 * Empty for an equal split and for a member who is not in the split, neither of which has a
 * number stored — nothing is written into the field, rather than a zero the person never typed.
 */
export function formatSplitInput(type: ExpenseSplitType, value: bigint | null, currency: string): string {
  if (type === 'equal' || value === null) return '';
  if (type === 'exact') return formatMajorUnits(value, currency);
  if (type === 'percentage') return formatDecimalUnits(value, 2);
  return value.toString();
}

// --- splitting ----------------------------------------------------------------------

/** One member's place in the split, and the number they were given for it. */
export interface SplitInput {
  memberId: string;
  /**
   * Minor units for an exact split, hundredths of a percent for a percentage split, a plain
   * count for a shares split. Null for an equal split, and read as zero for the three types
   * that take a number — a member left blank takes no part of the expense.
   */
  value: bigint | null;
}

/** Why a split was refused. Each names what is off, and by how much, in the unit it is off in. */
export type SplitRefusal =
  | { code: 'no-participants' }
  | { code: 'shares-sum-zero' }
  /** `differenceMinor` is the typed sum minus the total: negative is short, positive is over. */
  | { code: 'exact-mismatch'; sumMinor: bigint; differenceMinor: bigint }
  | {
      code: 'percentage-mismatch';
      sumHundredths: bigint;
      differenceHundredths: bigint;
      /** What the unentered percentage is worth: the minor units no share would account for. */
      unassignedMinor: bigint;
    };

export interface SplitShare {
  memberId: string;
  amountMinor: bigint;
}

export type SplitResult =
  | {
      ok: true;
      /** One entry per participant, in the order given. */
      shares: SplitShare[];
      /**
       * The floor-division remainder this split could not divide evenly, and the member it was
       * given to — the first participant in the order passed in, which the caller supplies in
       * the split's canonical member order rather than in the order somebody typed them (TR-3).
       */
      remainderMinor: bigint;
      remainderMemberId: string | null;
    }
  | { ok: false; refusal: SplitRefusal };

const HUNDRED_PERCENT = 10_000n;

/** The unit a member's input is counted in, and the total that unit has to add up to. */
function spread(amountMinor: bigint, weights: bigint[], total: bigint): bigint[] {
  // Floor division per member, so nothing is invented; the sum comes out at or below the total
  // and the whole difference is handed to the first member below.
  return weights.map((weight) => (amountMinor * weight) / total);
}

/**
 * Divides an expense total between its participants, exactly.
 *
 * The parts always sum to the total — that is the invariant the whole product rests on — so a
 * rule that cannot produce them (exact amounts that do not add up, percentages that do not
 * reach 100) is refused with the discrepancy named, and a rule that divides unevenly gives its
 * entire floor-division remainder to the FIRST participant, which is the first payer in the
 * split's canonical member order (TR-3). Equal, percentage and share splits reach that by the
 * same route: floor each part, then hand the whole leftover to the first.
 *
 * This is one function called from two places — the server before it writes, and the expense
 * form's live summary — so there is exactly one remainder implementation in the product.
 */
export function split(
  amountMinor: bigint,
  type: ExpenseSplitType,
  participants: SplitInput[],
): SplitResult {
  if (participants.length === 0) return { ok: false, refusal: { code: 'no-participants' } };

  const values = participants.map((participant) => participant.value ?? 0n);

  if (type === 'exact') {
    const sum = values.reduce((total, value) => total + value, 0n);
    if (sum !== amountMinor) {
      return {
        ok: false,
        refusal: { code: 'exact-mismatch', sumMinor: sum, differenceMinor: sum - amountMinor },
      };
    }
    return settle(participants, values, 0n);
  }

  if (type === 'percentage') {
    const sum = values.reduce((total, value) => total + value, 0n);
    if (sum !== HUNDRED_PERCENT) {
      // What the missing or extra percentage is worth in money: the same fraction of the total
      // the discrepancy is of 100%. Named as well as the percentage itself, because a person
      // reading "0.50% short" still has to work out what that costs.
      const unassigned = (amountMinor * (HUNDRED_PERCENT - sum)) / HUNDRED_PERCENT;
      return {
        ok: false,
        refusal: {
          code: 'percentage-mismatch',
          sumHundredths: sum,
          differenceHundredths: sum - HUNDRED_PERCENT,
          unassignedMinor: unassigned,
        },
      };
    }
    const parts = spread(amountMinor, values, HUNDRED_PERCENT);
    return settle(participants, parts, amountMinor - parts.reduce((total, part) => total + part, 0n));
  }

  if (type === 'shares') {
    const total = values.reduce((count, value) => count + value, 0n);
    if (total === 0n) return { ok: false, refusal: { code: 'shares-sum-zero' } };
    const parts = spread(amountMinor, values, total);
    return settle(participants, parts, amountMinor - parts.reduce((sum, part) => sum + part, 0n));
  }

  // Equal: every participant has the same weight, so the base is the total divided by the count
  // and the remainder is what that division left over.
  const count = BigInt(participants.length);
  const base = amountMinor / count;
  const parts = participants.map(() => base);
  return settle(participants, parts, amountMinor - base * count);
}

/** Applies the remainder to the first participant and produces the shares in the order given. */
function settle(participants: SplitInput[], parts: bigint[], remainderMinor: bigint): SplitResult {
  const first = participants[0];
  const shares = participants.map((participant, index) => ({
    memberId: participant.memberId,
    amountMinor: parts[index] + (index === 0 ? remainderMinor : 0n),
  }));

  return {
    ok: true,
    shares,
    remainderMinor,
    remainderMemberId: remainderMinor === 0n ? null : (first?.memberId ?? null),
  };
}

/** One sentence per refusal, in the group's currency, naming what is off and by how much. */
export function splitRefusalMessage(refusal: SplitRefusal, currency: string): string {
  switch (refusal.code) {
    case 'no-participants':
      return 'Choose at least one member to split this expense between.';
    case 'shares-sum-zero':
      return 'Give at least one member a share above zero.';
    case 'exact-mismatch': {
      const gap = refusal.differenceMinor < 0n ? -refusal.differenceMinor : refusal.differenceMinor;
      const direction = refusal.differenceMinor < 0n ? 'short of' : 'over';
      return `Exact amounts add up to ${formatMinor(refusal.sumMinor, currency)} — ${formatMinor(gap, currency)} ${direction} the total.`;
    }
    case 'percentage-mismatch': {
      // Both figures are stated as magnitudes with the direction in words: a percentage that
      // overshoots assigns MORE than the total, and "-€2.00 unassigned" reads as a discount
      // rather than as an excess.
      const short = refusal.differenceHundredths < 0n;
      const gap = short ? -refusal.differenceHundredths : refusal.differenceHundredths;
      const money = refusal.unassignedMinor < 0n ? -refusal.unassignedMinor : refusal.unassignedMinor;
      return `Percentages add up to ${formatPercent(refusal.sumHundredths)} — ${formatPercent(gap)} ${
        short ? 'short of' : 'over'
      } 100%, leaving ${formatMinor(money, currency)} ${short ? 'unassigned' : 'more than the total assigned'}.`;
    }
  }
}
