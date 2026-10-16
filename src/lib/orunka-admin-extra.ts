// 오룬카 관리 패널 보조(orunka-game-saves.ts 가 씀) — 시험 계정 가르기 · 실사용자 요약 · 운영 카드(읽기만)
// 시험 판정 = 계정(uid) 단위. 맥 로컬 관리 도구(OrunkaUnity tools/admin)와 같은 규칙이지만 저장은 따로:
//   여기 = 이 브라우저 localStorage 'hub.admin.orunka.test' {add:[uid], del:[uid]} (코드 기본값 위에 덮어쓰기)
//   맥 7800 도구 = ~/.config/orunka/admin-test.json
// 세이브는 건드리지 않는다 — 보기에서만 숨김.
// 운영 카드 계약(읽기만, OrunkaUnity tools/server):
//   GET /admin/api/reports → [{at, from:{uid,name}, to:{u,uid,name}, why, text}]            (Saves.cs · Guard.ReportsJson)
//   GET /admin/api/suspects → {rows:[{u, uid, test, name, h, score, st, last, n}], ipwatch:[{ip, day, us:[u], last}], hot:[{u, by}]}   (JudgeApi.cs)
//   GET /admin/api/sanctions → {rows:[{id, uid, u, kind, at, until, why, lifted, ended}]}   (JudgeApi.cs)
//   GET /admin/api/trash → {keep, rows:[{id, at, purgeAt, uid, provider, chars:[{name, lv}]}]}   (Restore.cs)
//   u = sha256(uid) 앞 12자리(Mod.U)

export const ME_UID = 'CMKCVwJ7HQWVoOGgAwtc0FMhTAS2'; // 관리자 본인(카린·바람) — 시험 아님, 「내 캐릭」
// 코드 기본 시험 계정 — provider qa·anonymous 와 uid qa:·test- 는 규칙으로 따로 걸림
const TEST_UIDS = [
  'oO1WQCZvx2XqfB5lSS7zWgGQ7302', // 단비(apple, 심사 무렵)
  'RzbYovMs6IZY2hle6TeDbWDQlXv2', // 빛·올가(apple)
  'NrBoIyHwr0USo0lYsd2ia6uHCPz1', // 해골(google, 다른 메일)
  'laEJ0piDNZSjfK03VvcwLZMkNos1', // 솔이(google, 심사용)
];
const LS_TEST = 'hub.admin.orunka.test';

export type Kind = 'user' | 'me' | 'test';
type Marks = { add: string[]; del: string[] };
const strs = (a: unknown) => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : []);
function marks(): Marks {
  try {
    const m = JSON.parse(localStorage.getItem(LS_TEST) || 'null');
    return { add: strs(m?.add), del: strs(m?.del) };
  } catch {
    return { add: [], del: [] };
  }
}
const autoTest = (uid: string, provider?: string) =>
  provider === 'qa' || provider === 'anonymous' || uid.startsWith('qa:') || uid.startsWith('test-') || TEST_UIDS.includes(uid);

export function kindOf(uid?: string, provider?: string): Kind {
  const u = uid || '';
  const m = marks();
  const test = u && m.del.includes(u) ? false : u && m.add.includes(u) ? true : autoTest(u, provider);
  return test ? 'test' : u === ME_UID ? 'me' : 'user';
}
// 계정 하나를 시험으로/해제 — 기본값과 같아지면 덮어쓰기를 지운다
export function setTest(uid: string, on: boolean, provider?: string) {
  const m = marks();
  m.add = m.add.filter((x) => x !== uid);
  m.del = m.del.filter((x) => x !== uid);
  if (on !== autoTest(uid, provider)) (on ? m.add : m.del).push(uid);
  if (m.add.length || m.del.length) localStorage.setItem(LS_TEST, JSON.stringify(m));
  else localStorage.removeItem(LS_TEST);
}
export const marksCount = () => {
  const m = marks();
  return m.add.length + m.del.length;
};

// u(sha256(uid) 앞 12) → uid
export async function uMap(uids: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!crypto?.subtle) return out;
  for (const uid of new Set(uids)) {
    if (!uid) continue;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid)));
    out.set(Array.from(d.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join(''), uid);
  }
  return out;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const when = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? String(iso) : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const ago = (ms: number) => {
  if (!ms) return '';
  const m = Math.floor((Date.now() - ms) / 60e3);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
};
const t = (iso?: string | null) => {
  const n = iso ? Date.parse(iso) : NaN;
  return isNaN(n) ? 0 : n;
};
// 최근 접속 = 들어온 때(lastJoin)와 마지막 저장(mtime) 중 늦은 것 — 놀고 있는 동안 저장이 이어진다
export const lastOf = (r: { lastJoin?: string; mtime?: string }) => Math.max(t(r.lastJoin), t(r.mtime));

