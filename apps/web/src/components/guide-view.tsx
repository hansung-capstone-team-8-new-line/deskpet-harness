import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ConnView, HarnessConnection } from '@/lib/connection';
import { adminMessage } from '@/components/settings-view';

/**
 * Guide 탭 (D-61). Guide마다 코드의 기본 지시문(수정 불가)과 사용자 추가 규칙(웹에서 수정)을 보여 준다.
 * 사용자 규칙은 지시문 끝에 [사용자 추가 규칙 (웹 설정)]으로 붙는다 — 공통('*') 먼저, 그다음 이 Guide.
 * 가드·권한 확인·Fast-Path는 코드 그대로
 */
const USER_HEADER = '[사용자 추가 규칙 (웹 설정)]';

/** 텍스트 칸의 줄 → 규칙 목록 */
export const toRules = (text: string) =>
  text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** 지시문 끝에 붙는 부분 (서버 BaseMcpGuide와 같은 형식) */
export function userRulesBlock(rules: string[]): string {
  return rules.length ? [USER_HEADER, ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n') : '';
}

export function GuideView({ conn, view }: { conn: HarnessConnection; view: ConnView }) {
  const guides = view.info?.guides;
  const saved = view.info?.settings?.guideRules ?? {};
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string>();
  const [msg, setMsg] = useState<{ id: string; text: string }>();

  if (!guides) return <p className="mt-5 rounded-md border border-dashed p-4 text-sm text-muted-foreground">Guide 정보 없음 (서버 정보 받는 중 또는 미지원 서버)</p>;

  // 공통('*')을 맨 위로
  const list = [...guides].sort((a, b) => Number(b.mcpId === '*') - Number(a.mcpId === '*'));
  const textOf = (id: string) => drafts[id] ?? (saved[id] ?? []).join('\n');
  const commonRules = toRules(textOf('*'));

  return (
    <div className="mt-5 grid max-w-4xl gap-6">
      <section className="rounded-md border p-4 text-sm">
        <h2 className="text-base font-semibold">Guide 지시문 형식</h2>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>LLM Worker 지시문 = 코드 기본 지시문 + 사용자 추가 규칙</li>
          <li>사용자 추가 규칙: 한 줄에 하나, 지시문 끝에 번호 붙여 추가 (공통 → 각 Guide 순)</li>
          <li>가드·승인 전 확인·Fast-Path 도구: 코드 고정, 여기서 변경 불가</li>
          <li>Guide당 최대 30개, 한 줄 최대 500자. 저장 즉시 다음 요청부터 적용</li>
        </ul>
        <pre className="mt-3 overflow-auto rounded border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap">
          {[
            '당신은 … 자율 실행 Worker입니다.',
            '담당 MCP 서버: <Guide>',
            '역할: <Guide 설명>',
            '',
            '[Guide 명시 규칙]          ← 코드',
            '1. …',
            '',
            '[MCP 도구 / Fast-Path 도구]  ← 실행 시 채움',
            '[참고 팀 문서]              ← 위키 검색 시',
            '',
            '[자율 실행 원칙]            ← 코드',
            '- …',
            '',
            `${USER_HEADER}  ← 여기서 추가`,
            '1. 공통 규칙',
            '2. 이 Guide 규칙',
          ].join('\n')}
        </pre>
      </section>

      {list.map((g) => {
        const id = g.mcpId;
        const isCommon = id === '*';
        const current = (saved[id] ?? []).join('\n');
        const text = textOf(id);
        const own = toRules(text);
        const dirty = drafts[id] !== undefined && own.join('\n') !== current;
        // 이 Guide 지시문에 실제로 붙는 규칙: 공통 + 이 Guide (공통 칸은 공통만)
        const applied = isCommon ? own : [...commonRules, ...own];
        return (
          <section key={id} aria-labelledby={`guide-h-${id}`} className="rounded-md border p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 id={`guide-h-${id}`} className="text-base font-semibold">
                {isCommon ? '공통 (모든 Guide)' : id}
              </h2>
              <Badge variant="neutral">{isCommon ? `범용 Guide ${g.version}` : g.version}</Badge>
              {dirty && <Badge variant="outline">저장 안 됨</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{isCommon ? '모든 Guide 지시문에 추가. 맞는 Guide 없는 MCP는 범용 Guide 사용' : g.description}</p>

            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">기본 지시문 (코드, 수정 불가)</summary>
              {g.defaultPrompt ? (
                <pre className="mt-2 max-h-80 overflow-auto rounded border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap">{g.defaultPrompt}</pre>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">미리보기 없음</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">요청 목표·문맥·도구 목록은 예시 값. 실제 실행 시 채움</p>
            </details>

            <label htmlFor={`guide-${id}`} className="mt-3 block text-sm font-medium">
              추가 규칙
            </label>
            <textarea
              id={`guide-${id}`}
              rows={Math.min(10, Math.max(3, text.split('\n').length + 1))}
              value={text}
              onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })}
              placeholder={isCommon ? '예: 답변은 한국어 존댓말로 짧게 한다' : '한 줄에 규칙 하나'}
              spellCheck={false}
              className="mt-1.5 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />

            {applied.length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-muted-foreground">지시문 끝에 붙는 부분{isCommon ? '' : ' (공통 포함)'}</p>
                <pre className="mt-1 overflow-auto rounded border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap">{userRulesBlock(applied)}</pre>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!dirty || saving === id || view.state !== 'connected'}
                onClick={() => {
                  setSaving(id);
                  void conn
                    .saveSettings({ guideRules: { [id]: own } })
                    .then((r) => {
                      setMsg({ id, text: r.ok ? r.message : adminMessage(r.message) });
                      if (r.ok) {
                        const next = { ...drafts };
                        delete next[id];
                        setDrafts(next);
                      }
                    })
                    .finally(() => setSaving(undefined));
                }}
              >
                {saving === id ? '저장 중' : '저장'}
              </Button>
              {dirty && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const next = { ...drafts };
                    delete next[id];
                    setDrafts(next);
                  }}
                >
                  되돌리기
                </Button>
              )}
              <span className="text-xs text-muted-foreground">{own.length}개</span>
              {msg?.id === id && (
                <span role="status" className="text-xs text-muted-foreground">
                  {msg.text}
                </span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
