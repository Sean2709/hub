// orunka.com 게시판 조회 묶음 통계 카드 — /admin/ 앱 관리 탭 '오룬카'에서 mount (orunka-web 게시판 API 계약 v4)
//   GET https://orunka.com/api/admin/views?days=N (운영자 = 게시판 API 의 admin uid, Bearer = orunka-game Firebase ID 토큰)
//   → {days, from, to, tz, total, posts:[{id, board, title, exists, viewCount, views, auth, lang, device, ref, hours:[{at, n}], last}]}
// 사람 정보는 서버에 없다(글 × 한국 시각 1시간 칸의 숫자뿐). 이 카드는 읽기만 한다 — 조회수를 올리지 않음
import { orunkaFbToken } from './orunka-game-saves';
import { esc } from './orunka-admin-extra';

export const BOARD_API = 'https://orunka.com/api';
const BOARD: Record<string, string> = { notice: '공지', update: '업데이트', free: '자유', tips: '팁', qna: '질문', party: '파티', tribe: '부족' };
const GROUPS: [key: 'auth' | 'lang' | 'device' | 'ref', name: string, labels: Record<string, string>][] = [
  ['auth', '로그인', { in: '로그인', out: '비로그인' }],
  ['lang', '페이지 언어', { ko: '한국어', en: '영어', unknown: '모름' }],
  ['device', '기기', { windows: 'Windows', mac: 'Mac', iphone: 'iPhone', ipad: 'iPad', android: 'Android', other: '기타', bot: '봇' }],
  ['ref', '들어온 곳', { orunka: 'orunka.com 안', search: '검색', steam: 'Steam 커뮤니티', steamstore: 'Steam 상점', apple: 'Apple', none: '바로 들어옴', other: '다른 사이트', unknown: '모름' }],
];
type Counts = Record<string, number>;
type Agg = { views: number; auth: Counts; lang: Counts; device: Counts; ref: Counts };
type Post = Agg & { id: string; board: string | null; title: string | null; exists: boolean; hidden?: boolean; viewCount: number | null; hours: { at: string; n: number }[]; last: string | null };
type Res = { days: number; from: string; to: string; total: Agg; posts: Post[] };

const KST = 9 * 3600e3;
const hourKey = (ms: number) => new Date(ms + KST).toISOString().slice(0, 13); // 'YYYY-MM-DDTHH' (한국 시각)
const slot = (at: string) => `${at.slice(5, 7)}.${at.slice(8, 10)} ${at.slice(11, 13)}시`;
const num = (n: number) => n.toLocaleString('ko-KR');

