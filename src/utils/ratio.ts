/**
 * Every rate in the API (cancellation, on-time, …) is a fraction from 0 to 1 with three decimals
 * (0.064 = 6.4%), and null when there is nothing to divide by — clients show "—", never "0%".
 */
export const ratio = (part: number, whole: number): number | null =>
  whole ? Math.round((part / whole) * 1000) / 1000 : null;
