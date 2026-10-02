import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { expenseSplitTypes } from '@/db/schema';
import {
  currencySymbol,
  formatMinor,
  formatPercent,
  parseMajorUnits,
  parsePercent,
  split,
  splitRefusalMessage,
} from '@/lib/money';
import type { SplitInput, SplitResult } from '@/lib/money';

/**
 * The form pinned by EXECUTION, not by eye.
 *
 * `new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(0)` returns
 * '€0.00' — the symbol, which Intl's default display. Only `currencyDisplay: 'code'` returns
 * the ISO-code form, and TR-23 requires the symbol, so the ISO-code form is the regression these
 * cases exist to catch: adding that option back fails every one of them.
 */
describe('formatMinor', () => {
  it('renders a EUR zero with the currency symbol, not the ISO code', () => {
    expect(formatMinor(0n, 'EUR')).toBe('€0.00');
  });

  it('renders a positive and a negative amount from minor units, without a float', () => {
    expect(formatMinor(1234n, 'EUR')).toBe('€12.34');
    expect(formatMinor(-1234n, 'EUR')).toBe('-€12.34');
    // 42000 minor units is ₹420.00 — docs/ui.md's own example amount, in its own currency.
    expect(formatMinor(42000n, 'INR')).toBe('₹420.00');
  });

  it('renders JPY with no fraction digits, because the currency has none', () => {
    expect(formatMinor(0n, 'JPY')).toBe('¥0');
    expect(formatMinor(1234n, 'JPY')).toBe('¥1,234');
  });

  it('renders BHD with three fraction digits', () => {
    const digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'BHD' }).resolvedOptions()
      .maximumFractionDigits;
    expect(digits).toBe(3);

    const formatted = formatMinor(1234567n, 'BHD');
    // Not a byte-exact full string: BHD's default display is its CODE rather than a glyph, and
    // the separator between code and digits is a non-breaking space whose exact codepoint is
    // Intl's business, not this module's.
    expect(formatted.endsWith('1,234.567')).toBe(true);
    expect(formatMinor(0n, 'BHD').endsWith('0.000')).toBe(true);
  });

  it('is exact above Number.MAX_SAFE_INT, where dividing by 100 as a float is not', () => {
    const minor = 123456789012345678n;
    expect(minor > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    expect(formatMinor(minor, 'EUR')).toBe('€1,234,567,890,123,456.78');

    // The float route, stated so the difference is not a matter of opinion: Number() rounds the
    // bigint to 123456789012345680 and the last two digits come out as .80.
    const asFloat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(
      Number(minor) / 100,
    );
    expect(asFloat).toBe('€1,234,567,890,123,456.80');
    expect(formatMinor(minor, 'EUR')).not.toBe(asFloat);
  });
});

/**
 * The symbol the amount field shows fixed beside it. It is read from the same Intl the
 * formatter reads, so the symbol a person types against cannot disagree with the one their
 * amount is later rendered with — which is the only way that prefix is worth having.
 */
describe('currencySymbol', () => {
  it('is the symbol the formatter prints, not the ISO code', () => {
    for (const [currency, symbol] of [
      ['EUR', '€'],
      ['USD', '$'],
      ['INR', '₹'],
      ['JPY', '¥'],
    ] as const) {
      expect(currencySymbol(currency)).toBe(symbol);
      expect(formatMinor(1234n, currency).startsWith(symbol)).toBe(true);
    }
  });

  it('falls back to the code itself for a currency Intl has no symbol for', () => {
    // A three-letter code Intl does not know formats as the code; the prefix has to survive it
    // rather than render as an empty box.
    expect(currencySymbol('XYZ')).toBe('XYZ');
  });
});

/**
 * TR-2's first clause: an amount is an integer count of minor units from the boundary inward.
 * Everything here is about NOT letting a typed string become a float, and about refusing
 * anything ambiguous rather than guessing what it meant.
 */
