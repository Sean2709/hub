// 오룬카 게임 로그인 페이지(/orunka/login/)의 순수 검사 함수 — node 로 단위 시험한다(scripts/test-orunka-login.mjs).
// 계약: OrunkaUnity/tools/cloud/README.md — cb 는 127.0.0.1 임시 수신(맥·윈도우) 또는 orunka://auth(iPhone)만.
export function validCb(cb: string | null): boolean {
  if (!cb) return false;
  if (cb === 'orunka://auth') return true;
  const m = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/[A-Za-z0-9/_-]*$/.exec(cb);
  if (!m) return false;
  const port = +m[1];
  return port >= 1024 && port <= 65535;
}

export function validState(s: string | null): boolean {
  return !!s && /^[A-Za-z0-9_-]{8,128}$/.test(s);
}

/** 받는 쪽으로 돌려보낼 주소 — cb 에는 쿼리가 없다(검사로 막힘) */
export function backUrl(cb: string, state: string, kv: Record<string, string>): string {
  const q = new URLSearchParams({ state, ...kv });
  return `${cb}?${q.toString()}`;
}
