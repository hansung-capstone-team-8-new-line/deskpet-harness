import { StatusBadge } from '@/components/status-badge';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatTime, type Row } from '@/lib/model';

export function TaskTable({ rows, selectedId, onSelect, emptyText }: { rows: Row[]; selectedId?: string; onSelect: (id: string) => void; emptyText: string }) {
  return (
    <Table>
      <TableCaption className="sr-only">작업과 확인 질문 목록. 행에서 Enter를 누르면 상세가 열립니다.</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-28">상태</TableHead>
          <TableHead>작업</TableHead>
          <TableHead className="hidden md:table-cell">대상</TableHead>
          <TableHead className="hidden lg:table-cell">요청</TableHead>
          <TableHead className="w-44 text-right">시각</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
              {emptyText}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => {
            const selected = r.id === selectedId;
            return (
              <TableRow
                key={r.id}
                tabIndex={0}
                aria-selected={selected}
                data-state={selected ? 'selected' : undefined}
                onClick={() => onSelect(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(r.id);
                  }
                }}
                className={cn('cursor-pointer outline-none focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset')}
              >
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell>
                  <div className="font-medium">{r.title}</div>
                  {r.note && <div className="text-xs text-muted-foreground">{r.note}</div>}
                  <div className="text-xs text-muted-foreground md:hidden">{r.target}</div>
                </TableCell>
                <TableCell className="hidden md:table-cell">{r.target}</TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{r.requestId}</TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground tabular-nums">
                  {r.kind === 'question' ? <span>만료 {formatTime(r.at)}</span> : formatTime(r.at)}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