describe('parseMajorUnits', () => {
  it('scales by the currency’s own fraction digits', () => {
    expect(parseMajorUnits('12.34', 'EUR')).toEqual({ ok: true, minor: 1234n });
    expect(parseMajorUnits('12', 'EUR')).toEqual({ ok: true, minor: 1200n });
    expect(parseMajorUnits('0.05', 'EUR')).toEqual({ ok: true, minor: 5n });
    expect(parseMajorUnits('.5', 'EUR')).toEqual({ ok: true, minor: 50n });
    expect(parseMajorUnits('7.', 'EUR')).toEqual({ ok: true, minor: 700n });
  });

  it('round-trips JPY with no fraction digits and BHD with three', () => {
    // '1234' is ¥1,234 — the same string is €12.34, so the currency, not the string, decides.
    expect(parseMajorUnits('1234', 'JPY')).toEqual({ ok: true, minor: 1234n });
    expect(formatMinor(1234n, 'JPY')).toBe('¥1,234');

    expect(parseMajorUnits('1.234', 'BHD')).toEqual({ ok: true, minor: 1234n });
    expect(formatMinor(1234n, 'BHD').endsWith('1.234')).toBe(true);
  });

  it('rejects a fraction longer than the currency has room for, naming the limit', () => {
    const euros = parseMajorUnits('12.345', 'EUR');
    expect(euros.ok).toBe(false);
    expect(euros.ok ? '' : euros.message).toBe('Use at most 2 decimal places.');

    // JPY has none, and says so in its own terms rather than as "at most 0 decimal places".
    const yen = parseMajorUnits('12.5', 'JPY');
    expect(yen.ok).toBe(false);
    expect(yen.ok ? '' : yen.message).toBe('This one is counted in whole units, with no decimal places.');
  });

  it('refuses separators, signs, other digit sets and empty input, each naming what is off', () => {
    const refusal = (text: string) => {
      const parsed = parseMajorUnits(text, 'EUR');
      return parsed.ok ? null : parsed.refusal;
    };

    expect(refusal('1,234')).toBe('grouping-separators');
    expect(refusal('1 234')).toBe('grouping-separators');
    // A non-breaking space, which is what a copied-and-pasted amount actually arrives with.
    expect(refusal('1 234')).toBe('grouping-separators');
    expect(refusal('1 234')).toBe('grouping-separators');

    expect(refusal('-5')).toBe('signed');
    expect(refusal('+5')).toBe('signed');

    // Arabic-Indic and fullwidth digits are digits, but not the nine this app writes down.
    expect(refusal('١٢٣')).toBe('non-ascii-digits');
    expect(refusal('１２３')).toBe('non-ascii-digits');
    // A letter that merely looks like one is not a digit at all, and says so differently.
    expect(refusal('12e5')).toBe('not-a-number');

    expect(refusal('')).toBe('empty');
    expect(refusal('   ')).toBe('empty');
  });

  it('never round-trips through Number above MAX_SAFE_INTEGER', () => {
    const huge = '123456789012345678901234567890.12';
    const parsed = parseMajorUnits(huge, 'EUR');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.minor : 0n).toBe(123456789012345678901234567890n * 100n + 12n);

    // The float route loses the last digits; the parse does not, and the formatter prints the
    // parsed value back exactly.
    const throughNumber = BigInt(Math.round(Number(huge) * 100));
    expect(throughNumber).not.toBe(parsed.ok ? parsed.minor : 0n);
    expect(formatMinor(parsed.ok ? parsed.minor : 0n, 'EUR')).toBe(
      '€123,456,789,012,345,678,901,234,567,890.12',
    );
  });
});

describe('parsePercent', () => {
  it('reads a percentage as hundredths of a percent', () => {
    expect(parsePercent('33.33')).toEqual({ ok: true, minor: 3333n });
    expect(parsePercent('100')).toEqual({ ok: true, minor: 10000n });
    expect(parsePercent('0')).toEqual({ ok: true, minor: 0n });
  });

  it('refuses a third decimal place rather than rounding it', () => {
    const parsed = parsePercent('33.333');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toBe('Use at most 2 decimal places.');
  });

  it('formats hundredths back the way they were typed', () => {
    expect(formatPercent(3333n)).toBe('33.33%');
    expect(formatPercent(10000n)).toBe('100.00%');
    expect(formatPercent(5n)).toBe('0.05%');
  });
});

/**
 * The floor-division remainder rule, TR-3, pinned by naming the exact member who receives it.
 * These are the cases a reader can check by hand: one unit between three people, seven between
 * four.
 */
