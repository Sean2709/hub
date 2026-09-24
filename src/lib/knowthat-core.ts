// 너그거알아(KnowThat) 문항 관리 — 도메인 로직 + Firestore REST.
// KnowThat 리포 `scripts/content.py`와 같은 규칙(검증·스케줄 연장·잠금). 바꾸면 둘 다 바꿀 것.
// 앱은 Firestore `public/content`(비인증 GET)를 받아 쓴다. 쓰기는 rules상 관리자 계정만.

export const PROJECT = 'knowthat-app';
// Firebase 웹 API 키(공개값 — 보안은 Firestore rules가 담당)
export const API_KEY = 'AIzaSyCvr4F6l0DfGKLsQ1BcrhSLIphX8L4gzEs';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

export const EPOCH_UTC = Date.UTC(2026, 0, 1);
export const HORIZON = 180;
export const CATEGORIES: Record<string, string> = {
  earth: '지구', history: '역사', korea: '한국', science: '과학', culture: '문화',
  animal: '동물', body: '몸', food: '음식', space: '우주',
};
export const LIMITS = { q: 45, choice: 17, detail: 90 };
const ID_RE = /^[a-z]+-\d{3,}$/;

export type Fact = {
  id: string; category: string; q: string; choices: string[]; answer: number;
  detail: string; source: { title: string; url: string }; order: number; retired?: boolean;
};
export type Payload = {
  schema: number; version: number; updatedAt: string; epoch: string;
  facts: Fact[]; schedule: string[];
};

