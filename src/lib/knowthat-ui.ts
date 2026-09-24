// 너그거알아(KnowThat) 문항 관리 패널 — /admin/ 앱 관리 탭에서 mount.
// 작업본(메모리) → "초안 저장"(admin/draft) → "배포"(public/content + manifest, version+1).
// 규칙(검증·스케줄 잠금·연장)은 knowthat-core.ts = KnowThat `scripts/content.py`와 동일.
import {
  CATEGORIES, LIMITS, HORIZON, type Fact, type Payload, type Doc,
  len, clone, todayIndex, dateLabel, nowIso, validate, validateFact, extend, lockedDiff,
  diffSummary, nextId, firebaseToken, clearFirebaseToken, getDoc, commit, ConflictError,
  stringify, activeCount,
} from './knowthat-core';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Tab = 'facts' | 'sched';
type Filter = 'all' | 'active' | 'retired' | 'changed' | 'errors';

export function mountKnowThat(el: HTMLElement, googleIdToken: () => string | null) {
  // ---- 상태 ----------------------------------------------------------------------
  let pub: Payload | null = null; // 배포본(public/content)
  let pubDoc: Doc | null = null;
  let draftDoc: Doc | null = null; // 저장된 초안(admin/draft)
  let work: Payload | null = null; // 작업본(화면에서 편집 중)
  let saved = ''; // 마지막으로 저장/불러온 작업본 직렬화 — dirty 판정
  let tab: Tab = 'facts';
  let filter: Filter = 'all';
  let cat = '';
  let query = '';
  let sel: string | null = null; // 편집 중 문항 id ('' = 새 문항)
  let form: Fact | null = null; // 에디터 폼 값(적용 전)
  let schedFrom = -14; // 스케줄 탭 표시 시작(오늘 기준 상대)
  let schedCount = 90;
  let busy = false;
  let msg = { text: '', cls: '' };

  const T = () => todayIndex();
  const dirty = () => !!work && stringify(work) !== saved;
  const byId = () => new Map((work?.facts ?? []).map((f) => [f.id, f]));
  const pubIds = () => new Set((pub?.facts ?? []).map((f) => f.id));

  const say = (text: string, cls = '') => {
    msg = { text, cls };
    const m = el.querySelector('.kt-msg');
    if (m) {
      m.textContent = text;
      m.className = 'msg kt-msg ' + cls;
    }
  };

  window.addEventListener('beforeunload', (e) => {
    if (dirty()) e.preventDefault();
  });

  // ---- 불러오기/저장/배포 ---------------------------------------------------------------
  async function token() {
    return firebaseToken(googleIdToken);
  }

  async function load(keepWork = false) {
    if (busy) return;
    if (!keepWork && dirty() && !confirm('저장하지 않은 변경이 있습니다. 버리고 다시 불러올까요?')) return;
    busy = true;
    say('불러오는 중…');
    render();
    try {
      const tk = await token();
      [pubDoc, draftDoc] = await Promise.all([getDoc('public/content'), getDoc('admin/draft', tk)]);
      pub = pubDoc?.json ? (JSON.parse(pubDoc.json) as Payload) : null;
      const base = draftDoc?.json ? (JSON.parse(draftDoc.json) as Payload) : pub ? clone(pub) : null;
      if (!base) throw new Error('배포본/초안이 없습니다 — KnowThat 리포에서 `scripts/content.py seed`를 먼저 실행하세요');
      base.facts.sort((a, b) => a.order - b.order);
      work = base;
      saved = stringify(work);
      if (sel && !byId().has(sel)) sel = null;
      form = sel != null ? clone(byId().get(sel) ?? null) : null;
      say(`불러옴 · 배포본 v${pub?.version ?? '-'} · 초안 ${draftDoc ? draftDoc.fields.updatedAt?.stringValue ?? '' : '없음'}`, 'ok');
    } catch (e: any) {
      if (/로그인|INVALID_IDP|credential/i.test(e?.message ?? '')) clearFirebaseToken();
      say(e?.message ?? String(e), 'err');
    } finally {
      busy = false;
      render();
    }
  }

  async function saveDraft(): Promise<boolean> {
    if (!work) return false;
    const errs = validate(work);
    if (errs.length) {
      say(`검증 실패 ${errs.length}건 — 저장하지 않음\n` + errs.slice(0, 8).join('\n'), 'err');
      return false;
    }
    busy = true;
    render();
    try {
      const at = nowIso();
      const s = stringify(work);
      const r: any = await commit(await token(), [
        { path: 'admin/draft', fields: { json: s, updatedAt: at, by: 'hub-admin' }, pre: draftDoc?.updateTime ?? 'missing' },
      ]);
      draftDoc = { json: s, updateTime: r.writeResults?.[0]?.updateTime ?? r.commitTime, fields: { updatedAt: { stringValue: at } } };
      saved = s;
      say(`초안 저장 OK (${at.slice(11, 16)}) — 앱에는 아직 반영 안 됨, "배포"를 눌러야 반영`, 'ok');
      return true;
    } catch (e: any) {
      say(e?.message ?? String(e), 'err');
      if (e instanceof ConflictError) draftDoc = null;
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  async function publish(reflow: boolean) {
    if (!work) return;
    const p = extend(clone(work), T(), HORIZON, reflow);
    const bad = lockedDiff(p, pub);
    if (bad.length) return say(`잠긴(과거·오늘) 스케줄이 배포본과 다름: ${bad.slice(0, 6).map((i) => dateLabel(i)).join(', ')} — 배포 거부`, 'err');
    const errs = validate(p);
    if (errs.length) return say(`검증 실패 ${errs.length}건\n` + errs.slice(0, 8).join('\n'), 'err');
    const ids = new Set(p.facts.map((f) => f.id));
    const gone = (pub?.facts ?? []).filter((f) => !ids.has(f.id));
    if (gone.length) return say(`${gone[0].id} 삭제 감지 — 배포된 문항은 삭제 대신 "출제 중지"`, 'err');
    const d = diffSummary(p, pub);
    if (pub && !d.total) return say('배포본과 차이 없음', '');
    const next = (pub?.version ?? 0) + 1;
    const ok = confirm(
      `v${next} 배포 — 앱이 다음 실행(최대 3시간 간격 확인) 때 받아 갑니다.\n\n` +
        `새 문항 ${d.added.length} · 수정 ${d.changed.length} · 미래 스케줄 변경 ${d.sched}칸\n` +
        `활성 문항 ${activeCount(p)}개 · 스케줄 ~${dateLabel(p.schedule.length - 1, true)}` +
        (reflow ? '\n\n※ 내일부터 스케줄 전체 재배치' : ''),
    );
    if (!ok) return;
    busy = true;
    render();
    try {
      p.version = next;
      p.updatedAt = nowIso();
      const s = stringify(p);
      if (new TextEncoder().encode(s).length > 900_000) throw new Error('배포본이 Firestore 문서 한도(1MiB)에 근접 — 분할 필요');
      const r: any = await commit(await token(), [
        { path: 'public/content', fields: { version: next, json: s }, pre: pubDoc?.updateTime ?? 'missing' },
        { path: 'public/manifest', fields: { version: next, updatedAt: p.updatedAt, count: activeCount(p) } },
        { path: 'admin/draft', fields: { json: s, updatedAt: p.updatedAt, by: 'hub-admin' }, pre: draftDoc?.updateTime ?? 'missing' },
      ]);
      const ut = (i: number) => r.writeResults?.[i]?.updateTime ?? r.commitTime;
      pub = clone(p);
      pubDoc = { json: s, updateTime: ut(0), fields: {} };
      draftDoc = { json: s, updateTime: ut(2), fields: { updatedAt: { stringValue: p.updatedAt } } };
      work = p;
      saved = s;
      say(`v${next} 배포 OK — 활성 ${activeCount(p)}문항`, 'ok');
    } catch (e: any) {
      say(e?.message ?? String(e), 'err');
    } finally {
      busy = false;
      render();
    }
  }

  function resetToPublished() {
    if (!pub || !work) return;
    if (!confirm('작업본을 현재 배포본(v' + pub.version + ')으로 되돌릴까요? (초안 저장 전까지는 서버 초안 유지)')) return;
    work = clone(pub);
    sel = null;
    form = null;
    say('배포본으로 되돌림 — 저장하려면 "초안 저장"', '');
    render();
  }

  // ---- 문항 편집 ----------------------------------------------------------------------
  function blankFact(category = 'earth'): Fact {
    const order = Math.max(-1, ...(work?.facts ?? []).map((f) => f.order)) + 1;
    return {
      id: nextId(work!, category), category, q: '', choices: ['', '', '', ''], answer: 0,
      detail: '', source: { title: '', url: '' }, order,
    };
  }

  function select(id: string | null) {
    if (form && sel != null && formChanged() && !confirm('편집 중인 내용을 적용하지 않고 이동할까요?')) return;
    sel = id;
    form = id === '' ? blankFact(cat || 'earth') : id ? clone(byId().get(id) ?? null) : null;
    render();
  }

  const formChanged = () => {
    if (!form) return false;
    const cur = sel ? byId().get(sel) : null;
    return !cur || JSON.stringify(cur) !== JSON.stringify(form);
  };

  const normFact = (f: Fact): Fact => {
    const n: Fact = {
      ...f,
      q: f.q.trim(), detail: f.detail.trim(),
      choices: f.choices.map((c) => c.trim()),
      source: { title: f.source.title.trim(), url: f.source.url.trim() },
    };
    if (!n.retired) delete n.retired;
    return n;
  };

  function applyForm() {
    if (!work || !form) return;
    const f = normFact(form);
    const errs = validateFact(f);
    const dupQ = work.facts.find((x) => x.id !== f.id && x.q.trim() === f.q);
    if (dupQ) errs.push(`같은 질문이 이미 있음 (${dupQ.id})`);
    if (errs.length) return say('적용 안 됨:\n' + errs.join('\n'), 'err');
    const i = work.facts.findIndex((x) => x.id === f.id);
    if (i >= 0) work.facts[i] = f;
    else {
      if (sel !== '') return say(`${f.id} 없음`, 'err');
      work.facts.push(f);
    }
    sel = f.id;
    form = clone(f);
    say(`${f.id} 작업본에 적용 — "초안 저장" 또는 "배포"로 서버에 반영`, 'ok');
    render();
  }

  function toggleRetire(id: string) {
    if (!work) return;
    const f = work.facts.find((x) => x.id === id);
    if (!f) return;
    if (!f.retired && activeCount(work) <= 1) return say('마지막 활성 문항은 중지할 수 없음', 'err');
    if (f.retired) delete f.retired;
    else f.retired = true;
    if (form?.id === id) form = clone(f);
    say(f.retired ? `${id} 출제 중지 — 배포 시 미래 스케줄에서 자동 교체(과거 기록은 유지)` : `${id} 출제 재개`, 'ok');
    render();
  }

  function removeUnpublished(id: string) {
    if (!work || pubIds().has(id)) return;
    if (!confirm(`${id} (미배포 새 문항)을 작업본에서 삭제할까요?`)) return;
    work.facts = work.facts.filter((f) => f.id !== id);
    work.schedule = work.schedule.map((s, i) => (s === id && i > T() ? '' : s));
    extend(work, T());
    sel = null;
    form = null;
    render();
  }

  // ---- 스케줄 편집 ---------------------------------------------------------------------
  function setSlot(i: number, id: string) {
    if (!work || i <= T()) return;
    const f = byId().get(id);
    if (!f) return say(`${id}: 없는 문항`, 'err');
    if (f.retired) return say(`${id}: 출제 중지된 문항`, 'err');
    while (work.schedule.length <= i) work.schedule.push('');
    work.schedule[i] = id;
    extend(work, T()); // 사이 빈 칸 채움
    say(`${dateLabel(i)} → ${id}`, 'ok');
    render();
  }

  // ---- 렌더 ------------------------------------------------------------------------
  const catOpts = (v: string, withAll = false) =>
    (withAll ? `<option value="">전체 분류</option>` : '') +
    Object.entries(CATEGORIES).map(([k, n]) => `<option value="${k}"${k === v ? ' selected' : ''}>${n}</option>`).join('');

  function stats() {
    const t = T();
    const m = new Map<string, { n: number; last: number; next: number }>();
    (work?.schedule ?? []).forEach((id, i) => {
      const s = m.get(id) ?? { n: 0, last: -1, next: -1 };
      if (i <= t) { s.n++; s.last = i; } else if (s.next < 0) s.next = i;
      m.set(id, s);
    });
    return m;
  }

  function render() {
    const t = T();
    if (!work) {
      el.innerHTML = `<div class="kt"><div class="kt-bar"><b>너그거알아 문항 관리</b>
        <button type="button" data-act="load"${busy ? ' disabled' : ''}>불러오기</button></div>
        <p class="msg kt-msg ${msg.cls}">${esc(msg.text)}</p></div>`;
      return;
    }
    const d = diffSummary(work, pub);
    const today = byId().get(work.schedule[t] ?? '');
    el.innerHTML = `<div class="kt">
      <div class="kt-bar">
        <div class="sum">
          <b>배포본 v${pub?.version ?? '-'}</b> · 활성 ${activeCount(work)}/${work.facts.length}문항 · 스케줄 ~${dateLabel(work.schedule.length - 1, true)}
          ${d.total ? `<span class="pending">미배포 변경 ${d.added.length ? `새 ${d.added.length} ` : ''}${d.changed.length ? `수정 ${d.changed.length} ` : ''}${d.sched ? `스케줄 ${d.sched}칸` : ''}</span>` : `<span class="pending none">배포본과 동일</span>`}
          ${dirty() ? `<span class="pending bad">초안 미저장</span>` : ''}
          <div class="today">오늘(${dateLabel(t)}) <span class="mono">${esc(today?.id ?? '-')}</span> ${esc(today?.q ?? '')}</div>
        </div>
        <div class="acts">
          <button type="button" data-act="load"${busy ? ' disabled' : ''}>새로고침</button>
          <button type="button" data-act="save"${busy || !dirty() ? ' disabled' : ''}>초안 저장</button>
          <label class="chk" title="내일부터 스케줄을 활성 문항으로 처음부터 다시 배치"><input type="checkbox" class="kt-reflow"> 재배치</label>
          <button type="button" class="primary" data-act="publish"${busy ? ' disabled' : ''}>배포</button>
          <button type="button" data-act="reset"${busy || !pub ? ' disabled' : ''} title="작업본을 배포본으로 되돌림">↺</button>
        </div>
      </div>
      <p class="msg kt-msg ${msg.cls}">${esc(msg.text)}</p>
      <div class="kt-tabs">
        <button type="button" data-tab="facts" class="${tab === 'facts' ? 'on' : ''}">문항</button>
        <button type="button" data-tab="sched" class="${tab === 'sched' ? 'on' : ''}">스케줄</button>
      </div>
      <div class="kt-body">${tab === 'facts' ? factsHtml() : schedHtml()}</div>
    </div>`;
    if (tab === 'facts') { renderList(); renderEditor(); }
  }

  function factsHtml() {
    return `<div class="tools">
        <input type="search" class="kt-search" placeholder="id·질문·보기·해설 검색" value="${esc(query)}">
        <select class="kt-cat">${catOpts(cat, true)}</select>
        <select class="kt-filter">
          ${([['all', '전체'], ['active', '출제 중'], ['retired', '출제 중지'], ['changed', '미배포 변경'], ['errors', '검증 오류']] as const)
            .map(([k, n]) => `<option value="${k}"${k === filter ? ' selected' : ''}>${n}</option>`).join('')}
        </select>
        <button type="button" data-act="new">+ 새 문항</button>
      </div>
      <div class="kt-split"><div class="list kt-list"></div><div class="kt-ed"></div></div>`;
  }

  function renderList() {
    const box = el.querySelector('.kt-list');
    if (!box || !work) return;
    const po = new Map((pub?.facts ?? []).map((f) => [f.id, JSON.stringify(f)]));
    const st = stats();
    const q = query.trim().toLowerCase();
    const rows = work.facts.filter((f) => {
      if (cat && f.category !== cat) return false;
      if (filter === 'active' && f.retired) return false;
      if (filter === 'retired' && !f.retired) return false;
      if (filter === 'changed' && po.get(f.id) === JSON.stringify(f)) return false;
      if (filter === 'errors' && !validateFact(f).length) return false;
      if (q && ![f.id, f.q, f.detail, ...f.choices].join('\n').toLowerCase().includes(q)) return false;
      return true;
    });
    box.innerHTML = `<div class="count">${rows.length}개 / 전체 ${work.facts.length}</div>` + (rows.map((f) => {
      const s = st.get(f.id);
      const chg = po.get(f.id) !== JSON.stringify(f);
      const when = f.retired ? '중지' : s?.next! >= 0 ? `다음 ${dateLabel(s!.next)}` : s?.last! >= 0 ? `최근 ${dateLabel(s!.last)}` : '미배정';
      return `<div class="row${f.id === sel ? ' sel' : ''}${f.retired ? ' retired' : ''}" data-id="${esc(f.id)}">
        <span class="mono">${esc(f.id)}${chg ? '<i class="dot" title="미배포 변경"></i>' : ''}</span>
        <span class="chip">${esc(CATEGORIES[f.category] ?? f.category)}</span>
        <span class="q">${esc(f.q)}</span><span class="when">${when}</span></div>`;
    }).join('') || `<p class="empty">결과 없음</p>`);
  }

  const counter = (v: string, max: number) => `<em class="${len(v) > max ? 'over' : ''}">${len(v)}/${max}</em>`;

  function renderEditor() {
    const box = el.querySelector('.kt-ed');
    if (!box || !work) return;
    if (!form) {
      box.innerHTML = `<div class="editor empty">왼쪽에서 문항을 고르거나 <b>+ 새 문항</b>을 누르세요.<br>
        <small>배포된 문항은 삭제하지 않고 "출제 중지"합니다(과거 기록 보호). 오늘·과거 스케줄은 잠겨 있습니다.</small></div>`;
      return;
    }
    const f = form;
    const isNew = sel === '';
    const published = pubIds().has(f.id);
    const s = stats().get(f.id);
    box.innerHTML = `<div class="editor">
      <h3>${isNew ? '새 문항' : '문항 편집'} <span class="mono">${esc(f.id)}</span>${f.retired ? ' <span class="pending">출제 중지</span>' : ''}</h3>
      <p class="meta">${published ? '배포됨' : '미배포'} · 출제 ${s?.n ?? 0}회${s && s.last >= 0 ? ` (최근 ${dateLabel(s.last)})` : ''}${s && s.next >= 0 ? ` · 다음 ${dateLabel(s.next)}` : ''}${published && (s?.n ?? 0) > 0 ? ' · <b>수정 시 이미 푼 사람의 기록 화면에도 반영</b>' : ''}</p>
      <label class="f"><span>분류${isNew ? '' : ' (id 고정)'}</span><select data-k="category"${isNew ? '' : ' disabled'}>${catOpts(f.category)}</select></label>
      <label class="f"><span>질문 <b class="c" data-c="q">${counter(f.q, LIMITS.q)}</b></span><textarea data-k="q" rows="2">${esc(f.q)}</textarea></label>
      <div class="f"><span>보기 (● = 정답)</span>
        ${f.choices.map((c, i) => `<div class="choice${i === f.answer ? ' ans' : ''}">
          <input type="radio" name="kt-ans" value="${i}"${i === f.answer ? ' checked' : ''}>
          <input type="text" data-choice="${i}" value="${esc(c)}"><span class="n" data-c="c${i}">${counter(c, LIMITS.choice)}</span></div>`).join('')}
      </div>
      <label class="f"><span>해설 <b class="c" data-c="detail">${counter(f.detail, LIMITS.detail)}</b></span><textarea data-k="detail" rows="3">${esc(f.detail)}</textarea></label>
      <div class="two">
        <label class="f"><span>출처 제목</span><input type="text" data-k="source.title" value="${esc(f.source.title)}"></label>
        <label class="f"><span>출처 URL</span><input type="url" data-k="source.url" value="${esc(f.source.url)}"></label>
      </div>
      <p class="errs kt-errs"></p>
      <div class="acts">
        <button type="button" class="primary" data-act="apply">작업본에 적용</button>
        <button type="button" data-act="cancel">취소</button>
        ${isNew ? '' : `<button type="button" data-act="retire">${f.retired ? '출제 재개' : '출제 중지'}</button>`}
        ${!isNew && !published ? `<button type="button" class="danger" data-act="delete">삭제</button>` : ''}
      </div>
      <div class="preview kt-prev"></div>
    </div>`;
    renderLive();
  }

  // 입력 중 포커스를 잃지 않도록 카운터·오류·미리보기만 갱신
  function renderLive() {
    if (!form) return;
    const f = form;
    const set = (k: string, h: string) => { const n = el.querySelector(`[data-c="${k}"]`); if (n) n.innerHTML = h; };
    set('q', counter(f.q, LIMITS.q));
    set('detail', counter(f.detail, LIMITS.detail));
    f.choices.forEach((c, i) => set('c' + i, counter(c, LIMITS.choice)));
    el.querySelectorAll('.kt .choice').forEach((n, i) => n.classList.toggle('ans', i === f.answer));
    const errs = validateFact(normFact(f));
    const e = el.querySelector('.kt-errs');
    if (e) e.textContent = errs.length ? '⚠ ' + errs.join(' · ') : '';
    const p = el.querySelector('.kt-prev');
    if (p) p.innerHTML = `<div class="pq">${esc(f.q || '질문')}</div>
      <ol>${f.choices.map((c, i) => `<li${i === f.answer ? ' class="a"' : ''}>${esc(c || '보기 ' + (i + 1))}</li>`).join('')}</ol>
      <div>${esc(f.detail)}</div>${f.source.title ? `<small class="src">출처: ${esc(f.source.title)}</small>` : ''}`;
  }

  function schedHtml() {
    const t = T();
    const w = work!;
    const f = byId();
    const from = Math.max(0, t + schedFrom);
    const to = Math.min(w.schedule.length - 1, from + schedCount);
    const rows: string[] = [];
    for (let i = from; i <= to; i++) {
      const id = w.schedule[i];
      const x = f.get(id);
      const locked = i <= t;
      const chg = !locked && pub?.schedule[i] !== id;
      rows.push(`<div class="srow${locked ? ' locked' : ''}${i === t ? ' today' : ''}${chg ? ' changed' : ''}">
        <span class="d">${dateLabel(i, true)}${i === t ? ' <b>오늘</b>' : ''}</span>
        <span>${locked ? `<span class="mono">${esc(id)}</span>` : `<input class="sid mono" list="kt-ids" data-i="${i}" value="${esc(id)}">`}</span>
        <span class="sq${!x || x.retired ? ' bad' : ''}">${x ? `<span class="chip">${esc(CATEGORIES[x.category] ?? x.category)}</span> ${esc(x.q)}${x.retired ? ' (출제 중지됨)' : ''}` : '없는 문항'}</span>
      </div>`);
    }
    return `<div class="tools">
        <button type="button" data-act="s-prev">◀ 이전</button>
        <button type="button" data-act="s-today">오늘</button>
        <button type="button" data-act="s-fill" title="스케줄 끝을 ${HORIZON}일 앞까지 채우고, 미래 칸의 중지·없는 문항을 교체">빈칸·중지 문항 정리</button>
        <span class="cnt">오늘·과거는 잠김 · 미래 칸에 문항 id 입력(자동완성)</span>
      </div>
      <datalist id="kt-ids">${w.facts.filter((x) => !x.retired).map((x) => `<option value="${esc(x.id)}">${esc(x.q)}</option>`).join('')}</datalist>
      <div class="sched">${rows.join('')}</div>
      ${to < w.schedule.length - 1 ? `<button type="button" class="more" data-act="s-more">더 보기 (${w.schedule.length - 1 - to}일 남음)</button>` : ''}`;
  }

  // ---- 이벤트(위임) ------------------------------------------------------------------
  el.addEventListener('click', (ev) => {
    const tg = ev.target as HTMLElement;
    const tb = tg.closest<HTMLElement>('[data-tab]');
    if (tb) { tab = tb.dataset.tab as Tab; return render(); }
    const row = tg.closest<HTMLElement>('.kt-list .row');
    if (row) return select(row.dataset.id!);
    const act = tg.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    const reflow = (el.querySelector('.kt-reflow') as HTMLInputElement | null)?.checked ?? false;
    switch (act) {
      case 'load': return void load();
      case 'save': return void saveDraft();
      case 'publish': return void publish(reflow);
      case 'reset': return resetToPublished();
      case 'new': return select('');
      case 'apply': return applyForm();
      case 'cancel': sel = null; form = null; return render();
      case 'retire': if (sel) toggleRetire(sel); return;
      case 'delete': if (sel) removeUnpublished(sel); return;
      case 's-prev': schedFrom -= 30; return render();
      case 's-today': schedFrom = -14; schedCount = 90; return render();
      case 's-more': schedCount += 90; return render();
      case 's-fill': if (work) { extend(work, T()); say('스케줄 정리 완료(작업본)', 'ok'); } return render();
    }
  });

  el.addEventListener('input', (ev) => {
    const tg = ev.target as HTMLInputElement;
    if (tg.classList.contains('kt-search')) { query = tg.value; return renderList(); }
    if (!form) return;
    const k = tg.dataset.k;
    if (tg.dataset.choice != null) form.choices[Number(tg.dataset.choice)] = tg.value;
    else if (k === 'q' || k === 'detail') form[k] = tg.value;
    else if (k === 'source.title') form.source.title = tg.value;
    else if (k === 'source.url') form.source.url = tg.value;
    else return;
    renderLive();
  });

  el.addEventListener('change', (ev) => {
    const tg = ev.target as HTMLInputElement;
    if (tg.classList.contains('kt-cat')) { cat = tg.value; return renderList(); }
    if (tg.classList.contains('kt-filter')) { filter = tg.value as Filter; return renderList(); }
    if (tg.classList.contains('sid')) return setSlot(Number(tg.dataset.i), tg.value.trim());
    if (!form) return;
    if (tg.name === 'kt-ans') { form.answer = Number(tg.value); return renderLive(); }
    if (tg.dataset.k === 'category' && sel === '') {
      form.category = tg.value;
      form.id = nextId(work!, tg.value);
      return renderEditor();
    }
  });

  render();
  return { load, isDirty: dirty };
}