describe('split', () => {
  const member = (memberId: string, value: bigint | null = null): SplitInput => ({ memberId, value });

  /** Fails the test with the refusal's code rather than with a confusing destructure of null. */
  function sharesOf(result: SplitResult): bigint[] {
    if (!result.ok) throw new Error(`split refused: ${result.refusal.code}`);
    return result.shares.map((share) => share.amountMinor);
  }

  it('gives one indivisible unit to the first member of three', () => {
    const result = split(1n, 'equal', [member('a'), member('b'), member('c')]);
    expect(sharesOf(result)).toEqual([1n, 0n, 0n]);
    if (!result.ok) throw new Error('refused');
    expect(result.remainderMinor).toBe(1n);
    expect(result.remainderMemberId).toBe('a');
  });

  it('gives the whole remainder to the first member of four, not one unit each', () => {
    const result = split(7n, 'equal', [member('a'), member('b'), member('c'), member('d')]);
    expect(sharesOf(result)).toEqual([4n, 1n, 1n, 1n]);
    if (!result.ok) throw new Error('refused');
    expect(result.remainderMinor).toBe(3n);
    expect(result.remainderMemberId).toBe('a');
  });

  it('gives a single participant the whole amount and no remainder', () => {
    const result = split(1000n, 'equal', [member('a')]);
    expect(sharesOf(result)).toEqual([1000n]);
    if (!result.ok) throw new Error('refused');
    expect(result.remainderMinor).toBe(0n);
    expect(result.remainderMemberId).toBeNull();
  });

  it('follows the order it was given, which is the caller’s canonical member order', () => {
    // Same amount, same members, different order: the remainder moves with the order, which is
    // why the server derives it from readMembers rather than from what the form submitted.
    const result = split(7n, 'equal', [member('d'), member('a'), member('b'), member('c')]);
    expect(sharesOf(result)).toEqual([4n, 1n, 1n, 1n]);
    if (!result.ok) throw new Error('refused');
    expect(result.remainderMemberId).toBe('d');
  });

  it('splits by exact amounts when they add up, and refuses when they do not', () => {
    const ok = split(1000n, 'exact', [member('a', 400n), member('b', 600n)]);
    expect(sharesOf(ok)).toEqual([400n, 600n]);

    const short = split(1000n, 'exact', [member('a', 400n), member('b', 300n)]);
    expect(short.ok).toBe(false);
    if (short.ok || short.refusal.code !== 'exact-mismatch') throw new Error('expected an exact-mismatch');
    expect(short.refusal.sumMinor).toBe(700n);
    expect(short.refusal.differenceMinor).toBe(-300n);
    // 400 + 300 is 700 MINOR units, which is ₹7.00: the sentence names the shortfall in minor
    // units and the currency they are minor units of.
    expect(splitRefusalMessage(short.refusal, 'INR')).toBe(
      'Exact amounts add up to ₹7.00 — ₹3.00 short of the total.',
    );

    const over = split(1000n, 'exact', [member('a', 1400n)]);
    if (over.ok || over.refusal.code !== 'exact-mismatch') throw new Error('expected an exact-mismatch');
    expect(over.refusal.differenceMinor).toBe(400n);
    expect(splitRefusalMessage(over.refusal, 'EUR')).toBe(
      'Exact amounts add up to €14.00 — €4.00 over the total.',
    );
  });

  it('splits by percentage when they reach 100, refusing with the unassigned money named', () => {
    const ok = split(1000n, 'percentage', [member('a', 3333n), member('b', 3333n), member('c', 3334n)]);
    // 333.3, 333.3 and 333.4 all floor to 333, and the one unit left over goes to the first.
    expect(sharesOf(ok)).toEqual([334n, 333n, 333n]);

    const short = split(1000n, 'percentage', [member('a', 3333n)]);
    if (short.ok || short.refusal.code !== 'percentage-mismatch') {
      throw new Error('expected a percentage-mismatch');
    }
    expect(short.refusal.sumHundredths).toBe(3333n);
    expect(short.refusal.differenceHundredths).toBe(-6667n);
    expect(short.refusal.unassignedMinor).toBe(666n);
    expect(splitRefusalMessage(short.refusal, 'EUR')).toBe(
      'Percentages add up to 33.33% — 66.67% short of 100%, leaving €6.66 unassigned.',
    );

    const over = split(1000n, 'percentage', [member('a', 12000n)]);
    if (over.ok || over.refusal.code !== 'percentage-mismatch') {
      throw new Error('expected a percentage-mismatch');
    }
    expect(over.refusal.differenceHundredths).toBe(2000n);
    // Over 100% assigns more than the total, and the sentence says so in those terms rather than
    // as a negative amount "unassigned".
    expect(splitRefusalMessage(over.refusal, 'EUR')).toBe(
      'Percentages add up to 120.00% — 20.00% over 100%, leaving €2.00 more than the total assigned.',
    );
  });

  it('splits by shares, and refuses a set of shares that is all zeroes', () => {
    const ok = split(1000n, 'shares', [member('a', 1n), member('b', 2n), member('c', 7n)]);
    expect(sharesOf(ok)).toEqual([100n, 200n, 700n]);

    const uneven = split(10n, 'shares', [member('a', 1n), member('b', 1n), member('c', 1n)]);
    expect(sharesOf(uneven)).toEqual([4n, 3n, 3n]);

    const none = split(1000n, 'shares', [member('a', 0n), member('b', 0n)]);
    if (none.ok || none.refusal.code !== 'shares-sum-zero') throw new Error('expected a shares-sum-zero');
    expect(splitRefusalMessage(none.refusal, 'EUR')).toBe('Give at least one member a share above zero.');
  });

  it('reads a null value as zero for the three types that take a number', () => {
    // A member left blank takes no part: for exact, that is a zero part, and the sum then has to
    // come from the others.
    const exact = split(1000n, 'exact', [member('a', 1000n), member('b')]);
    expect(sharesOf(exact)).toEqual([1000n, 0n]);

    // For shares, a blank member is not a participant in the division at all.
    const shares = split(1000n, 'shares', [member('a', 1n), member('b')]);
    expect(sharesOf(shares)).toEqual([1000n, 0n]);
  });

  it('refuses an empty participant list rather than dividing by zero', () => {
    const result = split(1000n, 'equal', []);
    if (result.ok || result.refusal.code !== 'no-participants') throw new Error('expected no-participants');
    expect(splitRefusalMessage(result.refusal, 'EUR')).toBe(
      'Choose at least one member to split this expense between.',
    );
  });
});

