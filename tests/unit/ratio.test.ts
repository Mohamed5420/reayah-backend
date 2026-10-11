import { describe, expect, it } from 'vitest';
import { ratio } from '../../src/utils/ratio';

describe('ratio', () => {
  it('is a 0–1 fraction with three decimals, null when there is nothing to divide by', () => {
    expect(ratio(2, 31)).toBe(0.065);
    expect(ratio(1, 3)).toBe(0.333);
    expect(ratio(4, 4)).toBe(1);
    expect(ratio(0, 5)).toBe(0);
    expect(ratio(0, 0)).toBeNull();
  });
});
