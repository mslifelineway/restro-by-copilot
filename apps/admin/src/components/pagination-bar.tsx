import type { Pagination } from '@rms/shared';
import { Button } from './ui/button';

export function PaginationBar({ p, onPage }: { p: Pagination; onPage: (n: number) => void }) {
  return (
    <div className="flex items-center justify-between border-t px-4 py-2 text-sm text-muted-foreground">
      <span>{p.totalItems} total · page {p.page} of {p.totalPages}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!p.hasPreviousPage} onClick={() => onPage(p.page - 1)}>Previous</Button>
        <Button variant="outline" size="sm" disabled={!p.hasNextPage} onClick={() => onPage(p.page + 1)}>Next</Button>
      </div>
    </div>
  );
}