/**
 * AC-15. Ten thousand random expenses per type, with the split checked against the arithmetic
 * written out longhand here — floor each part, hand the whole leftover to the first — rather
 * than against split() itself, which would prove only that it equals itself.
 *
 * Seeded, so a failure names a case that can be re-run rather than one that has to be hunted.
 */
describe('the split invariant, over 10,000 random expenses', () => {
  /** mulberry32: small, deterministic, and good enough to spread totals across the range. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('sums exactly to the total, for every type, and puts the remainder on the first member', () => {
    const next = random(20261002);
    const failures: string[] = [];
    let accepted = 0;

    for (let i = 0; i < 10_000; i += 1) {
      const total = BigInt(1 + Math.floor(next() * 10_000_000));
      const count = 1 + Math.floor(next() * 8);
      const type = expenseSplitTypes[Math.floor(next() * expenseSplitTypes.length)] ?? 'equal';
      const participants: SplitInput[] = Array.from({ length: count }, (_, index) => ({
        memberId: `member-${index}`,
        value: null,
      }));

      // The parts this test expects, computed here rather than read back from split().
      let expected: bigint[];
      let weights: bigint[];
      let basis: bigint;

      if (type === 'equal') {
        const base = total / BigInt(count);
        expected = Array.from({ length: count }, () => base);
        weights = [];
        basis = 0n;
      } else if (type === 'exact') {
        // Cut points along the total, so the parts sum to it exactly by construction.
        const cuts = Array.from({ length: count - 1 }, () => Math.floor(next() * (Number(total) + 1))).sort(
          (left, right) => left - right,
        );
        const bounds = [0, ...cuts, Number(total)];
        expected = bounds.slice(1).map((value, index) => BigInt(value - (bounds[index] ?? 0)));
        weights = [];
        basis = 0n;
        expected.forEach((part, index) => {
          const participant = participants[index];
          if (participant) participant.value = part;
        });
      } else {
        // Cut points along 100 (as hundredths) or along a small count, so the weights are
        // whole numbers that add up to the basis.
        basis = type === 'percentage' ? 10_000n : BigInt(2 + Math.floor(next() * 12));
        const cuts = Array.from({ length: count - 1 }, () => Math.floor(next() * (Number(basis) + 1))).sort(
          (left, right) => left - right,
        );
        const bounds = [0, ...cuts, Number(basis)];
        weights = bounds.slice(1).map((value, index) => BigInt(value - (bounds[index] ?? 0)));
        // A shares split needs at least one non-zero count, or it is refused — which is a case
        // of its own, asserted by name below, so the property loop keeps the accepted path.
        let anyShare = false;
        for (const weight of weights) if (weight !== 0n) anyShare = true;
        if (type === 'shares' && !anyShare) weights[0] = 1n;
        weights.forEach((weight, index) => {
          const participant = participants[index];
          if (participant) participant.value = weight;
        });
        expected = weights.map((weight) => (total * weight) / basis);
      }

      const remainder = total - expected.reduce((sum, part) => sum + part, 0n);
      const result = split(total, type, participants);

      if (!result.ok) {
        failures.push(`#${i} ${type} ${count} members, ${total}: refused with ${result.refusal.code}`);
        continue;
      }

      accepted += 1;
      const got = result.shares.map((share) => share.amountMinor);
      const want = expected.map((part, index) => part + (index === 0 ? remainder : 0n));

      if (got.join(',') !== want.join(',')) {
        failures.push(
          `#${i} ${type} ${count} members, ${total}: got [${got.join(', ')}] want [${want.join(', ')}]`,
        );
      }
      if (result.remainderMinor !== remainder) {
        failures.push(`#${i} ${type}: remainder ${result.remainderMinor} want ${remainder}`);
      }
      if (remainder < 0n || remainder >= BigInt(count)) {
        failures.push(`#${i} ${type} ${count} members: remainder ${remainder} outside 0..${count - 1}`);
      }
      if (result.remainderMemberId !== (remainder === 0n ? null : 'member-0')) {
        failures.push(
          `#${i} ${type}: remainder member ${result.remainderMemberId} want ${remainder === 0n ? null : 'member-0'}`,
        );
      }
    }

    // Five is enough to see the shape of a failure without printing ten thousand lines.
    expect(failures.slice(0, 5)).toEqual([]);
    expect(accepted).toBe(10_000);
  });
});

/**
 * AC-9's second half: the split is a WRITE-path idea. Once an expense is stored, its shares are
 * read from expense_share and nothing re-derives them, so a later change to the rounding rule
 * cannot restate what people already owed (TR-4). This is the guard that keeps it that way: a
 * module on the read path importing split() is the first step towards computing a balance
 * instead of reading one, and it is a compile-green change that no behavioural test would catch.
 */
describe('the read path never splits', () => {
  const readPath = [
    // Where a balance is computed as a literal, and where every member-scoped read lives.
    'src/lib/access.ts',
    // The three screens that render a balance or a group's totals.
    'src/components/group-overview.tsx',
    'src/components/members-screen.tsx',
    'src/components/group-list.tsx',
  ];

  /** The names a file imports from @/lib/money, whether the import is one line or several. */
  function moneyImports(source: string): string[] {
    const names: string[] = [];
    for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@\/lib\/money'/g)) {
      for (const raw of (match[1] ?? '').split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        if (name) names.push(name);
      }
    }
    return names;
  }

  it('names files that exist, so the scan cannot pass by finding nothing', () => {
    for (const relative of readPath) {
      const source = readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
      expect(source.length).toBeGreaterThan(0);
    }
  });

  it('imports formatMinor and nothing that divides an amount', () => {
    for (const relative of readPath) {
      const source = readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
      const imported = moneyImports(source);

      expect(imported, `${relative} imports split()`).not.toContain('split');
      expect(imported, `${relative} imports parseMajorUnits()`).not.toContain('parseMajorUnits');
      expect(imported, `${relative} imports parsePercent()`).not.toContain('parsePercent');
      expect(imported, `${relative} imports parseDecimal()`).not.toContain('parseDecimal');
    }
  });

  it('is not vacuous: the write path does import split, and the scan would find it', () => {
    // If moneyImports() matched nothing at all, every assertion above would pass on any file.
    const action = readFileSync(
      fileURLToPath(new URL('../../src/app/actions/expenses.ts', import.meta.url)),
      'utf8',
    );
    expect(moneyImports(action)).toContain('split');
  });
});

/**
 * TR-2's second clause, made the compiler's job rather than a reviewer's. The function is never
 * called: it exists so `tsc --noEmit` — which runs before the suite — is what fails if money
 * ever loosens to a number.
 */
export function moneyIsNotANumber(): void {
  // @ts-expect-error a number is not assignable to a money bigint
  const minor: bigint = 12.34;
  // @ts-expect-error formatMinor takes minor units as a bigint, never a major-unit number
  formatMinor(1234, 'EUR');
  void minor;
}

describe('money at the type level', () => {
  it('has a number-to-bigint probe for tsc, whether or not anything calls it', () => {
    // The probe above is the assertion; this only keeps it referenced from a test file, so a
    // future cleanup that deletes "unused" exports has to delete this too.
    expect(moneyIsNotANumber).toBeTypeOf('function');
  });
});
