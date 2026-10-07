type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

export type CamelizeKeys<T> = { [K in keyof T as K extends string ? CamelCase<K> : K]: T[K] };

/** Shallow snake_case → camelCase key conversion for API input → model fields (`name_ar` → `nameAr`). */
export const camelizeKeys = <T extends Record<string, unknown>>(input: T): CamelizeKeys<T> =>
  Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  ) as CamelizeKeys<T>;