type SaveRow = { h: string; uid?: string; provider?: string; name?: string; online?: boolean; lastJoin?: string; mtime?: string };

// 실사용자(시험·내 캐릭 빼고) 요약 한 줄 — rows 의 uid·provider·online·lastJoin·mtime 으로 셀 수 있는 것만
export function statHtml(rows: SaveRow[], showTest: boolean) {
  const acct = new Map<string, { p: string; last: number; on: boolean }>();
  let chars = 0, on = 0, me = 0, test = 0;
  for (const r of rows) {
    const k = kindOf(r.uid, r.provider);
    if (k === 'me') { me++; continue; }
    if (k === 'test') { test++; continue; }
    chars++;
    if (r.online) on++;
    const key = r.uid || 'h:' + r.h;
    const a = acct.get(key) ?? { p: r.provider || '', last: 0, on: false };
    a.last = Math.max(a.last, lastOf(r));
    a.on ||= !!r.online;
    acct.set(key, a);
  }
  const now = Date.now();
  const as = [...acct.values()];
  const n = (f: (a: { p: string; last: number; on: boolean }) => boolean) => as.filter(f).length;
  const other = n((a) => a.p !== 'apple.com' && a.p !== 'google.com');
  const b = (v: number, label: string, title = '') => `<span class="og-st"${title ? ` title="${esc(title)}"` : ''}><b>${v}</b> ${label}</span>`;
  return (
    `<span class="og-st-h">실사용자</span>` +
    b(as.length, '계정') + b(chars, '캐릭') +
    b(on, '지금 접속', `계정 ${n((a) => a.on)}개`) +
    b(n((a) => now - a.last < 864e5), '24시간 안', '계정 수 · 최근 접속(들어온 때·마지막 저장 중 늦은 것)') +
    b(n((a) => now - a.last < 7 * 864e5), '7일 안', '계정 수') +
    b(n((a) => a.p === 'apple.com'), 'Apple') + b(n((a) => a.p === 'google.com'), 'Google') +
    (other ? b(other, '기타') : '') +
    `<span class="og-st muted">내 캐릭 ${me} · 시험 ${test}${showTest ? '' : '(숨김)'}</span>`
  );
}

// ---- 운영 카드 -----------------------------------------------------------------
export type Ops = { reports?: any; suspects?: any; sanctions?: any; trash?: any; err: Record<string, string> };
const WHY: Record<string, string> = { abuse: '욕설·괴롭힘', spam: '도배', name: '이름', cheat: '부정', etc: '기타' };
const ST: Record<string, string> = { new: '새로', watch: '지켜봄', ok: '문제없음', banned: '정지함', low: '점수만' };
const KIND: Record<string, string> = { suspend: '정지', ban: '영구 정지', warn: '경고', mute: '말 막기' };
const live = (r: any) => r.lifted == null && (r.kind === 'ban' || (!!r.until && t(r.until) > Date.now()));

