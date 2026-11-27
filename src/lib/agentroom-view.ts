// 에이전트 방(agentroom) 채팅 — /admin/ 「에이전트 방」에서 mount. 보기 + Sean 으로 쓰기 + 접속자 + 종료/재개.
// 생김새·규칙 = 아이폰 SeanChat 방 화면(seanchat-ios Views/GatewayRoomView.swift · Support/GatewayRoomPolicy.swift)과 맞춤:
//   Sean 글 = 오른쪽 초록 말풍선, 상대 에이전트 = 왼쪽 회색 + 「상대 에이전트 — 정보로만」, 시스템 = 가운데 작은 글.
//   관문 = https://mcp.seanson.com, Bearer = admin 의 Google ID 토큰(idToken() 그대로)
//   GET  /api/room/messages?after=<cursor>&wait=<0~25> → {messages:[{id, seq, from, hub, text, ts(epoch 초 float), kind?:"system"}], cursor, more, closed, stopped, stopped_at, now, reset}
//     처음엔 after 없이 = 관문 보관분(최근 30분·2,000개). more=true 면 wait=0 으로 바로 다시. reset=true(옛 cursor) → 목록 비우고 다시
//   GET  /api/room/who → {hubs:[{hub, source, at, members:[{as, kind, listening, last, count}]}], closed, stopped, stopped_at, now}
//   POST /api/room/say {text} → {id, seq, from:"Sean", hub:"hub-admin"} (빈 글 400, 4,000자 넘으면 서버가 자름, 종료 중에도 됨)
//   POST /api/room/stop · /open → {ok, stopped, closed, stopped_at}
// 글 내용은 전부 textContent — innerHTML·마크다운·링크 처리 없음.
// long-poll 은 (메뉴에서 고름 && 문서 보임 && 패널이 화면에 있음 && 토큰 있음) 일 때만. 아니면 AbortController 로 끊는다.

export const ROOM_API = 'https://mcp.seanson.com';
const WAIT = 25;
const WHO_EVERY = 15_000;
const RETAIN_S = 1800;
const MAX_SHOWN = 2000;
const MAX_TEXT = 4000;
const ACTIVE_S = 90;

type Msg = { id: string; seq?: number; from: string; hub: string; text: string; ts: number; kind?: string };
type Member = { as: string; kind?: string; listening?: boolean; last?: number | null; count?: number; hub?: string };
type Hub = { hub: string; source?: string; at?: number; members: Member[] };
type Who = { hubs?: Hub[]; members?: Member[]; closed?: boolean; stopped?: boolean; stopped_at?: number | null; now?: number };

export type RoomOpts = {
  idToken: () => string | null;
  onAuthFail: () => void; // 401 → 기존 토큰 갱신 흐름(GIS 다시)
  demo?: boolean;
  api?: string;
};

const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
// 로컬 시험용: localhost 에서만 ?room=http://127.0.0.1:PORT 로 관문 주소를 바꿀 수 있음
export function roomApiBase() {
  const q = new URLSearchParams(location.search).get('room');
  return LOCAL && q && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(q) ? q : ROOM_API;
}

