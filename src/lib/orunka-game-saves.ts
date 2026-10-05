// 오룬카 게임 서버 저장 관리 패널(wss://game.seanson.com 서버의 /admin/api/saves) — /admin/ 앱 관리 탭 '오룬카'에서 mount.
// 혼자 하기를 없애며(Sean 10-05 "전부 서버로", OrunkaUnity D57) 저장의 정본 = 게임 서버. Firestore 저장은 첫 접속 때 서버가 한 번 옮겨 간다.
// 계약 = OrunkaUnity tools/server/Saves.cs
//   GET /admin/api/saves → {rows:[{h, uid, email, provider, name, lv, playTime, money, mtime, online, lastJoin}]}
//   GET /admin/api/saves/{h} → {h, uid, email, online, ver, json}   (들어와 있으면 지금 Game 판)
//   PUT /admin/api/saves/{h} {json, ver} → 409 = 그새 바뀜 · 들어와 있으면 그 접속을 끊고 씀(다시 들어오면 고친 판)
//   GET …/{h}/hist → {rows:[{id, kind, mtime, name, lv, playTime}]} · GET …/hist/{id} → {json}
// 인증 = 관리자 Google → orunka-game Firebase ID 토큰(Bearer, email_verified) — orunka-cloud.ts 와 같은 교환·같은 캐시
import { checkSave } from './orunka-cloud';

const API_KEY = 'AIzaSyC4gjiwEudf6GMBpm1u3vlGEmhk-lBijKs';
const SS_FB = 'hub.admin.orunka.fbtoken';
export const GAME_API = 'https://game.seanson.com/admin/api/saves';

type Row = { h: string; uid?: string; email?: string; provider?: string; name?: string; lv?: number; playTime?: number; money?: number; mtime?: string; online?: boolean; lastJoin?: string };
type Hist = { id: string; kind: string; mtime: string; name?: string; lv?: number; playTime?: number };
type Cur = { h: string; uid?: string; email?: string; online: boolean; ver: string; save: any };

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hours = (sec?: number) => {
  const m = Math.round((Number(sec) || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
};
const when = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const prov = (p?: string) => (p === 'apple.com' ? 'Apple' : p === 'google.com' ? 'Google' : p === 'anonymous' ? '익명' : p || '');

export function mountOrunkaGameSaves(el: HTMLElement, googleIdToken: () => string | null, api = GAME_API) {
  let rows: Row[] = [];
  let cur: Cur | null = null;
  let hist: Hist[] = [];
  let from = '';
  let busy = false;
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
  async function call(path: string, init: RequestInit = {}) {
    let r: Response;
    try {
      r = await fetch(api + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await token()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store' });
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

  async function load() {
    say('게임 서버 저장 목록 읽는 중…');
    rows = (await call('')).rows ?? [];
    render();
    say(rows.length ? `게임 서버 저장 ${rows.length}개 · 들어와 있음 ${rows.filter((r) => r.online).length}명` : '아직 게임 서버에 저장이 없습니다 — 새 판(함께 사냥) 게임으로 들어오면 생깁니다(첫 접속 때 Firestore 저장을 옮겨 옴)', 'ok');
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

  function render(keepEditor = false) {
    const keep = keepEditor ? editor()?.value : undefined;
    const tr = rows
      .map((r) => `<tr data-h="${esc(r.h)}" class="${cur?.h === r.h ? 'on' : ''}">
        <td><b>${esc(r.name)}</b>${r.online ? ' <span class="og-on" title="지금 들어와 있음">●</span>' : ''}</td><td>${esc(r.lv)}</td><td>${hours(r.playTime)}</td>
        <td>${esc((r.money ?? 0).toLocaleString('ko-KR'))}</td><td>${esc(prov(r.provider))}</td><td>${esc(r.email)}</td><td>${when(r.mtime)}</td><td class="mono" title="${esc(r.uid)}">${esc((r.uid || '').slice(0, 8))}…</td></tr>`)
      .join('');
    el.innerHTML = `
      <div class="kt-bar"><div class="sum"><b>사용자 · 게임 서버 저장</b> — <span class="mono">game.seanson.com</span>(Lightsail 서울) · 저장의 정본(혼자 하기 없음).
        줄을 누르면 편집기가 열립니다(어느 기기에서나). 들어와 있는 사람은 지금 게임 판을 보여 주고, 쓰면 그 접속을 끊은 뒤 씁니다. 고칠 때마다 고치기 전 판이 서버 백업에 남고, 날마다 첫 저장 전 판도 14일 남습니다.</div>
        <button type="button" class="og-reload">새로고침</button></div>
      <p class="msg og-msg"></p>
      <div class="oc-wrap"><table class="oc-table"><thead><tr><th>이름</th><th>Lv</th><th>놀이</th><th>라이</th><th>로그인</th><th>이메일</th><th>마지막 저장</th><th>uid</th></tr></thead>
        <tbody>${tr || '<tr><td colspan="8" class="muted">없음</td></tr>'}</tbody></table></div>
      ${cur ? `<div class="oc-detail">
        <p class="og-sum"></p>
        <p class="note">uid <span class="mono">${esc(cur.uid)}</span> · ${esc(cur.email)} · 판 <span class="mono">${esc(cur.ver)}</span>${cur.online ? ' · <b>지금 들어와 있음</b>' : ''}</p>
        <div class="tools"><label>라이 <input type="number" class="og-money" min="0" step="1" value="${esc(cur.save.money ?? 0)}"></label>
          <button type="button" class="og-money-set">편집기에 라이 넣기</button>
          <button type="button" class="primary og-write">서버에 쓰기</button>
          <button type="button" class="og-revert">다시 읽기(편집 버림)</button></div>
        <textarea class="og-json oc-json" spellcheck="false" rows="18"></textarea>
        <details class="oc-days"${hist.length ? '' : ' hidden'}><summary>백업 ${hist.length}개</summary>
          <ul>${hist.map((d) => `<li><span class="mono">${esc(d.id)}</span> · ${d.kind === 'day' ? '그날 첫 판' : '고치기 전'} · Lv${esc(d.lv)} · 놀이 ${hours(d.playTime)} <button type="button" class="og-bk" data-id="${esc(d.id)}">편집기에 올리기</button></li>`).join('')}</ul>
        </details></div>` : ''}`;
    if (cur) {
      editor()!.value = keep ?? JSON.stringify(cur.save, null, 2);
      summary(keep ? JSON.parse(keep) : cur.save);
    }
    el.querySelector('.og-reload')!.addEventListener('click', () => run(async () => {
      await load();
      if (cur) await open(cur.h);
    }));
    el.querySelectorAll<HTMLTableRowElement>('.oc-table tbody tr[data-h]').forEach((tr) => tr.addEventListener('click', () => run(() => open(tr.dataset.h!))));
    el.querySelector('.og-write')?.addEventListener('click', () => run(write));
    el.querySelector('.og-revert')?.addEventListener('click', () => run(() => open(cur!.h)));
    el.querySelector('.og-money-set')?.addEventListener('click', () => {
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
    el.querySelectorAll<HTMLButtonElement>('.og-bk').forEach((b) => b.addEventListener('click', () => run(() => loadBackup(b.dataset.id!))));
    el.querySelector('.og-json')?.addEventListener('input', () => {
      try {
        summary(JSON.parse(editor()!.value));
      } catch {}
    });
  }

  render();
  return { load: () => run(load) };
}
