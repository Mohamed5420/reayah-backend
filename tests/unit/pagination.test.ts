import { describe, expect, it } from 'vitest';
import { buildPaginationMeta, parsePagination } from '../../src/utils/response/pagination';

describe('parsePagination', () => {
  it('defaults to page 1, 20 per page', () => {
    expect(parsePagination({})).toEqual({ page: 1, perPage: 20, skip: 0 });
  });

  it('caps per_page at 100 and computes skip', () => {
    expect(parsePagination({ page: '3', per_page: '500' })).toEqual({ page: 3, perPage: 100, skip: 200 });
  });

  it('falls back on garbage', () => {
    expect(parsePagination({ page: 'abc', per_page: '-4' })).toEqual({ page: 1, perPage: 1, skip: 0 });
  });
});

describe('buildPaginationMeta', () => {
  it('matches the spec shape', () => {
    expect(buildPaginationMeta({ page: 1, perPage: 20, skip: 0 }, 134)).toEqual({
      page: 1,
      per_page: 20,
      total: 134,
      last_page: 7,
    });
  });

  it('reports last_page 1 for an empty list', () => {
    expect(buildPaginationMeta({ page: 1, perPage: 20, skip: 0 }, 0).last_page).toBe(1);
  });
});
