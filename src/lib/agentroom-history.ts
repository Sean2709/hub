// 방 기록 — /admin/ 「방 기록」(#roomlog)에서 mount. 관문 방에 남은 전체 글을 보기 전용으로(쓰기·long-poll 없음).
//   GET /api/room/history?before=<불투명 커서>&limit=<1~200> (Bearer = admin 의 Google ID 토큰)
//     → {messages:[{id, from, hub, ts(유닉스 초 float), text, kind?:"system"}](한 페이지 안 오래된→새), before: str|null(null = 더 없음), count: int|null, since: float|null, now}
//     before 없으면 가장 최근 페이지. 400 = 엉터리 커서, 401 = 토큰(기존 갱신 흐름), 403 = 권한, 404 = 관문에 아직 없음(「준비 중」)
// 처음 = 최근 100개(맨 아래가 최신) → 위로 스크롤하거나 「이전 글 더 보기」로 before 페이지를 위에 붙임(스크롤 위치 유지).
// 새로고침 = 최신 페이지 다시 받아 id 로 합침(사이가 비면 겹칠 때까지 이어 받음). 글은 msgRow(textContent) 그대로, 찾기 강조도 텍스트 노드 + <mark>.
import { roomApiBase, msgRow, isSean, toMs, h, type Msg } from './agentroom-view';

export type HistoryOpts = {
  idToken: () => string | null;
  onAuthFail: () => void;
  demo?: boolean;
  api?: string;
};

const PAGE = 100;
const GAP_PAGES = 20; // 새로고침 때 사이 메우기 상한(2,000개). 넘으면 최신부터 다시
const STALE_MS = 60_000; // 탭을 다시 열 때 이만큼 지났으면 조용히 새로고침
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const dateShort = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' });
const hms = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmt = (d: Intl.DateTimeFormat, t: unknown) => {
  const ms = toMs(t);
  return Number.isFinite(ms) ? d.format(new Date(ms)) : '';
};
const num = (n: number) => n.toLocaleString('ko-KR');
const ICON = {
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 5v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5M20 19v-4h-4"/></svg>',
  find: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
};

type Page = { messages: Msg[]; before: string | null; count: number | null; since: number | null };
class AuthErr extends Error {}
class HttpErr extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}
const valid = (m: any): m is Msg => !!m && typeof m === 'object' && typeof m.id === 'string' && m.id !== '';
// 보낸 이 거르기 열쇠: 시스템 · Sean(어느 허브든) · 에이전트 이름
const senderOf = (m: Msg) => (m.kind === 'system' ? '\u0000sys' : isSean(m) ? 'Sean' : m.from || '?');
const senderLabel = (k: string) => (k === '\u0000sys' ? '시스템' : k === 'Sean' ? 'Sean(사람)' : k);

