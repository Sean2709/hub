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

// ---- Sign in with Apple(웹, 리디렉트 + fragment) -------------------------------------------------
// Services ID com.seanson.orunka.signin(주 App ID com.seanson.orunka) · 도메인 hub.seanson.com · Return URL 이 페이지.
// 범위(scope)를 안 받는다 → 이름·이메일을 안 받음(Apple 규칙상 scope 가 없어야 response_mode=fragment 가능 — 정적 페이지라 form_post 를 못 받는다).
// nonce: 페이지가 원래 값을 만들어 Apple 엔 SHA-256(hex)을, 게임엔 원래 값을 넘긴다 → 게임이 Firebase signInWithIdp(&nonce=원래 값).
// 게임의 cb·state 는 Apple 을 다녀오는 동안 sessionStorage 에 둔다(Return URL 은 쿼리 없이 정확히 같아야 함).
export const APPLE_CLIENT = 'com.seanson.orunka.signin';
export const APPLE_REDIRECT = 'https://hub.seanson.com/orunka/login/';
export const APPLE_SS = 'orunka.login.apple';
export type AppleSaved = { cb: string; state: string; as: string; nonce: string; why?: string };

export function appleAuthUrl(appleState: string, nonceHash: string): string {
  const q: Record<string, string> = {
    client_id: APPLE_CLIENT, redirect_uri: APPLE_REDIRECT, response_type: 'code id_token', response_mode: 'fragment',
    state: appleState, nonce: nonceHash,
  };
  return 'https://appleid.apple.com/auth/authorize?' + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

export function randomHex(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Apple 에서 돌아온 fragment(#code=…&id_token=…&state=…) + 떠나기 전 저장값 → 게임으로 보낼 값 또는 오류 문구 */
export function appleReturn(fragment: string, saved: AppleSaved | null):
  { ok: true; cb: string; state: string; kv: Record<string, string> } | { ok: false; msg: string; cb?: string; state?: string } {
  const f = new URLSearchParams(fragment.replace(/^#/, ''));
  if (!saved || !validCb(saved.cb) || !validState(saved.state))
    return { ok: false, msg: 'Apple 로그인 전에 열었던 게임 정보가 없어요 — 게임에서 로그인을 다시 눌러 주세요.' };
  if (f.get('state') !== saved.as) return { ok: false, msg: 'Apple 응답이 이상해요(state) — 다시 해 주세요.' };
  const err = f.get('error');
  if (err) return { ok: false, msg: err === 'user_cancelled_authorize' ? 'Apple 로그인을 그만뒀어요.' : `Apple 로그인 실패: ${err}`, cb: saved.cb, state: saved.state };
  const idt = f.get('id_token');
  if (!idt || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idt)) return { ok: false, msg: 'Apple 이 토큰을 주지 않았어요 — 다시 해 주세요.', cb: saved.cb, state: saved.state };
  return { ok: true, cb: saved.cb, state: saved.state, kv: { idt, prov: 'apple.com', nonce: saved.nonce, code: f.get('code') || '' } };
}