// provOf: uid → provider(세이브·보관함에서), nameOf: uid → 캐릭 이름들, us: u → uid
export function opsHtml(o: Ops, showTest: boolean, provOf: (uid: string) => string | undefined, nameOf: (uid: string) => string, us: Map<string, string>) {
  const k = (uid?: string) => kindOf(uid, uid ? provOf(uid) : undefined);
  const keep = (test: boolean) => showTest || !test;
  const li = (test: boolean, html: string) => `<li${test ? ' class="og-dim"' : ''}>${test ? '<span class="og-b test">시험</span> ' : ''}${html}</li>`;
  const card = (key: string, title: string, count: number | string, sub: string, items: string[]) =>
    `<div class="og-card"><div class="og-ck">${title}</div>` +
    (o.err[key]
      ? `<p class="og-cs err">못 읽음 — ${esc(o.err[key])}</p>`
      : `<div class="og-cv">${count}</div>${sub ? `<div class="og-cs">${sub}</div>` : ''}${items.length ? `<ul>${items.slice(0, 3).join('')}</ul>` : ''}`) +
    `</div>`;

  // 신고 — 어느 쪽이든 시험 계정이면 시험(관리자가 시험 계정을 신고한 것 포함)
  const reps = (Array.isArray(o.reports) ? o.reports : o.reports?.rows ?? [])
    .map((r: any) => ({ r, test: k(r?.from?.uid) === 'test' || k(r?.to?.uid) === 'test' }))
    .filter((x: any) => keep(x.test));
  const today = new Date().toDateString();
  const repToday = reps.filter((x: any) => new Date(x.r.at).toDateString() === today).length;
  const repCard = card('reports', '신고', reps.length, `오늘 ${repToday}`, reps.map((x: any) =>
    li(x.test, `${when(x.r.at)} · ${esc(x.r.from?.name)} → <b>${esc(x.r.to?.name)}</b> · ${esc(WHY[x.r.why] ?? x.r.why)}${x.r.text ? ` · ${esc(String(x.r.text).slice(0, 60))}` : ''}`)));

  // 판별 의심(new·watch·banned — 서버 기본) · IP 묶음 · 오늘 신고 몰림
  const sus = o.suspects ?? {};
  const sRows = (sus.rows ?? []).map((r: any) => ({ r, test: !!r.test || k(r.uid) === 'test' })).filter((x: any) => keep(x.test));
  // IP 묶음: 아는 계정이 시험·내 계정뿐이면(실사용자 0) 관리자 기기·망으로 보고 시험
  const ipw = (sus.ipwatch ?? []).map((w: any) => {
    const ks = (w.us ?? []).map((u: string) => (us.has(u) ? k(us.get(u)) : '?'));
    return { w, test: ks.some((x: string) => x === 'test' || x === 'me') && !ks.includes('user') };
  }).filter((x: any) => keep(x.test));
  const hot = (sus.hot ?? []).filter((h: any) => keep(us.has(h.u) && k(us.get(h.u)) === 'test'));
  const susCard = card('suspects', '판별 의심', sRows.length,
    `IP 묶음 ${ipw.length}${hot.length ? ` · 오늘 신고 몰림 <b>${hot.length}</b>` : ''}`,
    [...sRows.map((x: any) => li(x.test, `<b>${esc(x.r.name || x.r.u)}</b> · ${esc(ST[x.r.st] ?? x.r.st)} · 점수 ${Math.round(+x.r.score || 0)}${x.r.last ? ` · ${when(x.r.last)}` : ''}`)),
     ...ipw.map((x: any) => li(x.test, `IP <span class="mono">${esc(x.w.ip)}</span> · 계정 ${(x.w.us ?? []).length}개${x.w.last ? ` · ${when(x.w.last)}` : ''}`))]);

  // 제재 — 지금 걸려 있는 것(서버 live=1 과 같은 판정) / 전체
  const sans = (o.sanctions?.rows ?? []).map((r: any) => ({ r, test: k(r.uid) === 'test' })).filter((x: any) => keep(x.test));
  const sanCard = card('sanctions', '제재', sans.filter((x: any) => live(x.r)).length, `지금 걸림 · 전체 ${sans.length}`, sans.map((x: any) =>
    li(x.test, `${esc(KIND[x.r.kind] ?? x.r.kind)} · <b>${esc(nameOf(x.r.uid) || x.r.u)}</b>${x.r.why ? ` · ${esc(String(x.r.why).slice(0, 40))}` : ''} · ${when(x.r.at)}` +
      (x.r.lifted ? ' · 풀림' : x.r.kind === 'ban' ? ' · 영구' : x.r.until ? (live(x.r) ? ` · ~${when(x.r.until)}` : ' · 끝남') : ''))));

  // 지운 계정 보관함(계정 지우기, keep 일)
  const tr = (o.trash?.rows ?? []).map((r: any) => ({ r, test: kindOf(r.uid, r.provider) === 'test' })).filter((x: any) => keep(x.test));
  const trCard = card('trash', '지운 계정 보관함', tr.length, o.trash?.keep ? `${esc(o.trash.keep)}일 보관` : '', tr.map((x: any) =>
    li(x.test, `${when(x.r.at)} · ${(x.r.chars ?? []).map((c: any) => `<b>${esc(c.name)}</b> Lv${esc(c.lv)}`).join(', ') || '캐릭 없음'}${x.r.purgeAt ? ` · ${when(x.r.purgeAt)} 지움` : ''}`)));

  return `<div class="og-cards">${repCard}${susCard}${sanCard}${trCard}</div>` +
    `<p class="note og-ops-note">읽기만 — 제재·해제·의심 상태 바꾸기·되살리기는 아래 오룬카 관리 도구(집 Mac)에서 합니다.</p>`;
}
