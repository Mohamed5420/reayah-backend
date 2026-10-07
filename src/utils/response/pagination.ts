import type { Request } from 'express';

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

export type Pagination = { page: number; perPage: number; skip: number };

export type PaginationMeta = { page: number; per_page: number; total: number; last_page: number };

/** Reads `?page=&per_page=` (spec §7.0). Bad values fall back to defaults; `per_page` is capped at 100. */
export const parsePagination = (query: Request['query']): Pagination => {
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(Number(query.per_page)) || DEFAULT_PER_PAGE));
  return { page, perPage, skip: (page - 1) * perPage };
};

export const buildPaginationMeta = ({ page, perPage }: Pagination, total: number): PaginationMeta => ({
  page,
  per_page: perPage,
  total,
  last_page: Math.max(1, Math.ceil(total / perPage)),
});
