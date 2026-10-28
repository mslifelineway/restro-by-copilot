import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT, Pagination } from '@rms/shared';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(PAGINATION_MAX_LIMIT) limit: number = PAGINATION_DEFAULT_LIMIT;
  get offset() { return (this.page - 1) * this.limit; }
}

/** Return this from a handler to get `data: items` plus `meta.pagination` in the envelope. */
export class Page<T> {
  constructor(readonly items: T[], readonly totalItems: number, readonly page: number, readonly limit: number) {}

  get pagination(): Pagination {
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.limit));
    return {
      page: this.page, limit: this.limit, totalItems: this.totalItems, totalPages,
      hasNextPage: this.page < totalPages, hasPreviousPage: this.page > 1,
    };
  }
}
