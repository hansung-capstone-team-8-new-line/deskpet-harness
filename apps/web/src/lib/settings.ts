import { useCallback, useState } from 'react';

/**
 * 화면 설정 (D-48). 이 브라우저에만 저장한다 (localStorage). 저장이 막힌 환경이면 이 탭에서만 유지된다.
 * 관리 토큰은 여기에 두지 않는다 (sessionStorage, 탭을 닫으면 지워짐).
 */
export interface Settings {
  /** 작업 목록에서 완료·취소 작업 숨기기 */
  hideFinished: boolean;
  /** 처음 보이는 화면 */
  startTab: 'tasks' | 'history';
  /** 웹에서 업데이트한 뒤 서버가 새 버전으로 다시 켜지면 화면도 자동으로 새로 고침 */
  autoReload: boolean;
}

export const DEFAULT_SETTINGS: Settings = { hideFinished: false, startTab: 'tasks', autoReload: true };
const KEY = 'deskpet.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      hideFinished: typeof s.hideFinished === 'boolean' ? s.hideFinished : DEFAULT_SETTINGS.hideFinished,
      startTab: s.startTab === 'history' ? 'history' : 'tasks',
      autoReload: typeof s.autoReload === 'boolean' ? s.autoReload : DEFAULT_SETTINGS.autoReload,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings(): [Settings, (p: Partial<Settings>) => void] {
  const [s, setS] = useState(loadSettings);
  const update = useCallback((p: Partial<Settings>) => {
    setS((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* 저장이 막혀도 이 탭에서는 적용된다 */
      }
      return next;
    });
  }, []);
  return [s, update];
}

// ------------------------------------------------------------- 연결 정보
const CONN_KEY = 'deskpet.viewer';

export interface SavedConnection {
  url: string;
  token: string;
  /** true면 localStorage(이 브라우저에 기억), 아니면 sessionStorage(탭을 닫으면 지워짐) */
  remember?: boolean;
}

export function loadConnection(): SavedConnection | null {
  for (const store of [() => sessionStorage, () => localStorage]) {
    try {
      const raw = store().getItem(CONN_KEY);
      if (raw) return JSON.parse(raw) as SavedConnection;
    } catch {
      /* 다음 저장소 */
    }
  }
  return null;
}

export function saveConnection(c: SavedConnection) {
  clearConnection();
  try {
    (c.remember ? localStorage : sessionStorage).setItem(CONN_KEY, JSON.stringify(c));
  } catch {
    /* 저장 실패해도 이 탭에서는 연결된다 */
  }
}

export function clearConnection() {
  for (const store of [() => sessionStorage, () => localStorage]) {
    try {
      store().removeItem(CONN_KEY);
    } catch {
      /* 무시 */
    }
  }
}

// ------------------------------------------------------------- 관리 토큰
const ADMIN_KEY = 'deskpet.admin';

export function loadAdminToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAdminToken(t: string) {
  try {
    if (t) sessionStorage.setItem(ADMIN_KEY, t);
    else sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    /* 이 탭 메모리에만 */
  }
}