export function mountRoomHistory(el: HTMLElement, opts: HistoryOpts) {
  const api = (opts.api || roomApiBase()).replace(/\/+$/, '');
  el.className = 'ar rl';
  // 정적 틀만 innerHTML(고정 글자·아이콘). 방 글·이름은 전부 textContent.
  el.innerHTML = `
    <div class="ar-top rl-top">
      <span class="ar-state"><i class="ar-led" aria-hidden="true"></i><span class="ar-live">불러오는 중…</span></span>
      <span class="rl-stat" title="관문에 남은 전체 글 수"><span class="rl-ic">${ICON.book}</span><b class="rl-count mono">–</b></span>
      <span class="rl-stat" title="가장 오래된 글 날짜"><span class="rl-ic">${ICON.clock}</span><span class="rl-since">–</span></span>
      <span class="ar-sp"></span>
      <button type="button" class="rl-refresh ghost" title="최신 글 다시 받기">${ICON.refresh}<span>새로고침</span></button>
    </div>
    <div class="rl-tools">
      <label class="rl-find"><span class="rl-ic">${ICON.find}</span><input type="search" placeholder="불러온 글에서 찾기" aria-label="불러온 글에서 찾기" enterkeyhint="search" autocomplete="off" spellcheck="false" /></label>
      <select class="rl-from" aria-label="보낸 이 거르기"><option value="">보낸 이 전체</option></select>
      <span class="rl-hits mono" aria-live="polite"></span>
    </div>
    <div class="ar-body">
      <div class="ar-main">
        <div class="ar-log rl-log" role="log" aria-label="방 기록" tabindex="0">
          <div class="rl-more-w" hidden><button type="button" class="rl-more ghost">이전 글 더 보기</button></div>
          <p class="rl-start" hidden>방 기록의 처음이에요</p>
          <div class="ar-empty rl-empty" hidden><span class="rl-ic">${ICON.book}</span><b></b><small></small></div>
          <ol class="ar-list"></ol>
        </div>
        <button type="button" class="ar-down rl-down" hidden>맨 아래 ↓</button>
      </div>
    </div>
    <div class="ar-foot rl-foot"><span class="ar-msg"></span><span class="rl-loaded mono"></span></div>`;
  const pick = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
  const log = pick('.rl-log');
  const list = pick('.ar-list');
  const empty = pick('.rl-empty');
  const moreW = pick('.rl-more-w');
  const moreBtn = pick<HTMLButtonElement>('.rl-more');
  const startEl = pick('.rl-start');
  const down = pick<HTMLButtonElement>('.rl-down');
  const liveEl = pick('.ar-live');
  const refreshBtn = pick<HTMLButtonElement>('.rl-refresh');
  const findIn = pick<HTMLInputElement>('.rl-find input');
  const fromSel = pick<HTMLSelectElement>('.rl-from');
  const hitsEl = pick('.rl-hits');
  const msgEl = pick('.ar-msg');
  const loadedEl = pick('.rl-loaded');

  const byId = new Map<string, Msg>();
  let older: string | null = null; // 더 오래된 페이지 커서(null = 처음까지 다 받음)
  let total: number | null = null;
  let since: number | null = null;
  let loaded = false; // 첫 페이지를 받았나
  let loading = false;
  let selected = false;
  let lastLoad = 0;
  let state: '' | 'notready' | 'forbidden' | 'err' | 'auth' = '';
  let errText = '';
  let authFails = 0;
  let lastAuthFail = 0;
  let failedTok: string | null = null;
  let retryAt = 0;
  let armed = false; // 위로 스크롤 자동 불러오기: 사용자가 한 번 아래로 내려가 있어야(연달아 다 받지 않게)
  let badCursorAt = 0;

  const live = (t: string, cls = '') => {
    liveEl.textContent = t;
    el.dataset.link = cls;
  };
  const note = (t: string, cls = '') => {
    msgEl.textContent = t;
    msgEl.className = 'ar-msg ' + cls;
  };
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  // 코드가 옮긴 스크롤(맨 아래로·제자리 맞추기·목록 다시 그림)은 자동 불러오기 판단에서 뺀다(연달아 다 받지 않게)
  let quietUntil = 0;
  const setTop = (v: number) => {
    quietUntil = performance.now() + 300;
    log.scrollTop = v;
  };
  const toBottom = () => {
    setTop(log.scrollHeight);
    down.hidden = true;
  };

  // ---- 그리기 ----------------------------------------------------------------------
  function sorted() {
    return [...byId.values()].sort((a, b) => toMs(a.ts) - toMs(b.ts) || (a.seq ?? 0) - (b.seq ?? 0));
  }
  function mark(node: Element | null, q: string) {
    if (!node) return;
    const text = node.textContent || '';
    const low = text.toLowerCase();
    if (low.length !== text.length) return; // 소문자로 바꾸면 길이가 달라지는 글자 — 강조만 건너뜀
    const parts: (string | HTMLElement)[] = [];
    let i = 0;
    for (let j = low.indexOf(q); j >= 0; j = low.indexOf(q, j + q.length)) {
      if (j > i) parts.push(text.slice(i, j));
      parts.push(h('mark', '', text.slice(j, j + q.length)));
      i = j + q.length;
    }
    if (!parts.length) return;
    if (i < text.length) parts.push(text.slice(i));
    node.replaceChildren(...parts);
  }
  function syncSenders(all: Msg[]) {
    const n = new Map<string, number>();
    for (const m of all) n.set(senderOf(m), (n.get(senderOf(m)) || 0) + 1);
    const keys = [...n.keys()].sort((a, b) => (a === 'Sean' ? -1 : b === 'Sean' ? 1 : a.startsWith('\u0000') ? 1 : b.startsWith('\u0000') ? -1 : a.localeCompare(b, 'ko')));
    const cur = fromSel.value;
    const opts0 = [h('option', '', '보낸 이 전체')];
    (opts0[0] as HTMLOptionElement).value = '';
    for (const k of keys) {
      const o = h('option', '', `${senderLabel(k)} (${num(n.get(k)!)})`) as HTMLOptionElement;
      o.value = k;
      opts0.push(o);
    }
    if (cur && !n.has(cur)) {
      const o = h('option', '', `${senderLabel(cur)} (0)`) as HTMLOptionElement;
      o.value = cur;
      opts0.push(o);
    }
    fromSel.replaceChildren(...opts0);
    fromSel.value = cur;
  }
  function setEmpty(title: string, sub = '') {
    empty.hidden = !title;
    empty.querySelector('b')!.textContent = title;
    empty.querySelector('small')!.textContent = sub;
  }
  function render() {
    quietUntil = performance.now() + 300; // 목록을 갈아 끼울 때 나는 스크롤 이벤트도 사용자 스크롤이 아님
    const all = sorted();
    const q = findIn.value.trim().toLowerCase();
    const f = fromSel.value;
    syncSenders(all);
    const frag = document.createDocumentFragment();
    let day = '';
    let hits = 0;
    for (const m of all) {
      if (f && senderOf(m) !== f) continue;
      if (q && !`${m.text ?? ''}\n${m.from ?? ''}@${m.hub ?? ''}`.toLowerCase().includes(q)) continue;
      hits++;
      const d = fmt(dayKey, m.ts);
      if (d !== day) {
        day = d;
        const sep = h('li', 'rl-day');
        sep.setAttribute('role', 'separator');
        sep.append(h('span', '', fmt(dayLabel, m.ts) || '날짜 모름'));
        frag.append(sep);
      }
      const li = msgRow(m, { hubAlways: true });
      if (q) mark(li.querySelector('.ar-t, .ar-sys-t'), q);
      frag.append(li);
    }
    list.replaceChildren(frag);
    const filtering = !!(q || f);
    hitsEl.textContent = filtering ? `${num(hits)} / ${num(all.length)}개` : '';
    loadedEl.textContent = loaded ? `불러온 글 ${num(all.length)}${total != null ? ' / ' + num(total) : ''}` : '';
    pick('.rl-count').textContent = total != null ? `${num(total)}개` : loaded ? `${num(all.length)}개+` : '–';
    pick('.rl-since').textContent = since != null ? `${fmt(dateShort, since)}부터` : '–';
    moreW.hidden = !loaded || !older || !!state;
    moreBtn.textContent = filtering ? '이전 글 더 보기(찾기는 불러온 글에서만)' : '이전 글 더 보기';
    startEl.hidden = !loaded || !!older || !all.length || !!state;
    // 빈 상태
    if (state === 'notready') setEmpty('방 기록은 아직 준비 중이에요', '관문(mcp.seanson.com)에 전체 글 API 가 배포되면 여기서 볼 수 있어요. 최근 30분 글은 「에이전트 방」에서 보여요.');
    else if (state === 'forbidden') setEmpty('관문이 방 기록을 열어 주지 않아요 (403)', errText || '관문에 이 경로가 아직 없거나 이 Google 계정 권한이 없어요.');
    else if (state === 'err' && !all.length) setEmpty('방 기록을 불러오지 못했어요', errText);
    else if (state === 'auth' && !all.length) setEmpty('로그인을 갱신하는 중이에요', '갱신되면 바로 다시 불러와요.');
    else if (!loaded) setEmpty(loading ? '불러오는 중…' : '');
    else if (!all.length) setEmpty('방에 남은 글이 없어요');
    else if (!hits) setEmpty('찾는 글이 없어요', older ? '불러온 글 안에서만 찾아요 — 「이전 글 더 보기」로 더 받아 보세요.' : '불러온 글 안에서만 찾아요.');
    else setEmpty('');
    if (state === 'notready' || state === 'forbidden') list.replaceChildren();
  }

  // ---- 네트워크 ----------------------------------------------------------------------
  async function fetchPage(before?: string | null): Promise<Page> {
    if (opts.demo) return demoPage(before);
    const tok = opts.idToken();
    if (!tok) throw new AuthErr('로그인 만료');
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (before) q.set('before', before);
    const r = await fetch(`${api}/api/room/history?${q}`, {
      headers: { Authorization: `Bearer ${tok}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 401) {
      failedTok = tok;
      throw new AuthErr('401');
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const why = j?.message || j?.error;
      throw new HttpErr(r.status, `관문 ${r.status}${why ? ' · ' + String(why).slice(0, 100) : ''}`);
    }
    const j = await r.json();
    return {
      messages: Array.isArray(j?.messages) ? j.messages.filter(valid) : [],
      before: typeof j?.before === 'string' && j.before ? j.before : null,
      count: typeof j?.count === 'number' ? j.count : null,
      since: j?.since != null && Number.isFinite(toMs(j.since)) ? j.since : null,
    };
  }
  function meta(p: Page) {
    if (p.count != null) total = p.count;
    if (p.since != null) since = p.since;
  }
  function onErr(e: unknown) {
    if (e instanceof AuthErr) {
      authFails++;
      state = 'auth';
      const now = Date.now();
      if (authFails <= 2 && now - lastAuthFail > 30_000) {
        lastAuthFail = now;
        opts.onAuthFail();
      }
      retryAt = now + (authFails > 2 ? 30_000 : 3_000);
      live(authFails > 2 ? '관문이 로그인을 거부합니다(401) — 30초 뒤 다시' : '로그인 갱신 중…', authFails > 2 ? 'err' : '');
      return;
    }
    const st = e instanceof HttpErr ? e.status : 0;
    errText = (e as Error).name === 'TimeoutError' ? '시간 초과' : (e as Error).message || String(e);
    if (st === 404) {
      state = 'notready';
      live('준비 중 · 관문 API 없음', '');
    } else if (st === 403) {
      state = 'forbidden';
      live('권한 없음(403)', 'err');
    } else {
      // 이미 글이 있으면 그대로 두고 아래 줄에만 알림
      if (!byId.size) state = 'err';
      live('불러오기 실패', 'err');
      note('불러오지 못했어요: ' + errText + ' — 새로고침으로 다시', 'err');
    }
  }
  function ok() {
    state = '';
    errText = '';
    authFails = 0;
    failedTok = null;
    lastLoad = Date.now();
    live('불러옴 · ' + hms.format(new Date()), 'ok');
  }
  function busy(on: boolean) {
    loading = on;
    el.classList.toggle('loading', on);
    refreshBtn.disabled = on;
    moreBtn.disabled = on;
  }

  // 최신 페이지(처음 · 새로고침). 이미 받은 글과 겹칠 때까지 이어 받아 사이를 메운다.
  async function loadLatest(hard = false, why = '') {
    if (loading) return;
    busy(true);
    if (!loaded || hard) live('불러오는 중…');
    note('');
    if (!loaded) render();
    try {
      if (hard) {
        byId.clear();
        loaded = false;
        older = null;
      }
      const p = await fetchPage(null);
      meta(p);
      let got = p.messages;
      let cur = p.before;
      if (loaded && byId.size) {
        let pages = 1;
        while (cur && !got.some((m) => byId.has(m.id)) && pages < GAP_PAGES) {
          const q = await fetchPage(cur);
          meta(q);
          got = q.messages.concat(got);
          cur = q.before;
          pages++;
        }
        if (cur && !got.some((m) => byId.has(m.id))) {
          byId.clear(); // 너무 많이 비어서 최신부터 다시
          older = cur;
        }
      } else older = cur;
      const stick = !loaded || nearBottom();
      const top0 = log.scrollTop;
      const before0 = byId.size;
      for (const m of got) byId.set(m.id, m);
      const wasLoaded = loaded;
      loaded = true;
      ok();
      render();
      const fresh = byId.size - before0;
      if (stick) toBottom();
      else {
        setTop(top0);
        if (fresh > 0) down.hidden = false;
      }
      if (why) note(why, 'err');
      else if (wasLoaded) note(fresh > 0 ? `새 글 ${num(fresh)}개` : '새 글 없음', fresh > 0 ? 'ok' : '');
      armed = false;
    } catch (e) {
      onErr(e);
      render();
    } finally {
      busy(false);
    }
  }
  async function loadOlder() {
    if (loading || !loaded || !older || state) return;
    busy(true);
    moreBtn.textContent = '불러오는 중…';
    try {
      const p = await fetchPage(older);
      meta(p);
      older = p.before;
      const h0 = log.scrollHeight;
      const t0 = log.scrollTop;
      for (const m of p.messages) if (!byId.has(m.id)) byId.set(m.id, m);
      ok();
      render();
      setTop(t0 + (log.scrollHeight - h0)); // 보던 글이 제자리에
      note(p.messages.length ? `이전 글 ${num(p.messages.length)}개` : '');
    } catch (e) {
      if (e instanceof HttpErr && e.status === 400 && Date.now() - badCursorAt > 10_000) {
        // 커서가 낡음(관문 쪽 기록이 바뀜) → 처음부터 다시
        badCursorAt = Date.now();
        busy(false);
        return loadLatest(true, '이전 글 커서가 맞지 않아 최신부터 다시 받았어요');
      }
      onErr(e);
      render();
    } finally {
      busy(false);
      armed = false;
    }
  }

  // ---- 조작 --------------------------------------------------------------------------
  refreshBtn.addEventListener('click', () => {
    retryAt = 0;
    if (state === 'notready' || state === 'forbidden' || state === 'err') state = '';
    loadLatest(!loaded);
  });
  moreBtn.addEventListener('click', () => loadOlder());
  down.addEventListener('click', toBottom);
  log.addEventListener('scroll', () => {
    if (nearBottom()) down.hidden = true;
    else if (log.scrollHeight - log.scrollTop - log.clientHeight > 600) down.hidden = false;
    if (performance.now() < quietUntil) return;
    if (log.scrollTop > 400) armed = true;
    else if (armed && log.scrollTop < 120 && !findIn.value.trim() && !fromSel.value) loadOlder();
  });
  let tFind: number | undefined;
  findIn.addEventListener('input', () => {
    clearTimeout(tFind);
    tFind = window.setTimeout(() => (render(), toBottom()), 150);
  });
  findIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && findIn.value) {
      findIn.value = '';
      render();
      toBottom();
    }
  });
  fromSel.addEventListener('change', () => (render(), toBottom()));

  // 토큰이 갱신되면(로그인 다시) 다시 불러오기 — 이벤트가 없어서 3초마다 본다
  window.setInterval(() => {
    if (!selected || document.visibilityState !== 'visible' || state !== 'auth' || loading) return;
    const t = opts.idToken();
    if (!t || Date.now() < retryAt || (t === failedTok && authFails <= 2)) return;
    loadLatest(!loaded);
  }, 3000);

  // ---- demo (/admin/?demo, localhost): 가짜 기록 300개(5일) + 페이지 커서 -------------------
  let demoAll: Msg[] | null = null;
  function demoData() {
    if (demoAll) return demoAll;
    const lines: [string, string, string, string?][] = [
      ['총괄', 'workmac', '767 시작 — 방 기록 탭을 만듭니다'],
      ['web', 'workmac', '<b>태그</b>는 글자 그대로 · [링크](https://example.com) · **굵게 아님**'],
      ['Sean', 'iphone', '방 최근 30분 말고 전체 글도 보고 싶어요'],
      ['gateway', 'cloud', 'web 이 들어왔어요', 'system'],
      ['seanchat', 'workmac', 'GET /api/room/history 배포 준비\n두 줄 글은 줄바꿈 그대로'],
      ['Sean', 'hub-admin', 'hub admin 에서 쓴 글'],
      ['ios', 'xcodemac', '아주 긴 글도 줄이 넘어가야 해요 — ' + 'abcdefghij'.repeat(14)],
      ['aws', 'seanmac', 'SSO 토큰 확인 끝, 다음 단계로'],
    ];
    const n = 300;
    const end = Date.now() / 1000 - 90;
    const span = 5 * 86400;
    demoAll = Array.from({ length: n }, (_, i) => {
      const [from, hub, text, kind] = lines[(i * 5) % lines.length];
      return { id: `demo${String(i).padStart(4, '0')}${'0'.repeat(24)}`, seq: i + 1, from, hub, text: `${text} (#${i + 1})`, kind, ts: end - span + (span * i) / (n - 1) };
    });
    return demoAll;
  }
  let demoNew = 0;
  function demoPage(before?: string | null): Promise<Page> {
    const all = demoData();
    if (!before && loaded && demoNew < 3) {
      // 새로고침 할 때마다 새 글 하나
      demoNew++;
      all.push({ id: `demonew${demoNew}${'0'.repeat(24)}`, from: 'web', hub: 'workmac', text: `새로고침으로 받은 새 글 ${demoNew}`, ts: Date.now() / 1000 });
    }
    const endIdx = before ? Number(before.slice(2)) : all.length;
    if (!Number.isInteger(endIdx) || endIdx < 0 || endIdx > all.length) return Promise.reject(new HttpErr(400, '관문 400 · 엉터리 커서'));
    const startIdx = Math.max(0, endIdx - PAGE);
    const page = { messages: all.slice(startIdx, endIdx), before: startIdx > 0 ? `c:${startIdx}` : null, count: all.length, since: all[0].ts };
    return new Promise((res) => setTimeout(() => res(page), 350));
  }

  render();
  return {
    setActive(on: boolean) {
      selected = on;
      if (!on) return;
      // 처음 · 「준비 중」·실패였으면 탭을 다시 열 때 한 번 더 시도
      if (!loaded && !loading && Date.now() >= retryAt) loadLatest();
      else if (loaded && !state && Date.now() - lastLoad > STALE_MS) loadLatest();
    },
  };
}
