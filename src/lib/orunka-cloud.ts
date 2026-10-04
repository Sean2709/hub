// 오룬카 서버 저장(Firebase orunka-game · Firestore 서울) 관리 패널 — /admin/ 앱 관리 탭 '오룬카'에서 mount.
// 로컬 관리 도구(127.0.0.1:7800)와 달리 어느 기기에서나 된다(브라우저 → Firestore 직접).
// 계약 = OrunkaUnity tools/cloud/README.md
//   saves/{uid} = json 문자열(JsonUtility SaveData) + name·lv·playTime·ver·device·client·savedAt
//   saves/{uid}/days/{id} = 백업(yyyyMMdd 그날 첫 올림 · replaced-yyyyMMdd-HHmmss 덮어쓰기 전 판)
//   쓰기는 늘 updateTime 전제조건 → 그새 게임이 올렸으면 거절(덮어쓰지 않음)
// 고칠 때는 덮어쓰기 전 판을 days/replaced-… 로 같은 commit 에 남긴다(원자적). device/client = 'admin'.
// 관리자 = seanson2709@gmail.com(규칙 admin()) — hub Google ID 토큰을 orunka-game Firebase 토큰으로 교환
// (orunka-game Google 공급자 clientId = hub GIS 클라이언트라 가능, knowthat-app 과 같은 방식).
const PROJECT = 'orunka-game';
const API_KEY = 'AIzaSyC4gjiwEudf6GMBpm1u3vlGEmhk-lBijKs';
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const FS = `https://firestore.googleapis.com/v1/${DOCS}`;
const SS_FB = 'hub.admin.orunka.fbtoken';
const MASK = ['name', 'lv', 'playTime', 'ver', 'device', 'client', 'savedAt'];

