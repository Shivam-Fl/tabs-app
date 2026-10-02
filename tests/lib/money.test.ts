import { describe, expect, it } from 'vitest';

import { formatMinor } from '@/lib/money';

/**
 * The form pinned by EXECUTION, not by eye.
 *
 * `new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(0)` returns
 * '€0.00' — the symbol, which is Intl's default display. Only `currencyDisplay: 'code'` returns
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
