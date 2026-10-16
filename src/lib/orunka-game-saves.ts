// 오룬카 게임 서버 저장 관리 패널(wss://game.seanson.com 서버의 /admin/api/saves) — /admin/ 앱 관리 탭 '오룬카'에서 mount.
// 혼자 하기를 없애며(Sean 10-05 "전부 서버로", OrunkaUnity D57) 저장의 정본 = 게임 서버. Firestore 저장은 첫 접속 때 서버가 한 번 옮겨 간다.
// 계약 = OrunkaUnity tools/server/Saves.cs
//   GET /admin/api/saves → {rows:[{h, uid, email, provider, name, lv, playTime, money, mtime, online, lastJoin}]}
//   GET /admin/api/saves/{h} → {h, uid, email, online, ver, json}   (들어와 있으면 지금 Game 판)
//   PUT /admin/api/saves/{h} {json, ver} → 409 = 그새 바뀜 · 들어와 있으면 그 접속을 끊고 씀(다시 들어오면 고친 판)
//   GET …/{h}/hist → {rows:[{id, kind, mtime, name, lv, playTime}]} · GET …/hist/{id} → {json}
// 인증 = 관리자 Google → orunka-game Firebase ID 토큰(Bearer, email_verified) — orunka-cloud.ts 와 같은 교환·같은 캐시
// 목록 = 시험 계정 기본 숨김(보기만 — 세이브는 안 건드림) · 실사용자 요약 · 검색·정렬·계정별 묶기 · 운영 카드(읽기만) · 1분 자동 새로고침 (orunka-admin-extra.ts)
import { checkSave } from './orunka-cloud';
import { ago, esc, kindOf, lastOf, opsHtml, setTest, statHtml, uMap, when, type Kind, type Ops } from './orunka-admin-extra';

const API_KEY = 'AIzaSyC4gjiwEudf6GMBpm1u3vlGEmhk-lBijKs';
const SS_FB = 'hub.admin.orunka.fbtoken';
export const GAME_API = 'https://game.seanson.com/admin/api/saves';
const AUTO_MS = 60e3;

type Row = { h: string; uid?: string; email?: string; provider?: string; name?: string; lv?: number; playTime?: number; money?: number; mtime?: string; online?: boolean; lastJoin?: string };
type Hist = { id: string; kind: string; mtime: string; name?: string; lv?: number; playTime?: number };
type Cur = { h: string; uid?: string; email?: string; online: boolean; ver: string; save: any };
type SortKey = 'last' | 'name' | 'lv' | 'playTime' | 'money';

