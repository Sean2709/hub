// 에이전트 방(agentroom) 대화 보기 — /admin/ 앱 관리 탭 「에이전트 방」에서 mount. 보기 전용(쓰기·종료 버튼 없음).
//   관문 = https://mcp.seanson.com, Bearer = admin 의 Google ID 토큰(idToken() 그대로)
//   GET /api/room/messages?after=<cursor>&wait=<0~25> → {messages:[{id, seq, from, hub, text, ts(epoch 초 float), kind?:"system"}], cursor, more, closed, stopped, stopped_at, now, reset}
//     처음엔 after 없이 = 관문 보관분(최근 30분·2,000개). more=true 면 wait=0 으로 바로 다시. epoch 가 바뀌면 서버가 처음부터 줌(reset=true → 목록 비우고 다시) → cursor 는 응답 값으로 바꾸기만
//   GET /api/room/who → {hubs:[{hub, source, at, members:[{as, kind, listening, last, count}]}], closed, stopped, now}
//     (초안 모양 {members:[{…, hub}]} 도 받음). at·last·now = epoch 초
// 글 내용은 전부 textContent — innerHTML·마크다운·링크 처리 없음.
// long-poll 은 (탭 선택됨 && 문서 보임 && 패널 보임 && 토큰 있음) 일 때만. 아니면 AbortController 로 끊는다.

export const ROOM_API = 'https://mcp.seanson.com';
const WAIT = 25;
const WHO_EVERY = 15_000;
const RETAIN_S = 1800;
const MAX_SHOWN = 2000;