export const len = (s: string) => [...(s ?? '')].length; // Python len()과 같게(코드포인트)
export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- 날짜(KST 기준)
export function todayIndex(now = Date.now()) {
  const k = new Date(now + 9 * 3600e3);
  return Math.round((Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - EPOCH_UTC) / 86400e3);
}
const WD = ['일', '월', '화', '수', '목', '금', '토'];
export function dateLabel(i: number, withYear = false) {
  const d = new Date(EPOCH_UTC + i * 86400e3);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${withYear ? d.getUTCFullYear() + '/' : ''}${md} (${WD[d.getUTCDay()]})`;
}
export const nowIso = () => {
  const k = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19);
  return `${k}+09:00`;
};

// ---------------------------------------------------------------- 검증
export function validateFact(f: Fact): string[] {
  const e: string[] = [];
  if (!ID_RE.test(f.id)) e.push('id 형식(영소문자-숫자3+)');
  if (!(f.category in CATEGORIES)) e.push(`category '${f.category}'`);
  const q = (f.q ?? '').trim();
  if (!q || len(q) > LIMITS.q) e.push(`질문 길이 ${len(q)} (1~${LIMITS.q})`);
  const ch = f.choices ?? [];
  if (ch.length !== 4 || new Set(ch).size !== 4 || ch.some((c) => !c.trim())) e.push('보기는 서로 다른 4개');
  ch.forEach((c) => len(c) > LIMITS.choice && e.push(`보기 길이 '${c}' (≤${LIMITS.choice})`));
  if (![0, 1, 2, 3].includes(f.answer)) e.push('정답 0~3');
  const d = (f.detail ?? '').trim();
  if (!d || len(d) > LIMITS.detail) e.push(`해설 길이 ${len(d)} (1~${LIMITS.detail})`);
  if (!f.source?.title || !String(f.source?.url ?? '').startsWith('http')) e.push('출처 제목/URL(http…)');
  return e;
}

export function validate(p: Payload): string[] {
  const errs: string[] = [];
  const ids = new Set<string>(), qs = new Set<string>(), orders = new Set<number>();
  for (const f of p.facts) {
    for (const m of validateFact(f)) errs.push(`${f.id}: ${m}`);
    if (ids.has(f.id)) errs.push(`${f.id}: id 중복`);
    ids.add(f.id);
    const q = (f.q ?? '').trim();
    if (qs.has(q)) errs.push(`${f.id}: 질문 중복`);
    qs.add(q);
    if (!Number.isInteger(f.order) || orders.has(f.order)) errs.push(`${f.id}: order 정수·중복금지`);
    orders.add(f.order);
  }
  p.schedule.forEach((sid, n) => !ids.has(sid) && errs.push(`schedule[${n}] = ${sid}: 없는 문항`));
  if (!p.facts.some((f) => !f.retired)) errs.push('활성 문항 0개');
  return errs;
}

// ---------------------------------------------------------------- 스케줄
/** 오늘+horizon까지 연장, 미래 칸의 retired/없는 id 교체. 과거·오늘(≤t)은 그대로.
 *  reflow: 내일부터 전부 다시 배치(한 번도 안 나온 문항 → 가장 오래 전에 나온 문항 순). */
export function extend(p: Payload, t = todayIndex(), horizon = HORIZON, reflow = false) {
  const facts = [...p.facts].sort((a, b) => a.order - b.order);
  const active = facts.filter((f) => !f.retired);
  const valid = new Set(active.map((f) => f.id));
  const cat = new Map(facts.map((f) => [f.id, f.category]));
  if (reflow) p.schedule = p.schedule.slice(0, t + 1);
  const s = p.schedule;
  const last = new Map<string, number>();
  s.slice(0, t + 1).forEach((id, i) => last.set(id, i));
  for (let i = t + 1; i < s.length; i++) if (valid.has(s[i])) last.set(s[i], i);
  const pick = (i: number) => {
    const prev = i > 0 ? cat.get(s[i - 1]) : undefined;
    const next = i + 1 < s.length ? cat.get(s[i + 1]) : undefined;
    const ranked = [...active].sort((a, b) => (last.get(a.id) ?? -1) - (last.get(b.id) ?? -1) || a.order - b.order);
    const f = ranked.find((x) => x.category !== prev && x.category !== next) ?? ranked[0];
    last.set(f.id, i);
    return f.id;
  };
  for (let i = t + 1; i < s.length; i++) if (!valid.has(s[i])) s[i] = pick(i);
  while (s.length < t + 1 + horizon) {
    s.push('');
    s[s.length - 1] = pick(s.length - 1);
  }
  p.facts = facts;
  return p;
}

/** 잠긴(과거·오늘) 칸 중 배포본과 다른 dayIndex */
export function lockedDiff(p: Payload, pub: Payload | null, t = todayIndex()) {
  if (!pub) return [];
  const out: number[] = [];
  for (let i = 0; i < Math.min(t + 1, pub.schedule.length); i++) if (p.schedule[i] !== pub.schedule[i]) out.push(i);
  return out;
}

export function diffSummary(p: Payload, pub: Payload | null, t = todayIndex()) {
  const po = new Map((pub?.facts ?? []).map((f) => [f.id, JSON.stringify(f)]));
  const added = p.facts.filter((f) => !po.has(f.id)).map((f) => f.id);
  const changed = p.facts.filter((f) => po.has(f.id) && po.get(f.id) !== JSON.stringify(f)).map((f) => f.id);
  const ps = pub?.schedule ?? [];
  let sched = 0;
  for (let i = t + 1; i < Math.min(p.schedule.length, ps.length); i++) if (p.schedule[i] !== ps[i]) sched++;
  return { added, changed, sched, total: added.length + changed.length + sched };
}

export function nextId(p: Payload, category: string) {
  let n = 0;
  for (const f of p.facts) {
    const m = f.id.match(/^([a-z]+)-(\d+)$/);
    if (m && m[1] === category) n = Math.max(n, +m[2]);
  }
  return `${category}-${String(n + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------- Firebase Auth / Firestore
const SS_FB = 'hub.admin.kt.fbtoken';
type FbTok = { idToken: string; exp: number; email: string };

/** hub의 Google ID 토큰(aud=hub 클라이언트)을 knowthat-app Firebase 토큰으로 교환.
 *  knowthat-app Google 공급자 clientId를 hub 클라이언트로 맞춰 둬서 가능. */
export async function firebaseToken(googleIdToken: () => string | null): Promise<string> {
  try {
    const c: FbTok = JSON.parse(sessionStorage.getItem(SS_FB) || 'null');
    if (c && c.exp - Date.now() > 120e3) return c.idToken;
  } catch {}
  const g = googleIdToken();
  if (!g) throw new Error('Google 로그인이 만료됐습니다 — 페이지를 새로고침해 다시 로그인하세요');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postBody: `id_token=${g}&providerId=google.com`, requestUri: location.origin, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Firebase 로그인 실패: ${j?.error?.message ?? r.status}`);
  const tok: FbTok = { idToken: j.idToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000, email: j.email };
  sessionStorage.setItem(SS_FB, JSON.stringify(tok));
  return tok.idToken;
}
export const clearFirebaseToken = () => sessionStorage.removeItem(SS_FB);

export type Doc = { json: string; updateTime: string; fields: Record<string, any> };

export async function getDoc(path: string, token?: string): Promise<Doc | null> {
  const r = await fetch(`${FS}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
  if (r.status === 404) return null;
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} 읽기 실패: ${j?.error?.message ?? r.status}`);
  return { json: j.fields?.json?.stringValue ?? '', updateTime: j.updateTime, fields: j.fields ?? {} };
}

type Write = { path: string; fields: Record<string, string | number>; pre?: string | 'missing' | null };
export class ConflictError extends Error {}

export async function commit(token: string, writes: Write[]) {
  const body = {
    writes: writes.map((w) => ({
      update: {
        name: `projects/${PROJECT}/databases/(default)/documents/${w.path}`,
        fields: Object.fromEntries(
          Object.entries(w.fields).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }]),
        ),
      },
      ...(w.pre === 'missing' ? { currentDocument: { exists: false } } : w.pre ? { currentDocument: { updateTime: w.pre } } : {}),
    })),
  };
  const r = await fetch(`${FS}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message ?? String(r.status);
    if (j?.error?.status === 'FAILED_PRECONDITION' || /precondition|update time/i.test(msg))
      throw new ConflictError('다른 곳(로컬 스크립트 등)에서 먼저 저장했습니다 — 새로고침 후 다시 편집하세요');
    if (r.status === 403) throw new Error('권한 없음(관리자 계정이 아님)');
    throw new Error(`저장 실패: ${msg}`);
  }
  return j;
}

export const stringify = (p: Payload) => JSON.stringify(p);
export const activeCount = (p: Payload) => p.facts.filter((f) => !f.retired).length;