const hours = (sec?: number) => {
  const m = Math.round((Number(sec) || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
};
const BADGE: Record<Kind, string> = { user: '', me: ' <span class="og-b me">내 캐릭</span>', test: ' <span class="og-b test">시험</span>' };
// provider 표시 — qa = QA 시험 신원(uid "qa:<id>", 게임 레포 41f8b7a W22) · anonymous = 익명 로그인을 없애기 전(10-11) 세이브 meta 에 남은 옛 값
export const prov = (p?: string) =>
  p === 'apple.com' ? 'Apple' : p === 'google.com' ? 'Google' : p === 'qa' ? '시험(QA)' : p === 'anonymous' ? '익명(옛)' : p || '';

// onPick(h, jump) — 줄을 열면 아래 로컬 관리 도구(iframe)도 그 사용자(?target=game:h)로 맞춘다. 돌려준 글이 있으면 알림으로 보여 줌
export function mountOrunkaGameSaves(el: HTMLElement, googleIdToken: () => string | null, api = GAME_API, onPick?: (h: string, jump: boolean) => string) {
  let rows: Row[] = [];
  let cur: Cur | null = null;
  let hist: Hist[] = [];
  let from = '';
  let busy = false;
  // 목록 보기 상태 — 시험 보기는 늘 꺼진 채로 시작(기본 숨김), 나머지는 이 페이지 안에서만
  let showTest = false;
  let group = false;
  let q = '';
  let sort: { k: SortKey; dir: 1 | -1 } = { k: 'last', dir: -1 };
  let ops: Ops = { err: {} };
  let us = new Map<string, string>(); // u(sha256(uid) 앞 12) → uid
  let at = 0; // 마지막 갱신
  let auto = true;
  const base = api.replace(/\/saves$/, ''); // /admin/api
  el.className = 'kt oc og';

  async function token(): Promise<string> {
    try {
      const c = JSON.parse(sessionStorage.getItem(SS_FB) || 'null');
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
    if (!r.ok) throw new Error(`Firebase(orunka-game) 로그인 실패: ${j?.error?.message ?? r.status}`);
    sessionStorage.setItem(SS_FB, JSON.stringify({ idToken: j.idToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000 }));
    return j.idToken;
  }
  // path 가 'http' 로 시작하면 그대로(운영 카드 /admin/api/reports 등), 아니면 api(/admin/api/saves) 뒤에 붙임
  async function call(path: string, init: RequestInit = {}) {
    let r: Response;
    try {
      r = await fetch(path.startsWith('http') ? path : api + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await token()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store' });
    } catch (e) {
      throw new Error(`게임 서버에 닿지 않습니다(${api.replace('/admin/api/saves', '')}) — ${e}`);
    }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('권한 없음 — 관리자(seanson2709@gmail.com) Google 로그인이어야 합니다');
    if (!r.ok) throw Object.assign(new Error(j?.error ?? `게임 서버 ${r.status}`), { status: r.status });
    return j;
  }

  const say = (text: string, cls = '') => {
    const m = el.querySelector('.og-msg');
    if (m) {
      m.textContent = text;
      m.className = 'msg og-msg ' + cls;
    }
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    el.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e: any) {
      say(String(e?.message ?? e), 'err');
    } finally {
      busy = false;
      el.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  };

  // quiet = 1분 자동 새로고침 — 알림 줄·열린 편집기는 그대로 두고 요약·운영 카드·목록만 다시 그림
  async function load(quiet = false) {
    if (!quiet) say('게임 서버 저장 목록 읽는 중…');
    const [s, ...o] = await Promise.allSettled([call(''), call(`${base}/reports?n=200`), call(`${base}/suspects`), call(`${base}/sanctions`), call(`${base}/trash`)]);
    if (s.status === 'rejected') throw s.reason;
    rows = s.value.rows ?? [];
    const next: Ops = { err: {} };
    (['reports', 'suspects', 'sanctions', 'trash'] as const).forEach((k, i) => {
      const x = o[i];
      if (x.status === 'fulfilled') next[k] = x.value;
      else next.err[k] = String(x.reason?.message ?? x.reason);
    });
    ops = next;
    const rep: any[] = Array.isArray(ops.reports) ? ops.reports : [];
    us = await uMap([
      ...rows.map((r) => r.uid || ''),
      ...(ops.trash?.rows ?? []).map((r: any) => r.uid),
      ...(ops.sanctions?.rows ?? []).map((r: any) => r.uid),
      ...rep.flatMap((r) => [r?.from?.uid, r?.to?.uid]),
    ].filter((x): x is string => typeof x === 'string' && !!x));
    at = Date.now();
    renderTop();
    if (quiet) return;
    renderCur();
    const n = { user: 0, me: 0, test: 0 };
    rows.forEach((r) => n[kindOf(r.uid, r.provider)]++);
    say(rows.length
      ? `게임 서버 저장 ${rows.length}개 — 실사용자 ${n.user} · 내 캐릭 ${n.me} · 시험 ${n.test} · 들어와 있음 ${rows.filter((r) => r.online).length}명`
      : '아직 게임 서버에 저장이 없습니다 — 새 판(함께 사냥) 게임으로 들어오면 생깁니다(첫 접속 때 Firestore 저장을 옮겨 옴)', 'ok');
  }
  async function open(h: string, msg = '') {
    const j = await call(`/${h}`);
    let save: any;
    try {
      save = JSON.parse(j.json);
    } catch (e) {
      throw new Error(`저장 json 이 깨졌습니다: ${e}`);
    }
    cur = { h, uid: j.uid, email: j.email, online: !!j.online, ver: j.ver, save };
    from = '';
    hist = (await call(`/${h}/hist`)).rows ?? [];
    render();
    onPick?.(h, false);
    say(msg || `열었습니다${cur.online ? ' · 지금 들어와 있음(게임 판 그대로 — 쓰면 그 접속은 끊기고 다시 들어오면 고친 판)' : ''}`, msg ? 'ok' : '');
  }
  async function loadBackup(id: string) {
    if (!cur) return;
    const j = await call(`/${cur.h}/hist/${id}`);
    const s = JSON.parse(j.json ?? 'null');
    if (!s) throw new Error('백업이 비었습니다');
    from = id;
    editor()!.value = JSON.stringify(s, null, 2);
    summary(s);
    say(`백업 ${id} 를 편집기에 올렸습니다 — '서버에 쓰기'를 누르면 이 판으로 되돌립니다`, 'ok');
  }
  async function write() {
    if (!cur) return;
    let s: any;
    try {
      s = JSON.parse(editor()!.value);
    } catch (e) {
      throw new Error(`JSON 문법 오류: ${e}`);
    }
    const errs = checkSave(s);
    if (errs.length) throw new Error('쓰지 않음 —\n· ' + errs.join('\n· '));
    if (JSON.stringify(s) === JSON.stringify(cur.save)) return say('바뀐 게 없습니다');
    if (!confirm(`${cur.save.name}(Lv${cur.save.lv}) 게임 서버 저장을 바꿉니다${from ? ` (백업 ${from} 판으로)` : ''}.\n` +
      '· 고치기 전 판은 서버 백업(hist/…-replaced)에 남습니다\n' +
      (cur.online ? '· 지금 들어와 있어서 그 접속은 끊깁니다 — 다시 들어오면 고친 판으로 이어집니다\n' : '') + '계속할까요?')) return;
    try {
      await call(`/${cur.h}`, { method: 'PUT', body: JSON.stringify({ json: JSON.stringify(s), ver: cur.ver }) });
    } catch (e: any) {
      if (e?.status === 409) throw new Error('그새 게임에서 바뀌었습니다(놀고 있는 중) — 쓰지 않음. 다시 열어서 고치세요');
      throw e;
    }
    rows = (await call('')).rows ?? [];
    await open(cur.h, '게임 서버에 썼습니다 · 고치기 전 판은 백업에');
  }

  const editor = () => el.querySelector<HTMLTextAreaElement>('.og-json');
  function summary(s: any) {
    const box = el.querySelector('.og-sum');
    if (!box) return;
    const pets = Array.isArray(s?.pets) ? s.pets : [];
    const qs = Array.isArray(s?.quests) ? s.quests : [];
    box.innerHTML =
      `<b>${esc(s?.name)}</b> Lv${esc(s?.lv)} · 라이 ${esc((s?.money ?? 0).toLocaleString?.('ko-KR') ?? s?.money)} · 놀이 ${hours(s?.playTime)}` +
      ` · 펫 ${pets.length}마리(${pets.map((p: any, i: number) => `${esc(p.title || p.sp)} Lv${esc(p.lv)}${i === s.active ? '★' : ''}`).join(', ') || '없음'})` +
      ` · 가방 ${Array.isArray(s?.inv) ? s.inv.length : 0}종 · 퀘스트 완료 ${qs.filter((q: any) => q.st === 2).length}/${qs.length} · 도감 ${Array.isArray(s?.dex) ? s.dex.length : 0}`;
  }

  // 틀은 한 번만 — 자동 새로고침이 검색 칸·편집기를 다시 그리지 않도록 영역(요약·카드·목록·상세)을 나눠 그린다
  el.innerHTML = `
      <div class="kt-bar"><div class="sum"><b>사용자 · 게임 서버 저장</b> — <span class="mono">game.seanson.com</span>(Lightsail 서울) · 저장의 정본(혼자 하기 없음).
        줄을 누르면 편집기가 열립니다(어느 기기에서나). 들어와 있는 사람은 지금 게임 판을 보여 주고, 쓰면 그 접속을 끊은 뒤 씁니다. 고칠 때마다 고치기 전 판이 서버 백업에 남고, 날마다 첫 저장 전 판도 14일 남습니다.
        시험 계정은 기본으로 숨깁니다(보기에서만 — 세이브는 그대로).</div>
        <button type="button" class="og-reload">새로고침</button></div>
      <p class="og-stat"></p>
      <div class="og-ops"></div>
      <div class="og-ctl">
        <input type="search" class="og-q" placeholder="이름·이메일·uid·h 검색" aria-label="사용자 검색" autocomplete="off" spellcheck="false">
        <label><input type="checkbox" class="og-group"> 계정별로 묶기</label>
        <label><input type="checkbox" class="og-test"> <span class="og-tn">시험 보기</span></label>
        <label title="이 화면이 보일 때만 · 열린 편집기는 그대로"><input type="checkbox" class="og-auto" checked> 1분마다 새로고침</label>
        <span class="og-at muted"></span>
      </div>
      <p class="msg og-msg"></p>
      <div class="og-list"></div>
      <div class="og-cur"></div>`;
  const pick = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;

  function render() {
    renderTop();
    renderCur();
  }
  // 요약 한 줄 · 운영 카드 · 목록
  function renderTop() {
    if (!at) return;
    pick('.og-stat').innerHTML = statHtml(rows, showTest);
    const trash: any[] = ops.trash?.rows ?? [];
    const provOf = (uid: string) => rows.find((r) => r.uid === uid)?.provider ?? trash.find((r) => r.uid === uid)?.provider;
    const nameOf = (uid: string) => rows.filter((r) => r.uid === uid).map((r) => r.name).join('·');
    pick('.og-ops').innerHTML = opsHtml(ops, showTest, provOf, nameOf, us);
    pick('.og-at').textContent = `갱신 ${new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    renderList();
  }
  function renderList() {
    const all = rows.map((r) => ({ r, k: kindOf(r.uid, r.provider), last: lastOf(r) }));
    type X = (typeof all)[number];
    const tests = all.filter((x) => x.k === 'test');
    const tAcct = new Set(tests.map((x) => x.r.uid || x.r.h)).size;
    pick('.og-tn').textContent = `시험 ${tests.length}개 보기${tAcct ? `(계정 ${tAcct})` : ''}`;
    const s = q.trim().toLowerCase();
    const hit = (r: Row) => !s || [r.name, r.email, r.uid, r.h].some((v) => (v || '').toLowerCase().includes(s));
    const val = (x: X) => (sort.k === 'last' ? x.last : Number((x.r as any)[sort.k]) || 0);
    // 접속 중인 줄이 늘 위 → 고른 열 → 최근 접속
    const vis = all
      .filter((x) => (showTest || x.k !== 'test') && hit(x.r))
      .sort((a, b) => +!!b.r.online - +!!a.r.online ||
        (sort.k === 'name' ? sort.dir * String(a.r.name ?? '').localeCompare(String(b.r.name ?? ''), 'ko') : sort.dir * (val(a) - val(b))) ||
        b.last - a.last);
    const hidden = !showTest && s ? tests.filter((x) => hit(x.r)).length : 0;
    const uid8 = (r: Row) => `<span class="mono" title="${esc(r.uid)}">${esc((r.uid || '').slice(0, 8))}…</span>`;
    const mark = (r: Row, k: Kind) => r.uid
      ? `<button type="button" class="og-mark" data-uid="${esc(r.uid)}" data-p="${esc(r.provider)}" title="계정 단위 · 이 브라우저에만 저장">${k === 'test' ? '시험 해제' : '시험으로 표시'}</button>` : '';
    const row = (x: X) => `<tr data-h="${esc(x.r.h)}" class="${cur?.h === x.r.h ? 'on' : ''}${x.k === 'test' ? ' og-dim' : ''}">
        <td><b>${esc(x.r.name)}</b>${x.r.online ? ' <span class="og-on" title="지금 들어와 있음">●</span>' : ''}${BADGE[x.k]}</td><td>${esc(x.r.lv)}</td><td>${hours(x.r.playTime)}</td>
        <td class="og-sm">${esc((x.r.money ?? 0).toLocaleString('ko-KR'))}</td><td>${esc(prov(x.r.provider))}</td><td class="og-em" title="${esc(x.r.email)}">${esc(x.r.email)}</td>
        <td title="들어온 때 ${esc(when(x.r.lastJoin) || '모름')} · 마지막 저장 ${esc(when(x.r.mtime))}">${x.r.online ? '<b>접속 중</b>' : ago(x.last)}</td><td class="og-sm">${uid8(x.r)}</td><td>${group ? '' : mark(x.r, x.k)}</td></tr>`;
    let body = '';
    if (group) {
      const g = new Map<string, X[]>();
      vis.forEach((x) => {
        const key = x.r.uid || 'h:' + x.r.h;
        if (!g.has(key)) g.set(key, []);
        g.get(key)!.push(x);
      });
      body = [...g.values()].map((xs) => {
        const f = xs[0];
        const n = f.r.uid ? all.filter((y) => y.r.uid === f.r.uid).length : 1;
        return `<tr class="og-acct${f.k === 'test' ? ' og-dim' : ''}"><td colspan="9">${uid8(f.r)} · ${esc(prov(f.r.provider))}${f.r.email ? ` · ${esc(f.r.email)}` : ''} · 캐릭 ${n}/3${BADGE[f.k]} ${mark(f.r, f.k)}</td></tr>` + xs.map(row).join('');
      }).join('');
    } else body = vis.map(row).join('');
    const empty = !rows.length ? '없음' : s ? '검색 결과 없음' : `실사용자 캐릭이 아직 없습니다${tests.length ? ` — 시험 ${tests.length}개 숨김` : ''}`;
    const th = (k: SortKey | '', label: string, cls = '') => k
      ? `<th class="${cls}" aria-sort="${sort.k === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="og-th" data-k="${k}">${label}${sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`
      : `<th class="${cls}">${label}</th>`;
    pick('.og-list').innerHTML = `<div class="oc-wrap"><table class="oc-table"><thead><tr>${th('name', '이름')}${th('lv', 'Lv')}${th('playTime', '놀이')}${th('money', '라이', 'og-sm')}${th('', '로그인')}${th('', '이메일', 'og-em')}${th('last', '최근 접속')}${th('', 'uid', 'og-sm')}${th('', '')}</tr></thead>
        <tbody>${body || `<tr><td colspan="9" class="muted">${empty}</td></tr>`}</tbody></table></div>` +
      (hidden ? `<p class="note">검색에 걸린 시험 캐릭 ${hidden}개는 숨겨져 있습니다 — 「시험 보기」를 켜면 보입니다</p>` : '');
    pick('.og-list').querySelectorAll<HTMLTableRowElement>('tbody tr[data-h]').forEach((tr) => tr.addEventListener('click', (e) => {
      if ((e.target as Element).closest('button')) return;
      run(() => open(tr.dataset.h!));
    }));
    pick('.og-list').querySelectorAll<HTMLButtonElement>('.og-th').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k as SortKey;
      sort = sort.k === k ? { k, dir: sort.dir > 0 ? -1 : 1 } : { k, dir: k === 'name' ? 1 : -1 };
      renderList();
    }));
    pick('.og-list').querySelectorAll<HTMLButtonElement>('.og-mark').forEach((b) => b.addEventListener('click', () => {
      const uid = b.dataset.uid!;
      const p = b.dataset.p || undefined;
      const on = kindOf(uid, p) !== 'test';
      setTest(uid, on, p);
      renderTop();
      const names = rows.filter((r) => r.uid === uid).map((r) => r.name).join('·');
      say(`${names} 계정을 ${on ? '시험으로 표시' : '시험에서 해제'}했습니다 — 이 브라우저에만 저장(맥 관리 도구의 시험 목록은 따로)${on && !showTest ? ' · 「시험 보기」를 켜면 보입니다' : ''}`, 'ok');
    }));
  }

  // 열린 사용자 편집기
  function renderCur(keepEditor = false) {
    const keep = keepEditor ? editor()?.value : undefined;
    const box = pick('.og-cur');
    box.innerHTML = cur ? `<div class="oc-detail">
        <p class="og-sum"></p>
        <p class="note">uid <span class="mono">${esc(cur.uid)}</span> · ${esc(cur.email)} · 판 <span class="mono">${esc(cur.ver)}</span>${cur.online ? ' · <b>지금 들어와 있음</b>' : ''}${BADGE[kindOf(cur.uid, rows.find((r) => r.h === cur!.h)?.provider)]}</p>
        <div class="tools"><label>라이 <input type="number" class="og-money" min="0" step="1" value="${esc(cur.save.money ?? 0)}"></label>
          <button type="button" class="og-money-set">편집기에 라이 넣기</button>
          <button type="button" class="primary og-write">서버에 쓰기</button>
          <button type="button" class="og-revert">다시 읽기(편집 버림)</button>${onPick ? '\n          <button type="button" class="og-tool" title="펫·아이템·회복 단추 편집기 — 집 Mac 관리 도구가 켜져 있을 때만">관리 도구에서 고치기 ↓</button>' : ''}</div>
        <textarea class="og-json oc-json" spellcheck="false" rows="18"></textarea>
        <details class="oc-days"${hist.length ? '' : ' hidden'}><summary>백업 ${hist.length}개</summary>
          <ul>${hist.map((d) => `<li><span class="mono">${esc(d.id)}</span> · ${d.kind === 'day' ? '그날 첫 판' : '고치기 전'} · Lv${esc(d.lv)} · 놀이 ${hours(d.playTime)} <button type="button" class="og-bk" data-id="${esc(d.id)}">편집기에 올리기</button></li>`).join('')}</ul>
        </details></div>` : '';
    if (cur) {
      editor()!.value = keep ?? JSON.stringify(cur.save, null, 2);
      summary(keep ? JSON.parse(keep) : cur.save);
    }
    box.querySelector('.og-write')?.addEventListener('click', () => run(write));
    box.querySelector('.og-revert')?.addEventListener('click', () => run(() => open(cur!.h)));
    box.querySelector('.og-tool')?.addEventListener('click', () => {
      const m = cur && onPick ? onPick(cur.h, true) : '';
      if (m) say(m, 'err');
    });
    box.querySelector('.og-money-set')?.addEventListener('click', () => {
      try {
        const s = JSON.parse(editor()!.value);
        s.money = Math.max(0, Math.trunc(Number(el.querySelector<HTMLInputElement>('.og-money')!.value) || 0));
        editor()!.value = JSON.stringify(s, null, 2);
        summary(s);
        say(`편집기의 라이를 ${s.money.toLocaleString('ko-KR')} 로 바꿨습니다 — '서버에 쓰기'로 저장`, 'ok');
      } catch (e) {
        say(`편집기 JSON 문법 오류: ${e}`, 'err');
      }
    });
    box.querySelectorAll<HTMLButtonElement>('.og-bk').forEach((b) => b.addEventListener('click', () => run(() => loadBackup(b.dataset.id!))));
    box.querySelector('.og-json')?.addEventListener('input', () => {
      try {
        summary(JSON.parse(editor()!.value));
      } catch {}
    });
  }

  // 틀의 조작 — 한 번만 묶는다
  pick('.og-reload').addEventListener('click', () => run(async () => {
    await load();
    if (cur) await open(cur.h);
  }));
  pick<HTMLInputElement>('.og-q').addEventListener('input', (e) => {
    q = (e.target as HTMLInputElement).value;
    renderList();
  });
  pick<HTMLInputElement>('.og-group').addEventListener('change', (e) => {
    group = (e.target as HTMLInputElement).checked;
    renderList();
  });
  pick<HTMLInputElement>('.og-test').addEventListener('change', (e) => {
    showTest = (e.target as HTMLInputElement).checked;
    renderTop();
  });
  pick<HTMLInputElement>('.og-auto').addEventListener('change', (e) => {
    auto = (e.target as HTMLInputElement).checked;
  });
  // 1분 자동 새로고침 — 이 패널이 화면에 보이고(다른 앱 탭·로그아웃·백그라운드 탭이면 쉼) 다른 일이 없을 때만
  let quiet = false;
  window.setInterval(async () => {
    if (!auto || busy || quiet || !at || document.hidden || !el.isConnected || el.offsetParent === null) return;
    quiet = true;
    try {
      await load(true);
    } catch (e: any) {
      say(`자동 새로고침 실패 — ${e?.message ?? e}`, 'err');
    } finally {
      quiet = false;
    }
  }, AUTO_MS);

  return { load: () => run(() => load()) };
}