type Msg = { id: string; seq?: number; from: string; hub: string; text: string; ts: number; kind?: string };
type Member = { as: string; kind?: string; listening?: boolean; last?: number | null; count?: number; hub?: string };
type Hub = { hub: string; source?: string; at?: number; members: Member[] };
type Who = { hubs?: Hub[]; members?: Member[]; closed?: boolean; stopped?: boolean; now?: number };

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
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 3600)}시간 전`;
};
const isSean = (m: Msg) => /^sean$/i.test(m.from || '') || /^iphone$/i.test(m.hub || '');

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function mountAgentRoom(el: HTMLElement, opts: RoomOpts) {
  const api = (opts.api || roomApiBase()).replace(/\/+$/, '');
  el.className = 'ar';
  el.innerHTML = `
    <div class="ar-bar">
      <div class="sum"><b>에이전트 방</b> · 보기 전용 · <span class="ar-api mono"></span></div>
      <span class="ar-closed" hidden>방 닫힘</span>
      <span class="ar-live status"></span>
    </div>
    <p class="ar-note">관문은 <b>최근 30분</b>(최대 2,000개) 글만 보관합니다. 처음 열면 그만큼 보이고, 그 뒤로는 새 글이 오는 대로 붙습니다.</p>
    <div class="ar-grid">
      <div class="ar-main">
        <div class="ar-log" role="log" aria-live="polite" aria-label="방 대화" tabindex="0"><ol class="ar-list"></ol><p class="ar-empty">최근 30분 글 없음</p></div>
        <button type="button" class="ar-down" hidden>새 글 ↓</button>
      </div>
      <aside class="ar-who" aria-label="접속자"><div class="ar-who-h"><b>접속자</b><span class="ar-who-at mono"></span></div><div class="ar-who-list"></div></aside>
    </div>`;
  const pick = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
  pick('.ar-api').textContent = api.replace(/^https?:\/\//, '') + (opts.demo ? ' (demo)' : '');
  const log = pick('.ar-log');
  const list = pick('.ar-list');
  const empty = pick('.ar-empty');
  const down = pick<HTMLButtonElement>('.ar-down');
  const liveEl = pick('.ar-live');
  const closedEl = pick('.ar-closed');
  const seen = new Set<string>();

  let selected = false;
  let ctrl: AbortController | null = null;
  let cursor: string | null = null;
  let fails = 0;
  let whoTimer: number | undefined;
  let lastAuthFail = 0;
  let demoTimer: number | undefined;

  const live = (t: string, cls = '') => {
    liveEl.textContent = t;
    liveEl.className = 'ar-live status ' + cls;
  };
  const setClosed = (c: unknown) => {
    closedEl.hidden = !c;
  };
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.addEventListener('scroll', () => {
    if (nearBottom()) down.hidden = true;
  });
  down.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
    down.hidden = true;
  });

  function row(m: Msg) {
    const li = h('li', 'ar-m' + (isSean(m) ? ' sean' : '') + (m.kind === 'system' ? ' sys' : ''));
    li.dataset.ts = String(toMs(m.ts));
    const head = h('div', 'ar-h');
    const who = h('span', 'ar-from');
    who.append(h('b', '', m.from || '?'), h('span', 'ar-hub', '@' + (m.hub || '?')));
    const t = h('time', 'mono', kst(m.ts));
    const ms = toMs(m.ts);
    if (Number.isFinite(ms)) t.dateTime = new Date(ms).toISOString();
    head.append(who, h('span', 'ar-id mono', String(m.id || '').slice(0, 6)));
    if (m.kind === 'system') head.append(h('span', 'ar-kind', 'system'));
    head.append(t);
    li.append(head, h('div', 'ar-t', String(m.text ?? '')));
    return li;
  }

  function add(msgs: Msg[]) {
    const fresh = msgs.filter((m) => m && m.id && !seen.has(m.id));
    if (!fresh.length) return;
    const stick = nearBottom() || !list.childElementCount;
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
    if (!hubs.length) box.append(h('p', 'ar-none', '아무도 없음'));
    for (const g of hubs) {
      const sec = h('div', 'ar-hg');
      const hd = h('div', 'ar-hg-h');
      hd.append(h('b', '', g.hub || '?'));
      if (g.source) hd.append(h('span', 'ar-src', g.source === 'bridge' ? '다리' : g.source === 'gateway' ? '관문' : g.source));
      const ul = h('ul');
      for (const m of g.members || []) {
        const li = h('li', m.listening ? 'on' : '');
        li.title = m.listening ? '듣는 중' : '안 듣는 중';
        li.append(h('i', 'ar-dot'), h('span', 'ar-as', m.as || '?'));
        if (m.kind && m.kind !== 'agent') li.append(h('span', 'ar-k', m.kind));
        if ((m.count || 1) > 1) li.append(h('span', 'ar-k', `×${m.count}`));
        li.append(h('span', 'ar-last', (m.listening ? '듣는 중 · ' : '') + ago(m.last, nowMs)));
        ul.append(li);
      }
      sec.append(hd, ul);
      box.append(sec);
    }
    pick('.ar-who-at').textContent = kst(nowMs);
    setClosed(w.closed ?? w.stopped);
  }

  // ---- network --------------------------------------------------------------------
  class AuthErr extends Error {}
  async function call(path: string, signal: AbortSignal) {
    const tok = opts.idToken();
    if (!tok) throw new AuthErr('로그인 만료');
    const r = await fetch(api + path, { headers: { Authorization: `Bearer ${tok}` }, cache: 'no-store', signal });
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
  const shouldRun = () => selected && document.visibilityState === 'visible' && !el.closest('[hidden]');

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
        setClosed(j.closed ?? j.stopped);
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

  // ---- demo (/admin/?demo, localhost) ---------------------------------------------
  let seeded = false;
  let demoN = 0;
  const demoId = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const DEMO_LINES: [string, string, string, string?][] = [
    ['총괄', 'workmac', '762 시작 — hub admin 에 방 보기 칸을 붙입니다'],
    ['web', 'workmac', '<b>태그</b>는 글자 그대로 보여야 함 · [링크](https://example.com) 도 그대로'],
    ['Sean', 'iphone', '좋아요, 모바일에서도 보이게 해 주세요'],
    ['gateway', 'cloud', 'web 이 들어왔어요', 'system'],
    ['seanchat', 'workmac', 'GET /api/room/messages 배포 준비 끝\n두 줄 글은 줄바꿈 그대로'],
    ['ios', 'xcodemac', '아이폰 앱 쪽 확인 중입니다. 아주 긴 글도 줄이 넘어가야 해요 — ' + 'abcdefghij'.repeat(12)],
  ];
  function demoStart() {
    if (!seeded) {
      seeded = true;
      const base = Date.now() / 1000 - 20 * 60;
      add(DEMO_LINES.map(([from, hub, text, kind], i) => ({ id: demoId(), from, hub, text, kind, ts: base + i * 170 })));
    }
    live('데모 · 가짜 글', 'ok');
    clearInterval(demoTimer);
    demoTimer = window.setInterval(() => {
      const [from, hub, text, kind] = DEMO_LINES[demoN++ % DEMO_LINES.length];
      add([{ id: demoId(), from, hub, text: `${text} (#${demoN})`, kind, ts: Date.now() / 1000 }]);
    }, 8000);
  }
  function demoWho(): Who {
    const n = Date.now() / 1000;
    return {
      now: n,
      closed: false,
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
