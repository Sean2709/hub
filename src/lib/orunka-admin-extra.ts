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
//   GET /admin/api/act?all=1&ev=join,wipe&from=&to= · ?u=&ev=join → {rows:[{t, ev, u, n, d:{ip, prov, dev, keep, del}}]}   (ActApi.cs, 행위 기록)
//     IP 묶음 u 풀이에 씀: 지운 계정(세이브 없음)도 그날 join 줄의 이름·prov(qa = 시험 신원)·기기로 알고, 내 캐릭 join 줄 IP = 내 쪽 IP
//   u = sha256(uid) 앞 12자리(Mod.U)

// 관리자 본인 계정 — 시험 아님, 「내 캐릭」
const ME_UIDS = [
  'CMKCVwJ7HQWVoOGgAwtc0FMhTAS2', // 카린·바람(google)
  'RzbYovMs6IZY2hle6TeDbWDQlXv2', // 빛·올가(apple)
  'NrBoIyHwr0USo0lYsd2ia6uHCPz1', // 해골(google)
];
// 코드 기본 시험 계정 — provider qa·anonymous 와 uid qa:·test- 는 규칙으로 따로 걸림
const TEST_UIDS = [
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
  return test ? 'test' : ME_UIDS.includes(u) ? 'me' : 'user';
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
export type Ops = { reports?: any; suspects?: any; sanctions?: any; trash?: any; sx?: SusX | null; err: Record<string, string> };

// ---- 판별 의심 풀이(10-24 「의심이 뜨는데 뭔지 모르겠어」) ----------------------------
// 서버 IP 묶음·신고 몰림은 u(12자)만 준다. 세이브 목록에 없는 u(지운 QA 시험 신원 등)는 그날 행위 기록 join·wipe 줄로 풀고,
// 내 캐릭(ME_UIDS)이 최근 7일 접속한 IP 를 내 쪽 IP 로 본다. 5분 기억(1분 자동 새로고침마다 서버 기록을 다시 훑지 않게)
type Who = { names: string[]; prov: string; dev: string[]; seen: boolean; gone: boolean };
export type SusX = { who: Map<string, Who>; myIps: Set<string>; at: number; key: string };
let SX: SusX | null = null;
export async function susExtra(call: (path: string) => Promise<any>, base: string, sus: any): Promise<SusX | null> {
  const ipw: any[] = sus?.ipwatch ?? [], hot: any[] = sus?.hot ?? [];
  if (!ipw.length && !hot.length) return null;
  const days = [...new Set(ipw.map((w) => String(w?.day ?? '')).filter((d) => /^\d{8}$/.test(d)))].sort().slice(-7);
  const key = days.join(',');
  if (SX && SX.key === key && Date.now() - SX.at < 5 * 60e3) return SX;
  const meU = await uMap(ME_UIDS);
  const get = async (q: string) => ((await call(`${base}/act?${q}`))?.rows ?? []) as any[];
  const lists = await Promise.all([
    ...days.map((d) => get(`all=1&ev=join,wipe&from=${d}&to=${d}&n=1000`)),
    ...[...meU.keys()].map((u) => get(`u=${u}&ev=join&n=30`)),
  ]);
  const who = new Map<string, Who>(), myIps = new Set<string>();
  for (const rows of lists) for (const e of [...rows].reverse()) {
    const u = String(e?.u ?? ''), d = e?.d ?? {};
    if (!u) continue;
    if (e.ev === 'join' && meU.has(u) && d.ip) myIps.add(String(d.ip));
    const w = who.get(u) ?? { names: [], prov: '', dev: [], seen: false, gone: false };
    if (e.ev === 'join') {
      w.seen = true;
      if (e.n && !w.names.includes(e.n)) w.names.push(String(e.n));
      if (d.prov && !w.prov) w.prov = String(d.prov);
      if (d.dev && !w.dev.includes(d.dev)) w.dev.push(String(d.dev));
    } else if (e.ev === 'wipe' && d.keep === 0 && !d.del) w.gone = true;
    who.set(u, w);
  }
  SX = { who, myIps, at: Date.now(), key };
  return SX;
}
const SIG: Record<string, string> = { S1: '비정상 명령', S2: '너무 잦은 명령', S3: '경제 이상', S4: '너무 빠른 성장', S5: '자동 조작', S6: '몰아주기', S7: '모르는 클라 판', S8: '정지된 사람과 같은 IP' };
const WHY: Record<string, string> = { abuse: '욕설·괴롭힘', spam: '도배', name: '이름', cheat: '부정', etc: '기타' };
const ST: Record<string, string> = { new: '새로', watch: '지켜봄', ok: '문제없음', banned: '정지함', low: '점수만' };
const KIND: Record<string, string> = { suspend: '정지', ban: '영구 정지', warn: '경고', mute: '말 막기' };
const live = (r: any) => r.lifted == null && (r.kind === 'ban' || (!!r.until && t(r.until) > Date.now()));

// provOf: uid → provider(세이브·보관함에서), nameOf: uid → 캐릭 이름들, us: u → uid
// 실사용자가 하나도 안 낀 줄(내 캐릭·시험끼리)은 숨김 — 「시험 N개 보기」 켜면 흐리게 + 배지
type Hk = 'user' | 'me' | 'test';
export function opsHtml(o: Ops, showTest: boolean, provOf: (uid: string) => string | undefined, nameOf: (uid: string) => string, us: Map<string, string>) {
  const k = (uid?: string): Hk => (uid ? kindOf(uid, provOf(uid)) : 'user');
  // 여러 쪽이 낀 줄: 한 쪽이라도 실사용자(또는 모름)면 user, 아니면 시험이 끼면 test, 그 밖은 me
  const join = (ks: Hk[]): Hk => (!ks.length || ks.includes('user') ? 'user' : ks.includes('test') ? 'test' : 'me');
  const li = (h: Hk, html: string) =>
    `<li${h !== 'user' ? ' class="og-dim"' : ''}>${h === 'test' ? '<span class="og-b test">시험</span> ' : h === 'me' ? '<span class="og-b me">내 캐릭</span> ' : ''}${html}</li>`;
  // 보이는 것만 남기고 숨긴 수를 같이 돌려준다
  const split = <T extends { h: Hk }>(xs: T[]) => ({ xs: xs.filter((x) => showTest || x.h === 'user'), hid: showTest ? 0 : xs.filter((x) => x.h !== 'user').length });
  const hidNote = (n: number) => (n ? ` · 숨김 ${n}` : '');
  const card = (key: string, title: string, count: number | string, sub: string, items: string[], foot = '') =>
    `<div class="og-card"><div class="og-ck">${title}</div>` +
    (o.err[key]
      ? `<p class="og-cs err">못 읽음 — ${esc(o.err[key])}</p>`
      : `<div class="og-cv">${count}</div>${sub ? `<div class="og-cs">${sub}</div>` : ''}${items.length ? `<ul>${items.slice(0, 3).join('')}</ul>` : ''}${foot ? `<p class="og-cs og-foot">${foot}</p>` : ''}`) +
    `</div>`;

  // 신고 — 보낸 쪽·받은 쪽 둘 다 내 캐릭/시험이면 숨김, 실사용자가 한쪽이라도 끼면 보임
  const R = split((Array.isArray(o.reports) ? o.reports : o.reports?.rows ?? [])
    .map((r: any) => ({ r, h: join([k(r?.from?.uid), k(r?.to?.uid)]) })));
  const reps = R.xs;
  const today = new Date().toDateString();
  const repToday = reps.filter((x: any) => new Date(x.r.at).toDateString() === today).length;
  const repCard = card('reports', '신고', reps.length, `오늘 ${repToday}${hidNote(R.hid)}`, reps.map((x: any) =>
    li(x.h, `${when(x.r.at)} · ${esc(x.r.from?.name)} → <b>${esc(x.r.to?.name)}</b> · ${esc(WHY[x.r.why] ?? x.r.why)}${x.r.text ? ` · ${esc(String(x.r.text).slice(0, 60))}` : ''}`)));

  // 판별 의심(new·watch·banned — 서버 기본) · IP 묶음 · 오늘 신고 몰림 — 대상이 내 캐릭/시험이면 숨김
  const sus = o.suspects ?? {};
  const S = split((sus.rows ?? []).map((r: any) => ({ r, h: (r.test ? 'test' : k(r.uid)) as Hk })));
  // u → 누구: 세이브 있으면 그 계정 종류, 없으면 행위 기록 join prov(qa·anonymous = 시험), 그래도 모르면 실사용자 쪽으로 셈
  const sx = o.sx ?? null;
  const uk = (u: string): Hk => (us.has(u) ? k(us.get(u)) : ['qa', 'anonymous'].includes(sx?.who.get(u)?.prov ?? '') ? 'test' : 'user');
  const uName = (u: string) => (us.has(u) ? nameOf(us.get(u)!) : '') || sx?.who.get(u)?.names.join('·') || u;
  const KO: Record<Hk, string> = { user: '실사용자', me: '내 캐릭', test: '시험' };
  // IP 묶음: 실사용자가 하나도 없고(사람이 모두 내 캐릭·시험) 사람이 있거나 내 쪽 IP(내 캐릭 접속 IP)면 숨김
  const I = split((sus.ipwatch ?? []).map((w: any) => {
    const ppl = (w.us ?? []).map((u: string) => ({ u, h: uk(u), name: uName(u), gone: !us.has(u) && !!sx?.who.get(u)?.gone, unk: !us.has(u) && !sx?.who.get(u)?.seen }));
    const n = (h: Hk) => ppl.filter((p: any) => p.h === h).length, mine = !!sx?.myIps.has(w.ip);
    const h: Hk = n('user') || (!ppl.length && !mine) ? 'user' : n('test') || !ppl.length ? 'test' : 'me';
    return { w, h, ppl, n, mine };
  }));
  const hotK = (sus.hot ?? []).map((x: any) => ({ x, h: uk(x.u) }));
  const hot = hotK.filter((y: any) => showTest || y.h === 'user');
  const ipLine = (x: any) => {
    const cnt = (['user', 'test', 'me'] as Hk[]).filter((h) => x.n(h)).map((h) => `${KO[h]} ${x.n(h)}`).join(' · ');
    const why = [x.ppl.length ? `계정 ${x.ppl.length}개${x.ppl.length >= 4 ? '(기준 4)' : ''}${cnt ? `: ${cnt}` : ''}` : '', x.w.nohello ? `로그인 전 연결 ${x.w.nohello}번${x.w.nohello >= 30 ? '(기준 30)' : ''}` : ''].filter(Boolean).join(' · ');
    const tip = [x.mine ? '내 캐릭이 접속한 IP(내 쪽)' : '', ...x.ppl.map((p: any) => `${p.name}(${p.unk ? '모르는 계정' : KO[p.h as Hk]}${p.gone ? ', 계정 지움' : ''})`)].filter(Boolean).join(', ');
    const names = x.ppl.slice(0, 6).map((p: any) => esc(p.name) + (p.gone ? '(지움)' : '')).join(', ') + (x.ppl.length > 6 ? ` 외 ${x.ppl.length - 6}` : '');
    return li(x.h, `<span class="og-wrap" title="${esc(tip)}">IP <span class="mono">${esc(x.w.ip)}</span>${x.mine ? ' 내 쪽' : ''} · ${why}${x.w.last ? ` · ${when(x.w.last)}` : ''}${names ? `<br><span class="og-who">${names}</span>` : ''}</span>`);
  };
  const susFoot = [S.xs.length ? '점수는 7일마다 반으로 줄고 30점 넘으면 「새로」. 신호 뜻은 관리 도구 의심 탭 「이 화면 읽는 법」' : '',
    I.xs.length ? 'IP 묶음은 참고용. 하루 한 IP 에 계정 4개 이상 또는 로그인 전 연결 30번 이상이면 뜸. 같은 집·학교·PC방 와이파이면 보통 괜찮음' : '',
    I.hid ? `숨긴 IP 묶음 ${I.hid}줄 = 사람이 모두 시험 신원·내 캐릭이거나 내 캐릭이 접속한 IP` : ''].filter(Boolean).join('<br>');
  const susCard = card('suspects', '판별 의심', S.xs.length,
    `IP 묶음 ${I.xs.length}${hot.length ? ` · 오늘 신고 몰림 <b>${hot.length}</b>` : ''}${hidNote(S.hid + I.hid + (hotK.length - hotK.filter((y: any) => y.h === 'user').length))}`,
    [...S.xs.map((x: any) => {
      const top = Object.entries(x.r.sig ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(([s]) => `${s} ${SIG[s] ?? ''}`).join(', ');
      return li(x.h, `<span title="${esc(x.r.top ? `${x.r.top.s} ${x.r.top.why}` : '')}"><b>${esc(x.r.name || x.r.u)}</b> · ${esc(ST[x.r.st] ?? x.r.st)} · 점수 ${Math.round(+x.r.score || 0)}${top ? ` · ${esc(top)}` : ''}${x.r.last ? ` · ${when(x.r.last)}` : ''}</span>`);
    }),
     ...[...I.xs].sort((a: any, b: any) => +(a.h !== 'user') - +(b.h !== 'user')).map(ipLine),
     ...hot.map((y: any) => li(y.h, `신고 몰림 <b>${esc(uName(y.x.u))}</b> · 오늘 서로 다른 ${esc(y.x.by)}명`))], susFoot);

  // 제재 — 지금 걸려 있는 것(서버 live=1 과 같은 판정) / 전체. 대상이 내 캐릭/시험이면 숨김
  const N = split((o.sanctions?.rows ?? []).map((r: any) => ({ r, h: k(r.uid) })));
  const sans = N.xs;
  const sanCard = card('sanctions', '제재', sans.filter((x: any) => live(x.r)).length, `지금 걸림 · 전체 ${sans.length}${hidNote(N.hid)}`, sans.map((x: any) =>
    li(x.h, `${esc(KIND[x.r.kind] ?? x.r.kind)} · <b>${esc(nameOf(x.r.uid) || x.r.u)}</b>${x.r.why ? ` · ${esc(String(x.r.why).slice(0, 40))}` : ''} · ${when(x.r.at)}` +
      (x.r.lifted ? ' · 풀림' : x.r.kind === 'ban' ? ' · 영구' : x.r.until ? (live(x.r) ? ` · ~${when(x.r.until)}` : ' · 끝남') : ''))));

  // 지운 계정 보관함(계정 지우기, keep 일) — 대상이 내 캐릭/시험이면 숨김
  const T = split((o.trash?.rows ?? []).map((r: any) => ({ r, h: (r.uid ? kindOf(r.uid, r.provider) : 'user') as Hk })));
  const tr = T.xs;
  const trCard = card('trash', '지운 계정 보관함', tr.length, `${o.trash?.keep ? `${esc(o.trash.keep)}일 보관` : ''}${T.hid ? `${o.trash?.keep ? ' · ' : ''}숨김 ${T.hid}` : ''}`, tr.map((x: any) =>
    li(x.h, `${when(x.r.at)} · ${(x.r.chars ?? []).map((c: any) => `<b>${esc(c.name)}</b> Lv${esc(c.lv)}`).join(', ') || '캐릭 없음'}${x.r.purgeAt ? ` · ${when(x.r.purgeAt)} 지움` : ''}`)));

  return `<div class="og-cards">${repCard}${susCard}${sanCard}${trCard}</div>` +
    `<p class="note og-ops-note">읽기만 — 제재·해제·의심 상태 바꾸기·되살리기는 아래 오룬카 관리 도구(집 Mac)에서 합니다.</p>`;
}