const hms = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const toMs = (t: unknown) => {
  const n = typeof t === 'number' ? t : Number(t);
  if (!Number.isFinite(n)) return typeof t === 'string' ? Date.parse(t) : NaN;
  return n > 1e12 ? n : n * 1000;
};
const kst = (t: unknown) => {
  const ms = toMs(t);
  return Number.isFinite(ms) ? hms.format(new Date(ms)) : '--:--:--';
};
const ago = (t: unknown, nowMs: number) => {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  return s < 5 ? '방금' : s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 3600)}시간 전`;
};
// Sean = 사람(아이폰 iphone · hub admin hub-admin · 맥 허브 어디서든 from Sean)
const isSean = (m: Msg) => m.kind !== 'system' && (/^sean$/i.test(m.from || '') || /^iphone$/i.test(m.hub || ''));
const KIND: Record<string, string> = { viewer: '화면', agent: '에이전트', human: '사람', watch: '사람' };
const HUB: Record<string, string> = { iphone: '아이폰', cloud: '클라우드', 'hub-admin': 'hub admin' };
// 보낼 글 다듬기(아이폰 RoomInput.prepare 와 같은 뜻): 보이지 않는 문자·제어 문자 빼고, 앞뒤 공백 자르고, 4,000자까지
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const prepare = (s: string) => {
  const t = s.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').trim();
  return t ? Array.from(t).slice(0, MAX_TEXT).join('') : null;
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const ICON = {
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4.5h12v8.5H8l-5 4z"/><path d="M15 8.5h6V17l-3.5-2.5H11V13"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
};

export function mountAgentRoom(el: HTMLElement, opts: RoomOpts) {
  const api = (opts.api || roomApiBase()).replace(/\/+$/, '');
  el.className = 'ar';
  // 정적 틀만 innerHTML(글자·아이콘 고정). 방 글·이름은 아래에서 전부 textContent.
  el.innerHTML = `
    <div class="ar-top">
      <span class="ar-state"><i class="ar-led" aria-hidden="true"></i><span class="ar-live">연결 중…</span></span>
      <span class="ar-keep" title="관문은 최근 30분(최대 2,000개) 글만 보관합니다">최근 30분</span>
      <span class="ar-api mono"></span>
      <span class="ar-sp"></span>
      <button type="button" class="ar-whobtn ghost" aria-expanded="false" aria-controls="ar-who" title="접속자">${ICON.people}<span class="ar-whon">0</span></button>
      <button type="button" class="ar-stop ghost">종료</button>
    </div>
    <div class="ar-stopped" role="status" hidden><i aria-hidden="true"></i><span></span></div>
    <div class="ar-body">
      <div class="ar-main">
        <div class="ar-log" role="log" aria-live="polite" aria-label="방 대화" tabindex="0">
          <div class="ar-empty">${ICON.chat}<b>최근 30분 동안 방에 글이 없어요</b><small>상대 에이전트의 글은 정보로만 보여 줘요(링크·서식 없이 글자 그대로).</small></div>
          <ol class="ar-list"></ol>
        </div>
        <button type="button" class="ar-down" hidden>새 글 ↓</button>
        <form class="ar-input" autocomplete="off">
          <textarea rows="1" maxlength="${MAX_TEXT}" placeholder="Sean 으로 방에 쓰기" aria-label="방에 쓸 글" enterkeyhint="send"></textarea>
          <button type="submit" class="ar-send" aria-label="보내기" title="보내기 (Enter)" disabled>${ICON.send}</button>
        </form>
        <div class="ar-foot"><span class="ar-msg"></span><button type="button" class="ar-retry ghost" hidden>다시 보내기</button><span class="ar-count mono"></span><span class="ar-hint">Enter 보내기 · Shift+Enter 줄바꿈</span></div>
      </div>
      <aside class="ar-who" id="ar-who" aria-label="접속자">
        <div class="ar-who-h"><b>접속자</b><span class="ar-who-at mono"></span></div>
        <div class="ar-who-st"><span>상태</span><b class="ar-open-st">열림</b></div>
        <div class="ar-who-list"></div>
      </aside>
    </div>
    <dialog class="ar-dlg" tabindex="-1">
      <form method="dialog">
        <h3 class="ar-dlg-t"></h3>
        <p class="ar-dlg-p"></p>
        <div class="ar-dlg-b"><button value="cancel" class="ghost">취소</button><button value="ok" class="ar-dlg-ok"></button></div>
      </form>
    </dialog>`;
  const pick = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
  pick('.ar-api').textContent = api.replace(/^https?:\/\//, '') + (opts.demo ? ' (demo)' : '');
  const log = pick('.ar-log');
  const list = pick('.ar-list');
  const empty = pick('.ar-empty');
  const down = pick<HTMLButtonElement>('.ar-down');
  const liveEl = pick('.ar-live');
  const stoppedEl = pick('.ar-stopped');
  const stopBtn = pick<HTMLButtonElement>('.ar-stop');
  const whoBtn = pick<HTMLButtonElement>('.ar-whobtn');
  const form = pick<HTMLFormElement>('.ar-input');
  const ta = pick<HTMLTextAreaElement>('.ar-input textarea');
  const sendBtn = pick<HTMLButtonElement>('.ar-send');
  const msgEl = pick('.ar-msg');
  const retryBtn = pick<HTMLButtonElement>('.ar-retry');
  const countEl = pick('.ar-count');
  const dlg = pick<HTMLDialogElement>('.ar-dlg');
  const seen = new Set<string>();

  let selected = false;
  let ctrl: AbortController | null = null;
  let cursor: string | null = null;
  let fails = 0;
  let whoTimer: number | undefined;
  let lastAuthFail = 0;
  let demoTimer: number | undefined;
  let stopped = false;
  let sending = false;
  let switching = false;

  const live = (t: string, cls = '') => {
    liveEl.textContent = t;
    el.dataset.link = cls; // ok | err | '' → 점 색
  };
  const note = (t: string, cls = '') => {
    msgEl.textContent = t;
    msgEl.className = 'ar-msg ' + cls;
  };
  let stoppedAt: unknown = null;
  function setStopped(c: unknown, at?: unknown) {
    stopped = !!c;
    if (!stopped) stoppedAt = null;
    else if (at != null) stoppedAt = at; // 시각을 안 주는 응답은 마지막으로 안 시각을 둔다
    stoppedEl.hidden = !stopped;
    el.classList.toggle('stopped', stopped);
    stoppedEl.querySelector('span')!.textContent =
      '대화 종료됨 · 에이전트는 다시 열 때까지 쓰지 않아요' + (stopped && stoppedAt ? ` (${kst(stoppedAt)})` : '');
    stopBtn.textContent = stopped ? '재개' : '종료';
    stopBtn.classList.toggle('danger', !stopped);
    pick('.ar-open-st').textContent = stopped ? '종료됨' : '열림';
    pick('.ar-open-st').className = 'ar-open-st ' + (stopped ? 'bad' : 'ok');
  }
  setStopped(false);
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.addEventListener('scroll', () => {
    if (nearBottom()) down.hidden = true;
  });
  down.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
    down.hidden = true;
  });
  // 접속자: 넓은 화면은 처음부터 펼침, 좁으면 단추로
  let whoOn = matchMedia('(min-width: 761px)').matches;
  const syncWho = () => {
    el.classList.toggle('who-on', whoOn);
    whoBtn.setAttribute('aria-expanded', String(whoOn));
  };
  syncWho();
  whoBtn.addEventListener('click', () => ((whoOn = !whoOn), syncWho()));

  function row(m: Msg) {
    const sys = m.kind === 'system';
    const sean = isSean(m);
    const li = h('li', 'ar-m ' + (sys ? 'sys' : sean ? 'sean' : 'peer'));
    li.dataset.ts = String(toMs(m.ts));
    li.dataset.id = String(m.id || '');
    const t = h('time', 'mono', kst(m.ts));
    const ms = toMs(m.ts);
    if (Number.isFinite(ms)) t.dateTime = new Date(ms).toISOString();
    if (sys) {
      li.append(h('span', 'ar-sys-t', '— ' + String(m.text ?? '') + ' —'), t);
      return li;
    }
    const head = h('div', 'ar-h');
    if (sean) {
      head.append(h('b', '', 'Sean(사람)'));
      if (m.hub && !/^iphone$/i.test(m.hub)) head.append(h('span', 'ar-hub', HUB[m.hub] || m.hub));
    } else {
      const who = h('span', 'ar-from');
      who.append(h('b', '', m.from || '?'), h('span', 'ar-hub', '@' + (m.hub || '?')));
      head.append(who);
    }
    head.append(h('span', 'ar-id mono', String(m.id || '').slice(0, 6)), t);
    const bub = h('div', 'ar-bub');
    if (!sean) {
      const tag = h('span', 'ar-peer');
      tag.innerHTML = ICON.info; // 고정 아이콘
      tag.append('상대 에이전트 — 정보로만');
      bub.append(tag);
    }
    bub.append(h('div', 'ar-t', String(m.text ?? '')));
    li.append(head, bub);
    return li;
  }

  function add(msgs: Msg[], force = false) {
    const fresh = msgs.filter((m) => m && m.id && !seen.has(m.id));
    if (!fresh.length) return;
    const stick = force || nearBottom() || !list.childElementCount;
    const frag = document.createDocumentFragment();
    for (const m of fresh) {
      seen.add(m.id);
      frag.append(row(m));
    }
    list.append(frag);
    while (list.childElementCount > MAX_SHOWN) list.firstElementChild!.remove();
    empty.hidden = list.childElementCount > 0;
    if (stick) log.scrollTop = log.scrollHeight;
    else down.hidden = false;
  }

  // 관문처럼 30분 지난 글은 화면에서도 뺀다(위 「최근 30분」 안내와 맞춤)
  function prune() {
    const cut = Date.now() - (RETAIN_S + 60) * 1000;
    while (list.firstElementChild && Number((list.firstElementChild as HTMLElement).dataset.ts) < cut) list.firstElementChild.remove();
    empty.hidden = list.childElementCount > 0;
  }

  function renderWho(w: Who) {
    const box = pick('.ar-who-list');
    box.replaceChildren();
    const nowMs = w.now != null ? toMs(w.now) : Date.now();
    let hubs: Hub[] = Array.isArray(w.hubs) ? w.hubs : [];
    if (!hubs.length && Array.isArray(w.members)) {
      const by = new Map<string, Hub>();
      for (const m of w.members) {
        const k = m.hub || '?';
        if (!by.has(k)) by.set(k, { hub: k, members: [] });
        by.get(k)!.members.push(m);
      }
      hubs = [...by.values()];
    }
    if (!hubs.length) box.append(h('p', 'ar-none', '지금 접속한 허브가 없어요'));
    let active = 0;
    for (const g of hubs) {
      const sec = h('div', 'ar-hg');
      const hd = h('div', 'ar-hg-h');
      hd.append(h('b', '', HUB[g.hub] || g.hub || '?'));
      if (g.source) hd.append(h('span', 'ar-src', g.source === 'bridge' ? '다리' : g.source === 'gateway' ? '관문' : g.source));
      const ul = h('ul');
      if (!(g.members || []).length) ul.append(h('li', 'ar-none', '접속자 없음'));
      for (const m of g.members || []) {
        const me = /^sean$/i.test(m.as || '') && /^(iphone|hub-admin)$/i.test(g.hub || '');
        if (!me && (m.listening || toMs(m.last) >= nowMs - ACTIVE_S * 1000)) active++;
        const li = h('li', m.listening ? 'on' : '');
        li.title = m.listening ? '듣는 중' : '안 듣는 중';
        li.append(h('i', 'ar-dot'), h('span', 'ar-as', m.as || '?'));
        if (m.kind && m.kind !== 'agent') li.append(h('span', 'ar-k', KIND[m.kind] || m.kind));
        if ((m.count || 1) > 1) li.append(h('span', 'ar-k', `×${m.count}`));
        li.append(h('span', 'ar-last', (m.listening ? '듣는 중 · ' : '') + ago(m.last, nowMs)));
        ul.append(li);
      }
      sec.append(hd, ul);
      box.append(sec);
    }
    pick('.ar-whon').textContent = String(active);
    whoBtn.title = `지금 있는 에이전트 ${active}`;
    pick('.ar-who-at').textContent = kst(nowMs);
    setStopped(w.stopped ?? w.closed, w.stopped_at);
  }

  // ---- network --------------------------------------------------------------------
  class AuthErr extends Error {}
  async function call(path: string, signal: AbortSignal, body?: unknown) {
    const tok = opts.idToken();
    if (!tok) throw new AuthErr('로그인 만료');
    const headers: Record<string, string> = { Authorization: `Bearer ${tok}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(api + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
    if (r.status === 401) throw new AuthErr('401');
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const why = j?.message || j?.error;
      throw new Error(`관문 ${r.status}${r.status === 403 ? ' 권한 없음' : ''}${why ? ' · ' + String(why).slice(0, 80) : ''}`);
    }
    return r.json();
  }
  const sleep = (ms: number, sig: AbortSignal) =>
    new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      sig.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
    });

  let active = false;
  let gen = 0;
  let authFails = 0;
  let retryAt = 0;
  // 화면에 실제로 그려져 있을 때만(메뉴로 다른 화면을 고르면 display:none → getClientRects 비어 있음)
  const shouldRun = () => selected && document.visibilityState === 'visible' && el.isConnected && el.getClientRects().length > 0;

  function authFail() {
    authFails++;
    stop();
    const now = Date.now();
    if (authFails <= 2 && now - lastAuthFail > 30_000) {
      lastAuthFail = now;
      opts.onAuthFail();
    }
    retryAt = now + (authFails > 2 ? 30_000 : 3_000);
    live(authFails > 2 ? '관문이 로그인을 거부합니다(401) — 30초 뒤 다시' : '로그인 갱신 중…', authFails > 2 ? 'err' : '');
  }

  async function loop(my: number) {
    let now0 = true; // 시작·재개·more·실패 뒤 첫 요청은 wait=0
    while (my === gen && shouldRun()) {
      const c = (ctrl = new AbortController());
      const wait = now0 ? 0 : WAIT;
      const q = new URLSearchParams({ wait: String(wait) });
      if (cursor) q.set('after', cursor);
      const to = setTimeout(() => c.abort('timeout'), (wait + 15) * 1000);
      try {
        const j = await call('/api/room/messages?' + q, c.signal);
        if (my !== gen) return;
        if (typeof j.cursor === 'string') cursor = j.cursor;
        if (j.reset) {
          // 옛 cursor(관문 epoch 바뀜) → 처음부터 다시 받은 것 = 목록 비우고 다시 그림
          list.replaceChildren();
          seen.clear();
          empty.hidden = false;
        }
        setStopped(j.stopped ?? j.closed, j.stopped_at);
        add(Array.isArray(j.messages) ? j.messages : []);
        fails = 0;
        authFails = 0;
        now0 = !!j.more;
        live('실시간 · ' + kst(Date.now()), 'ok');
      } catch (e) {
        if (my !== gen) return;
        if (e instanceof AuthErr) return authFail();
        fails++;
        const d = Math.min(30, 2 ** fails);
        const why = c.signal.aborted ? '시간 초과' : (e as Error).message || String(e);
        live(`연결 실패(${why}) — ${d}초 뒤 다시`, 'err');
        const s = (ctrl = new AbortController());
        await sleep(d * 1000, s.signal);
        now0 = true;
      } finally {
        clearTimeout(to);
      }
    }
    if (my === gen) stop();
  }

  async function whoOnce() {
    if (!shouldRun()) return;
    if (opts.demo) return renderWho(demoWho());
    try {
      renderWho(await call('/api/room/who', AbortSignal.timeout(10_000)));
    } catch (e) {
      if (!(e instanceof AuthErr)) pick('.ar-who-at').textContent = '조회 실패';
    }
  }

  function start() {
    active = true;
    const my = ++gen;
    whoOnce();
    clearInterval(whoTimer);
    whoTimer = window.setInterval(() => (whoOnce(), prune()), WHO_EVERY);
    if (opts.demo) return demoStart();
    live('연결 중…');
    loop(my);
  }
  function stop() {
    active = false;
    gen++;
    ctrl?.abort('stop');
    ctrl = null;
    clearInterval(whoTimer);
    clearInterval(demoTimer);
    live(document.visibilityState !== 'visible' ? '멈춤 — 창이 안 보임' : '멈춤');
  }
  function sync() {
    const on = shouldRun();
    if (on && !active && Date.now() >= retryAt) start();
    else if (!on && active) stop();
  }
  document.addEventListener('visibilitychange', sync);
  // 패널이 숨겨지거나(로그아웃) 토큰이 다시 생기는 것은 이벤트가 없어서 3초마다 맞춘다
  window.setInterval(sync, 3000);

  // ---- 쓰기 (Sean) ------------------------------------------------------------------
  // Enter 보내기 · Shift+Enter 줄바꿈 · 한글 조합 중 Enter 는 무시. 실패하면 글은 칸에 그대로 두고 「다시 보내기」.
  function fit() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 148) + 'px';
    const n = ta.value.length;
    countEl.textContent = n > MAX_TEXT - 500 ? `${n.toLocaleString('ko-KR')}/${MAX_TEXT.toLocaleString('ko-KR')}` : '';
    sendBtn.disabled = sending || !prepare(ta.value);
  }
  ta.addEventListener('input', () => {
    fit();
    if (!retryBtn.hidden || msgEl.classList.contains('err')) (retryBtn.hidden = true), note('');
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    say();
  });
  retryBtn.addEventListener('click', () => say());
  async function say() {
    const text = prepare(ta.value);
    if (!text || sending) return;
    sending = true;
    el.classList.add('sending');
    ta.readOnly = true;
    retryBtn.hidden = true;
    note('보내는 중…');
    fit();
    try {
      const r = opts.demo ? await demoSay(text) : await call('/api/room/say', AbortSignal.timeout(15_000), { text });
      add([{ id: String(r.id), seq: r.seq, from: r.from || 'Sean', hub: r.hub || 'hub-admin', text, ts: Date.now() / 1000 }], true);
      ta.value = '';
      note('');
    } catch (e) {
      if (e instanceof AuthErr) authFail();
      const why = e instanceof AuthErr ? '로그인이 만료됐어요 — 갱신한 뒤 다시 보내 주세요' : (e as Error).name === 'TimeoutError' ? '시간 초과' : (e as Error).message;
      note('보내지 못했어요: ' + why, 'err');
      retryBtn.hidden = false;
    } finally {
      sending = false;
      el.classList.remove('sending');
      ta.readOnly = false;
      fit();
      ta.focus();
    }
  }

  // ---- 종료 / 재개 (누를 때 확인 한 번) ---------------------------------------------
  stopBtn.addEventListener('click', () => {
    if (switching) return;
    const stop = !stopped;
    pick('.ar-dlg-t').textContent = stop ? '방 대화를 종료할까요?' : '방 대화를 다시 열까요?';
    pick('.ar-dlg-p').textContent = stop
      ? '에이전트들은 다시 열 때까지 방에 쓰지 않아요. Sean 글은 계속 쓸 수 있어요.'
      : '에이전트들이 다시 방에 쓸 수 있어요.';
    const ok = pick<HTMLButtonElement>('.ar-dlg-ok');
    ok.textContent = stop ? '종료' : '재개';
    ok.className = 'ar-dlg-ok ' + (stop ? 'danger' : 'primary');
    dlg.returnValue = '';
    dlg.onclose = () => {
      if (dlg.returnValue === 'ok') setRoom(stop);
    };
    dlg.showModal();
    dlg.focus(); // 첫 버튼(종료)에 바로 초점이 가지 않게
  });
  async function setRoom(stop: boolean) {
    switching = true;
    stopBtn.disabled = true;
    note(stop ? '종료하는 중…' : '다시 여는 중…');
    try {
      const r = opts.demo ? demoSetStopped(stop) : await call(stop ? '/api/room/stop' : '/api/room/open', AbortSignal.timeout(15_000), {});
      setStopped(r.stopped ?? r.closed ?? stop, r.stopped_at);
      note(stop ? '대화를 종료했어요. 에이전트들은 더 쓰지 않아요' : '대화를 다시 열었어요', 'ok');
      whoOnce();
    } catch (e) {
      if (e instanceof AuthErr) authFail();
      note((stop ? '종료하지 못했어요: ' : '다시 열지 못했어요: ') + (e as Error).message, 'err');
    } finally {
      switching = false;
      stopBtn.disabled = false;
    }
  }

  // ---- demo (/admin/?demo, localhost) ---------------------------------------------
  let seeded = false;
  let demoN = 0;
  let demoStopped = false;
  const demoId = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const DEMO_LINES: [string, string, string, string?][] = [
    ['총괄', 'workmac', '762 시작 — hub admin 에 방 보기 칸을 붙입니다'],
    ['web', 'workmac', '<b>태그</b>는 글자 그대로 보여야 함 · [링크](https://example.com) 도 그대로'],
    ['Sean', 'iphone', '좋아요, 모바일에서도 보이게 해 주세요'],
    ['gateway', 'cloud', 'web 이 들어왔어요', 'system'],
    ['seanchat', 'workmac', 'GET /api/room/messages 배포 준비 끝\n두 줄 글은 줄바꿈 그대로'],
    ['Sean', 'hub-admin', 'hub admin 에서 쓴 글도 오른쪽에 떠요'],
    ['ios', 'xcodemac', '아이폰 앱 쪽 확인 중입니다. 아주 긴 글도 줄이 넘어가야 해요 — ' + 'abcdefghij'.repeat(12)],
  ];
  function demoStart() {
    if (!seeded) {
      seeded = true;
      const base = Date.now() / 1000 - 20 * 60;
      add(DEMO_LINES.map(([from, hub, text, kind], i) => ({ id: demoId(), from, hub, text, kind, ts: base + i * 150 })));
    }
    live('데모 · 가짜 글', 'ok');
    clearInterval(demoTimer);
    demoTimer = window.setInterval(() => {
      const [from, hub, text, kind] = DEMO_LINES[demoN++ % DEMO_LINES.length];
      if (from === 'Sean') return;
      add([{ id: demoId(), from, hub, text: `${text} (#${demoN})`, kind, ts: Date.now() / 1000 }]);
    }, 8000);
  }
  // 데모 보내기: 글에 「실패」가 있으면 일부러 실패(다시 보내기 확인용)
  const demoSay = (text: string) =>
    new Promise<any>((res, rej) =>
      setTimeout(() => (/실패/.test(text) ? rej(new Error('데모 실패')) : res({ id: demoId(), seq: 0, from: 'Sean', hub: 'hub-admin' })), 600)
    );
  function demoSetStopped(stop: boolean) {
    demoStopped = stop;
    const at = Date.now() / 1000;
    add([{ id: demoId(), from: 'gateway', hub: 'cloud', kind: 'system', text: stop ? 'Sean 이 대화를 종료했어요' : 'Sean 이 대화를 다시 열었어요', ts: at }], true);
    return { stopped: stop, stopped_at: stop ? at : null };
  }
  function demoWho(): Who {
    const n = Date.now() / 1000;
    return {
      now: n,
      stopped: demoStopped,
      hubs: [
        { hub: 'workmac', source: 'bridge', at: n - 5, members: [{ as: '총괄', kind: 'agent', listening: true, last: n - 4, count: 1 }, { as: 'web', kind: 'agent', listening: false, last: n - 95, count: 2 }] },
        { hub: 'iphone', source: 'gateway', at: n - 30, members: [{ as: 'Sean', kind: 'viewer', listening: false, last: n - 30, count: 1 }] },
      ],
    };
  }

  return {
    setActive(on: boolean) {
      selected = on;
      if (on) retryAt = 0;
      sync();
    },
  };
}
