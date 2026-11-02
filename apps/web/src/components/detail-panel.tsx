import { ChevronDownIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DISPATCH_LABEL, RECOVERY_LABEL, STATUS_HELP, formatTime, type Row } from '@/lib/model';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Expandable({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t pt-3">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2">
          {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function DetailPanel({ row, onClose }: { row: Row; onClose: () => void }) {
  const s = row.state;
  const ar = s['actionResult'] as
    | { status?: string; dispatchState?: string; error?: { provisionalCode?: string; message?: string; stage?: string; nextAction?: string }; externalRefs?: { system: string; kind: string; id: string }[] }
    | undefined;
  const followUp = s['followUp'] as { eligibility?: string; conditions?: string[] } | undefined;
  const attempts = (s['attempts'] as { dispatchState?: string }[] | undefined) ?? [];
  const dispatch = ar?.dispatchState ?? attempts[attempts.length - 1]?.dispatchState;

  return (
    <section aria-labelledby="detail-title" className="rounded-md border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="detail-title" className="text-base font-semibold">
            {row.title}
          </h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{row.target}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="상세 닫기">
          <XIcon aria-hidden />
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <StatusBadge status={row.status} />
        {row.note && <span className="text-sm text-muted-foreground">{row.note}</span>}
      </div>
      <p className="mt-2 text-sm">{STATUS_HELP[row.status]}</p>

      <dl className="mt-4 border-t pt-2">
        {row.kind === 'operation' ? (
          <>
            <Field label="전송">{dispatch ? (DISPATCH_LABEL[dispatch] ?? dispatch) : '-'}</Field>
            <Field label="결과 확인">{RECOVERY_LABEL[String(s['recovery'] ?? 'none')] ?? String(s['recovery'])}</Field>
            {followUp?.eligibility && (
              <Field label="후속 진행">
                {followUp.eligibility}
                {followUp.conditions?.length ? ` (${followUp.conditions.join(', ')})` : ''}
              </Field>
            )}
            {ar?.externalRefs?.length ? (
              <Field label="외부 기록">
                {ar.externalRefs.map((r) => (
                  <div key={`${r.system}:${r.kind}:${r.id}`}>
                    {r.system} {r.kind} {r.id}
                  </div>
                ))}
              </Field>
            ) : null}
            <Field label="요청">{row.requestId}</Field>
            <Field label="작업 ID">
              <span className="font-mono text-xs">{row.id}</span>
            </Field>
            <Field label="갱신">{formatTime(row.at)}</Field>
          </>
        ) : (
          <>
            <Field label="질문 전달">{s['questionDeliveryEvidence'] ? '전달됨' : '전달 전'}</Field>
            <Field label="만료">{formatTime(String(s['expiresAt'] ?? ''))}</Field>
            <Field label="요청">{row.requestId}</Field>
            <Field label="질문 ID">
              <span className="font-mono text-xs">{row.id}</span>
            </Field>
          </>
        )}
      </dl>

      {ar?.error && (
        <Expandable label="오류 자세히 보기">
          <dl>
            <Field label="코드">{ar.error.provisionalCode ?? '-'}</Field>
            <Field label="단계">{ar.error.stage ?? '-'}</Field>
            <Field label="메시지">{ar.error.message ?? '-'}</Field>
            <Field label="다음 조치">{ar.error.nextAction ?? '-'}</Field>
          </dl>
        </Expandable>
      )}

      <Expandable label="기술 기록 보기">
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{JSON.stringify(s, null, 2)}</pre>
        <p className="mt-1 text-xs text-muted-foreground">revision {row.revision}</p>
      </Expandable>
    </section>
  );
}
