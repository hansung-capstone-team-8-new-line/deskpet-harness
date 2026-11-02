import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ConnectForm({ initialUrl, error, onConnect }: { initialUrl: string; error?: string; onConnect: (url: string, token: string) => void }) {
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState('');
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-xl font-semibold">작업 상태</h1>
      <p className="mt-1 text-sm text-muted-foreground">Harness 서버에 보기 전용으로 연결합니다.</p>
      <form
        className="mt-8 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && token.trim()) onConnect(url.trim(), token.trim());
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor="ws-url" className="text-sm font-medium">
            서버 주소
          </label>
          <Input id="ws-url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ws-token" className="text-sm font-medium">
            보기 전용 토큰
          </label>
          <Input id="ws-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" aria-describedby="ws-token-help" />
          <p id="ws-token-help" className="text-xs text-muted-foreground">
            .env의 HARNESS_WS_VIEWER_TOKEN 값입니다. 이 탭을 닫으면 지워집니다.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!url.trim() || !token.trim()}>
          연결
        </Button>
      </form>
    </main>
  );
}