type Val = Record<string, any>;
type Fields = Record<string, Val>;
type Row = { id: string; updateTime: string; name?: string; lv?: number; playTime?: number; ver?: number; device?: string; client?: string; savedAt?: string };
type Full = { uid: string; updateTime: string; fields: Fields; save: any };

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const val = (v: Val | undefined): any => {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  return undefined;
};
const p2 = (n: number) => String(n).padStart(2, '0');
/** 기기 시각 ISO(+09:00 꼴) — serve.py·게임 savedAt 과 같은 꼴 */
export function isoLocal(d = new Date()) {
  const o = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
    `${o >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(o) / 60))}:${p2(Math.abs(o) % 60)}`;
}
export const backupId = (d = new Date()) =>
  `replaced-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
/** serve.py cloud_save_doc 과 같은 필드 8개(규칙 okSave: json 문자열 < 400KB · 필드 ≤ 16) */
export function saveFields(save: any, now = new Date()): Fields {
  return {
    json: { stringValue: JSON.stringify(save) },
    name: { stringValue: String(save.name ?? '') },
    lv: { integerValue: String(Math.trunc(Number(save.lv) || 0)) },
    playTime: { doubleValue: Number(save.playTime) || 0 },
    ver: { integerValue: String(Math.trunc(Number(save.ver) || 0)) },
    device: { stringValue: 'admin' },
    client: { stringValue: 'admin' },
    savedAt: { stringValue: isoLocal(now) },
  };
}
/** 고치기 1번 = commit 하나: 덮어쓰기 전 판 → days/replaced-…, 본문 = updateTime 전제조건 */
export function commitBody(uid: string, prevFields: Fields, prevUpdate: string, save: any, now = new Date()) {
  return {
    writes: [
      { update: { name: `${DOCS}/saves/${uid}/days/${backupId(now)}`, fields: prevFields } },
      { update: { name: `${DOCS}/saves/${uid}`, fields: saveFields(save, now) }, currentDocument: { updateTime: prevUpdate } },
    ],
  };
}
export const FS_URL = FS;
/** 고친 저장이 게임이 읽을 수 있는 꼴인지(최소 검사) → 문제 목록 */
export function checkSave(s: any): string[] {
  const e: string[] = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['저장은 { … } 객체여야 합니다'];
  if (typeof s.name !== 'string' || !s.name) e.push('name(이름) 문자열이 없습니다');
  if (!Number.isInteger(s.lv) || s.lv < 1 || s.lv > 99) e.push('lv(레벨)는 1–99 정수');
  if ('money' in s && (!Number.isInteger(s.money) || s.money < 0)) e.push('money(라이)는 0 이상 정수');
  if ('pets' in s && !Array.isArray(s.pets)) e.push('pets 는 배열');
  if ('inv' in s && !Array.isArray(s.inv)) e.push('inv 는 배열');
  if (JSON.stringify(s).length >= 400000) e.push('저장이 400KB 를 넘습니다(규칙 상한)');
  return e;
}
const hours = (sec?: number) => {
  const m = Math.round((Number(sec) || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
};
const when = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function mountOrunkaCloud(el: HTMLElement, googleIdToken: () => string | null) {
  let rows: Row[] = [];
  let cur: Full | null = null; // 지금 열린 서버 저장
  let days: Row[] = [];
  let from = ''; // 편집기에 올린 판: '' = 서버 지금 판, 그 밖 = 백업 id
  let busy = false;
  el.className = 'kt oc';

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
  async function get(path: string) {
    const r = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 403) throw new Error('권한 없음 — 관리자(seanson2709@gmail.com)로 로그인해야 합니다');
    if (!r.ok && r.status !== 404) throw new Error(`${path.split('?')[0]} 읽기 실패: ${j?.error?.message ?? r.status}`);
    return r.status === 404 ? null : j;
  }
  async function list(path: string): Promise<Row[]> {
    const out: Row[] = [];
    let page = '';
    for (let i = 0; i < 20; i++) {
      const q = `pageSize=100&${MASK.map((k) => `mask.fieldPaths=${k}`).join('&')}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
      const j = await get(`${path}?${q}`);
      for (const d of j?.documents ?? [])
        out.push({ id: d.name.split('/').pop(), updateTime: d.updateTime, ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, val(v as Val)])) });
      page = j?.nextPageToken;
      if (!page) break;
    }
    return out.sort((a, b) => (b.updateTime || '').localeCompare(a.updateTime || ''));
  }

  const say = (text: string, cls = '') => {
    const m = el.querySelector('.oc-msg');
    if (m) {
      m.textContent = text;
      m.className = 'msg oc-msg ' + cls;
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
    say('서버 저장 목록 읽는 중…');
    rows = await list('saves');
    render();
    say(rows.length ? `서버 저장 ${rows.length}개` : '아직 서버에 올라온 저장이 없습니다(게임 제목 화면 왼쪽 위 Google 로그인)', 'ok');
  }
  async function open(uid: string, msg = '') {
    const j = await get(`saves/${uid}`);
    if (!j) throw new Error('그 저장이 서버에서 사라졌습니다 — 새로고침');
    let save: any;
    try {
      save = JSON.parse(j.fields?.json?.stringValue ?? '');
    } catch (e) {
      throw new Error(`서버 저장 json 이 깨졌습니다: ${e}`);
    }
    cur = { uid, updateTime: j.updateTime, fields: j.fields, save };
    from = '';
    days = await list(`saves/${uid}/days`);
    render();
    say(msg || `열었습니다 · 서버 판 ${when(cur.updateTime)}`, msg ? 'ok' : '');
  }
  async function loadBackup(id: string) {
    if (!cur) return;
    const j = await get(`saves/${cur.uid}/days/${id}`);
    const s = JSON.parse(j?.fields?.json?.stringValue ?? 'null');
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
    if (!confirm(`${cur.save.name}(Lv${cur.save.lv}) 서버 저장을 바꿉니다${from ? ` (백업 ${from} 판으로)` : ''}.\n` +
      '· 덮어쓰기 전 판은 days/replaced-… 에 남습니다\n· 지금 그 계정으로 게임이 켜져 있으면 그 기기는 올림을 멈추고 제목 화면에서 맞춥니다(그새 기기에서 더 놀았으면 기기 판이 이기고 이 수정은 백업으로 감)\n계속할까요?')) return;
    const now = new Date();
    const bid = backupId(now);
    const r = await fetch(`${FS}:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commitBody(cur.uid, cur.fields, cur.updateTime, s, now)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = j?.error?.message ?? String(r.status);
      if (j?.error?.status === 'FAILED_PRECONDITION' || /precondition|update time/i.test(m))
        throw new Error('그새 게임(또는 로컬 관리 도구)이 먼저 올렸습니다 — 쓰지 않음. 다시 열어서 고치세요');
      throw new Error(`쓰기 실패: ${m}`);
    }
    rows = await list('saves');
    await open(cur.uid, `서버에 썼습니다 · 고치기 전 판 = days/${bid}`);
  }

  const editor = () => el.querySelector<HTMLTextAreaElement>('.oc-json');
  function summary(s: any) {
    const box = el.querySelector('.oc-sum');
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
      .map((r) => `<tr data-uid="${esc(r.id)}" class="${cur?.uid === r.id ? 'on' : ''}">
        <td><b>${esc(r.name)}</b></td><td>${esc(r.lv)}</td><td>${hours(r.playTime)}</td><td>${esc(r.device)}</td>
        <td>${esc(r.client)}</td><td>${when(r.updateTime)}</td><td class="mono" title="${esc(r.id)}">${esc(r.id.slice(0, 8))}…</td></tr>`)
      .join('');
    el.innerHTML = `
      <div class="kt-bar"><div class="sum"><b>서버 저장</b> — Firebase <span class="mono">orunka-game</span> · Firestore 서울.
        어느 기기에서나 보고 고칩니다(로컬 관리 도구 없이). 고칠 때마다 덮어쓰기 전 판이 <span class="mono">days/replaced-…</span> 에 남습니다.</div>
        <button type="button" class="oc-reload">새로고침</button></div>
      <p class="msg oc-msg"></p>
      <div class="oc-wrap"><table class="oc-table"><thead><tr><th>이름</th><th>Lv</th><th>놀이</th><th>기기</th><th>판</th><th>서버에 올린 때</th><th>uid</th></tr></thead>
        <tbody>${tr || '<tr><td colspan="7" class="muted">없음</td></tr>'}</tbody></table></div>
      ${cur ? `<div class="oc-detail">
        <p class="oc-sum"></p>
        <p class="note">uid <span class="mono">${esc(cur.uid)}</span> · 서버 판 ${when(cur.updateTime)} · 기기 ${esc(val(cur.fields.device))} · 판 ${esc(val(cur.fields.client))}</p>
        <div class="tools"><label>라이 <input type="number" class="oc-money" min="0" step="1" value="${esc(cur.save.money ?? 0)}"></label>
          <button type="button" class="oc-money-set">편집기에 라이 넣기</button>
          <button type="button" class="primary oc-write">서버에 쓰기</button>
          <button type="button" class="oc-revert">다시 읽기(편집 버림)</button></div>
        <textarea class="oc-json" spellcheck="false" rows="18"></textarea>
        <details class="oc-days"${days.length ? '' : ' hidden'}><summary>백업 ${days.length}개 (days/)</summary>
          <ul>${days.map((d) => `<li><span class="mono">${esc(d.id)}</span> · Lv${esc(d.lv)} · 놀이 ${hours(d.playTime)} · ${esc(d.device)} <button type="button" class="oc-bk" data-id="${esc(d.id)}">편집기에 올리기</button></li>`).join('')}</ul>
        </details></div>` : ''}`;
    if (cur) {
      editor()!.value = keep ?? JSON.stringify(cur.save, null, 2);
      summary(keep ? JSON.parse(keep) : cur.save);
    }
    el.querySelector('.oc-reload')!.addEventListener('click', () => run(async () => {
      await load();
      if (cur) await open(cur.uid);
    }));
    el.querySelectorAll<HTMLTableRowElement>('.oc-table tbody tr[data-uid]').forEach((tr) =>
      tr.addEventListener('click', () => run(() => open(tr.dataset.uid!))));
    el.querySelector('.oc-write')?.addEventListener('click', () => run(write));
    el.querySelector('.oc-revert')?.addEventListener('click', () => run(() => open(cur!.uid)));
    el.querySelector('.oc-money-set')?.addEventListener('click', () => {
      try {
        const s = JSON.parse(editor()!.value);
        s.money = Math.max(0, Math.trunc(Number(el.querySelector<HTMLInputElement>('.oc-money')!.value) || 0));
        editor()!.value = JSON.stringify(s, null, 2);
        summary(s);
        say(`편집기의 라이를 ${s.money.toLocaleString('ko-KR')} 로 바꿨습니다 — '서버에 쓰기'로 저장`, 'ok');
      } catch (e) {
        say(`편집기 JSON 문법 오류: ${e}`, 'err');
      }
    });
    el.querySelectorAll<HTMLButtonElement>('.oc-bk').forEach((b) => b.addEventListener('click', () => run(() => loadBackup(b.dataset.id!))));
    el.querySelector('.oc-json')?.addEventListener('input', () => {
      try {
        summary(JSON.parse(editor()!.value));
      } catch {}
    });
  }

  render();
  return { load: () => run(load) };
}