export function mountOrunkaBoardViews(el: HTMLElement, googleIdToken: () => string | null, api = BOARD_API) {
  let days = 7;
  let res: Res | null = null;
  let sel = '';
  let busy = false;
  el.className = 'kt oc og ob';
  el.innerHTML = `
    <div class="kt-bar"><div class="sum"><b>게시판 조회</b> · <span class="mono">orunka.com</span> 글을 언제, 어떤 경로로 봤는지 묶음 숫자로 봅니다.</div>
      <select class="ob-days" aria-label="기간"><option value="1">오늘</option><option value="2">2일</option><option value="7" selected>7일</option><option value="30">30일</option><option value="90">90일</option></select>
      <button type="button" class="ob-reload">새로고침</button></div>
    <p class="og-stat ob-stat"></p>
    <p class="msg ob-msg"></p>
    <div class="ob-list"></div>
    <div class="ob-cur"></div>
    <p class="ob-note muted">운영자와 글쓴이가 본 것은 세지 않습니다. 묶음 통계는 11월 1일 배포 뒤 조회부터 모았고, 그 전 조회는 전체 조회수에만 있습니다. 누가 봤는지는 남기지 않고 숫자만 셉니다.</p>`;
  const pick = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
  const say = (t: string, cls = '') => { const m = pick('.ob-msg'); m.textContent = t; m.className = 'msg ob-msg ' + cls; };

  async function call(path: string) {
    let r: Response;
    try {
      r = await fetch(api + path, { headers: { Authorization: `Bearer ${await orunkaFbToken(googleIdToken)}` }, cache: 'no-store' });
    } catch (e) {
      throw new Error(`게시판 API 에 닿지 않습니다(${api}) · ${e}`);
    }
    const j = await r.json().catch(() => ({}));
    if (j?.error === 'admin_only') throw new Error('게시판 운영자 계정이 아닙니다. 게시판 API 의 운영자 uid 에 이 Google 계정이 있어야 합니다');
    if (!r.ok) throw new Error(j?.message ? `${j.message} (${j.error})` : `게시판 API ${r.status}`);
    return j;
  }

  const chips = (c: Counts, labels: Record<string, string>) => {
    const xs = Object.keys(labels).filter((k) => (c?.[k] || 0) > 0);
    return xs.length ? xs.map((k) => `<span class="ob-chip">${esc(labels[k])} <b>${num(c[k])}</b></span>`).join('') : '<span class="muted">없음</span>';
  };
  const split = (a: Agg) => `<dl class="ob-split">${GROUPS.map(([g, name, labels]) => `<div><dt>${name}</dt><dd>${chips(a[g], labels)}</dd></div>`).join('')}</dl>`;

  // 막대 — 2일까지는 1시간 칸 그대로, 그보다 길면 하루 합
  function bars(p: Post) {
    if (!res) return '';
    const m = new Map(p.hours.map((h) => [h.at.slice(0, 13), h.n]));
    const end = Date.now();
    const cells: { k: string; n: number; lab: string; tick: boolean }[] = [];
    if (res.days <= 2) {
      const start = Date.parse(res.from + 'T00:00:00+09:00');
      for (let t = start; t <= end; t += 3600e3) {
        const k = hourKey(t);
        const hh = +k.slice(11, 13);
        cells.push({ k, n: m.get(k) || 0, lab: `${slot(k)} · ${m.get(k) || 0}`, tick: hh % 6 === 0 });
      }
    } else {
      const byDay = new Map<string, number>();
      for (const [k, n] of m) byDay.set(k.slice(0, 10), (byDay.get(k.slice(0, 10)) || 0) + n);
      const start = Date.parse(res.from + 'T00:00:00+09:00');
      for (let t = start; t <= end; t += 86400e3) {
        const d = hourKey(t).slice(0, 10);
        cells.push({ k: d, n: byDay.get(d) || 0, lab: `${d.slice(5, 7)}.${d.slice(8, 10)} · ${byDay.get(d) || 0}`, tick: true });
      }
    }
    const max = Math.max(1, ...cells.map((c) => c.n));
    const ticks = cells.filter((c) => c.tick);
    const step = Math.max(1, Math.ceil(ticks.length / 8));
    return `<div class="ob-bars" role="img" aria-label="${res.days <= 2 ? '1시간' : '하루'} 단위 조회 막대">${cells
      .map((c) => `<span class="ob-bar${c.n ? '' : ' z'}" style="height:${c.n ? Math.max(6, Math.round((c.n / max) * 100)) : 2}%" title="${esc(c.lab)}"></span>`)
      .join('')}</div><div class="ob-axis">${ticks
      .filter((_, i) => i % step === 0)
      .map((c) => `<span>${res!.days <= 2 ? `${c.k.slice(8, 10)}일 ${c.k.slice(11, 13)}시` : `${c.k.slice(5, 7)}.${c.k.slice(8, 10)}`}</span>`)
      .join('')}</div>`;
  }

  function drawList() {
    if (!res) return;
    const t = res.total;
    pick('.ob-stat').innerHTML = `<span class="og-st-h">${res.days === 1 ? '오늘' : `${esc(res.from)} ~ ${esc(res.to)}`}</span><span class="og-st">조회 <b>${num(t.views)}</b></span><span class="og-st">글 <b>${res.posts.length}</b></span><span class="og-st">비로그인 <b>${num(t.auth.out || 0)}</b></span><span class="og-st">봇 <b>${num(t.device.bot || 0)}</b></span>`;
    if (!res.posts.length) {
      pick('.ob-list').innerHTML = '<p class="muted ob-empty">이 기간에 센 조회가 없습니다.</p>';
      pick('.ob-cur').innerHTML = '';
      return;
    }
    if (!res.posts.some((p) => p.id === sel)) sel = res.posts[0].id;
    pick('.ob-list').innerHTML = `<div class="oc-wrap"><table class="oc-table ob-table"><thead><tr><th>게시판</th><th>제목</th><th class="r">기간 조회</th><th class="r">전체 조회</th><th>마지막</th></tr></thead><tbody>${res.posts
      .map(
        (p) =>
          `<tr data-id="${esc(p.id)}" class="${p.id === sel ? 'on' : ''}" tabindex="0"><td>${esc(BOARD[p.board || ''] || p.board || '')}</td><td class="ob-t">${p.exists ? esc(p.title) : '<span class="muted">지운 글</span>'}${p.hidden ? ' <span class="og-b test">숨김</span>' : ''}</td><td class="r"><b>${num(p.views)}</b></td><td class="r">${p.viewCount == null ? '<span class="muted">-</span>' : num(p.viewCount)}</td><td class="muted">${p.last ? slot(p.last) : ''}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
    drawCur();
  }
  function drawCur() {
    const p = res?.posts.find((x) => x.id === sel);
    if (!p) { pick('.ob-cur').innerHTML = ''; return; }
    const before = p.viewCount == null ? '' : p.viewCount - p.views;
    const recent = [...p.hours].reverse().slice(0, 24).map((h) => `${slot(h.at)} <b>${h.n}</b>`).join('<span class="dot">·</span>');
    // 글 링크는 두지 않는다 — 로그아웃 상태로 열면 그 자체가 조회로 셈해짐
    pick('.ob-cur').innerHTML = `<div class="oc-detail ob-detail">
      <p class="oc-sum"><b>${p.exists ? esc(p.title) : '지운 글'}</b> <span class="muted mono">${esc(p.id)}</span><br><span class="muted">기간 조회 ${num(p.views)}${before !== '' ? ` · 이 기간 밖이거나 통계 전 조회 ${num(Math.max(0, before))}` : ''}</span></p>
      ${bars(p)}
      <p class="ob-recent"><span class="muted">조회 있던 시간</span> ${recent}</p>
      ${split(p)}
    </div>`;
  }

  async function load() {
    if (busy) return;
    busy = true;
    el.querySelectorAll('button, select').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    say('게시판 조회 통계 읽는 중…');
    try {
      res = await call(`/admin/views?days=${days}`);
      say('');
      drawList();
    } catch (e: any) {
      say(String(e?.message ?? e), 'err');
    } finally {
      busy = false;
      el.querySelectorAll('button, select').forEach((b) => ((b as HTMLButtonElement).disabled = false));
    }
  }

  pick('.ob-reload').addEventListener('click', load);
  pick<HTMLSelectElement>('.ob-days').addEventListener('change', (e) => { days = +(e.target as HTMLSelectElement).value || 7; load(); });
  const choose = (tr: Element | null) => { const id = (tr as HTMLElement | null)?.dataset.id; if (!id) return; sel = id; el.querySelectorAll('.ob-table tr.on').forEach((x) => x.classList.remove('on')); tr!.classList.add('on'); drawCur(); };
  pick('.ob-list').addEventListener('click', (e) => choose((e.target as HTMLElement).closest('tr[data-id]')));
  pick('.ob-list').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') choose((e.target as HTMLElement).closest('tr[data-id]')); });
  return { load };
}
