/**
 * DeskPet 대체 필수 검사 목록 파서 (README D-13).
 * 형식: "owner/repo=test,lint;owner2/repo2=build"
 * GitHub가 요금제상 보호 기능을 제공하지 않을 때(plan_unsupported)만 쓰인다.
 */
export function parseRequiredChecksFallback(raw: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of (raw ?? '').split(';')) {
    const [repo, checks] = entry.split('=');
    const key = repo?.trim();
    if (!key || !/^[^/\s]+\/[^/\s]+$/.test(key)) continue;
    const names = (checks ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length) out[key] = names;
  }
  return out;
}
