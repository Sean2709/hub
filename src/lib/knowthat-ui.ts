// 너그거알아(KnowThat) 문항 관리 패널 — /admin/ 앱 관리 탭에서 mount.
// 작업본(메모리) → "초안 저장"(admin/draft) → "배포"(public/content + manifest, version+1).
// 규칙(검증·스케줄 잠금·연장)은 knowthat-core.ts = KnowThat `scripts/content.py`와 동일.
// 앱 1.0.2~는 사용자별 무작위 배정(날짜별 공통 문제 없음) → 화면은 문항 풀 중심. 날짜 스케줄은 1.0.1 이하 호환용 탭으로만.
import {
  CATEGORIES, LIMITS, HORIZON, RELEASE_INDEX, type Fact, type Payload, type Doc,
  len, clone, todayIndex, dateLabel, nowIso, validate, validateFact, extend, lockedDiff,
  diffSummary, categoryCounts, nextId, firebaseToken, clearFirebaseToken, getDoc, commit, ConflictError,
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
  let reflow = false; // 다음 배포 때 구버전 스케줄을 내일부터 재배치
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

  async function publish() {
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
    const n = activeCount(p);
    const other = d.changed.length - d.retired.length - d.resumed.length;
    const ok = confirm(
      `v${next} 배포 — 앱이 다음 실행(최대 3시간 간격 확인) 때 받아 갑니다.\n\n` +
        `새 문항 ${d.added.length} · 내용 수정 ${other} · 출제 중지 ${d.retired.length} · 재개 ${d.resumed.length}\n` +
        `활성 문항 ${n}개 — 사용자마다 무작위 하루 1문항(한 사람당 ${n}일 동안 중복 없음)\n` +
        `구버전(1.0.1 이하) 스케줄: ~${dateLabel(p.schedule.length - 1, true)}까지 자동 연장${d.sched ? ` · 변경 ${d.sched}칸` : ''}` +
        (reflow ? '\n\n※ 구버전 스케줄을 내일부터 전체 재배치' : ''),
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
      reflow = false;
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
    say(f.retired ? `${id} 출제 중지 — 배포하면 더 이상 배정 안 됨(오늘 아직 안 푼 사람은 다른 문제로 교체, 푼 기록은 유지)` : `${id} 출제 재개 — 배포하면 다시 배정 대상`, 'ok');
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

  function render() {
    if (!work) {
      el.innerHTML = `<div class="kt"><div class="kt-bar"><b>너그거알아 문항 관리</b>
        <button type="button" data-act="load"${busy ? ' disabled' : ''}>불러오기</button></div>
        <p class="msg kt-msg ${msg.cls}">${esc(msg.text)}</p></div>`;
      return;
    }
    const d = diffSummary(work, pub);
    const n = activeCount(work);
    const other = d.changed.length - d.retired.length - d.resumed.length;
    const pend = [
      d.added.length && `새 ${d.added.length}`, other && `수정 ${other}`,
      d.retired.length && `중지 ${d.retired.length}`, d.resumed.length && `재개 ${d.resumed.length}`,
      d.sched && `구버전 스케줄 ${d.sched}칸`,
    ].filter(Boolean).join(' · ');
    el.innerHTML = `<div class="kt">
      <div class="kt-bar">
        <div class="sum">
          <b>배포본 v${pub?.version ?? '-'}</b> · 활성 ${n}/${work.facts.length}문항
          ${d.total ? `<span class="pending">미배포 변경 ${pend}</span>` : `<span class="pending none">배포본과 동일</span>`}
          ${dirty() ? `<span class="pending bad">초안 미저장</span>` : ''}
          <div class="kt-note">출제: 사용자마다 무작위 하루 1문항 · 한 번 본 문제는 다시 안 나옴(앱 1.0.2~) · 한 사람당 <b>${n}일</b> 중복 없음 · 가장 빠른 재출제 ≈ ${dateLabel(RELEASE_INDEX + n, true)}(출시일 설치자 기준)</div>
        </div>
        <div class="acts">
          <button type="button" data-act="load"${busy ? ' disabled' : ''}>새로고침</button>
          <button type="button" data-act="save"${busy || !dirty() ? ' disabled' : ''}>초안 저장</button>
          <button type="button" class="primary" data-act="publish"${busy ? ' disabled' : ''}>배포</button>
          <button type="button" data-act="reset"${busy || !pub ? ' disabled' : ''} title="작업본을 배포본으로 되돌림">↺</button>
        </div>
      </div>
      <p class="msg kt-msg ${msg.cls}">${esc(msg.text)}</p>
      <div class="kt-tabs">
        <button type="button" data-tab="facts" class="${tab === 'facts' ? 'on' : ''}">문항</button>
        <button type="button" data-tab="sched" class="${tab === 'sched' ? 'on' : ''}" title="앱 1.0.1 이하만 쓰는 날짜별 스케줄">구버전 스케줄</button>
      </div>
      <div class="kt-body">${tab === 'facts' ? factsHtml() : schedHtml()}</div>
    </div>`;
    if (tab === 'facts') { renderList(); renderEditor(); }
  }

  function factsHtml() {
    const cc = categoryCounts(work!);
    const n = activeCount(work!) || 1;
    return `<div class="kt-cats" title="앱은 남은(안 본) 문항 수에 비례해 분야를 고릅니다 — 활성 문항 비율 ≈ 출제 비율">
        <span class="lb">분야별 활성</span>
        ${[...cc].map(([k, c]) => `<button type="button" class="cat${k === cat ? ' on' : ''}" data-cat="${k}">${esc(CATEGORIES[k])} <b>${c}</b> <small>${Math.round((c / n) * 100)}%</small></button>`).join('')}
      </div>
      <div class="tools">
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
      const chg = po.get(f.id) !== JSON.stringify(f);
      const when = f.retired ? '출제 중지' : !po.has(f.id) ? '미배포' : '';
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
        <small>문제는 사용자마다 무작위로 배정되고, 한 번 본 문제는 다시 나오지 않습니다(앱 1.0.2~). 새 문항은 배포하면 모든 사람의 "안 본 문제"에 들어갑니다.<br>
        배포된 문항은 누군가 이미 풀었을 수 있어 삭제하지 않고 "출제 중지"합니다(푼 기록 보호).</small></div>`;
      return;
    }
    const f = form;
    const isNew = sel === '';
    const published = pubIds().has(f.id);
    box.innerHTML = `<div class="editor">
      <h3>${isNew ? '새 문항' : '문항 편집'} <span class="mono">${esc(f.id)}</span>${f.retired ? ' <span class="pending">출제 중지</span>' : ''}</h3>
      <p class="meta">${!published ? '미배포 — 배포하면 모든 사람의 "안 본 문제"에 추가' : f.retired ? '배포됨 · 출제 중지(새로 배정 안 됨, 푼 기록엔 남음)' : '배포됨 · 무작위 배정 대상'}${published ? ' · <b>수정하면 이 문제를 이미 푼 사람의 기록 화면에도 반영</b>' : ''}</p>
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
    const today = f.get(w.schedule[t] ?? '');
    return `<div class="kt-legacy">
        <b>앱 1.0.2부터는 이 스케줄을 쓰지 않습니다</b> — 사용자마다 무작위로 배정돼 "오늘의 공통 문제"가 없습니다.
        1.0.1 이하를 아직 쓰는 사람만 이 날짜별 문항을 받고, 배포할 때 오늘+${HORIZON}일까지 자동 연장·중지 문항 자동 교체되므로 보통 손댈 필요 없습니다.
        <div class="lt">구버전 오늘 ${dateLabel(t)} · <span class="mono">${esc(today?.id ?? '-')}</span> ${esc(today?.q ?? '')}</div>
        <label class="chk" title="내일부터 스케줄을 활성 문항으로 처음부터 다시 배치"><input type="checkbox" class="kt-reflow"${reflow ? ' checked' : ''}> 다음 배포 때 내일부터 재배치</label>
      </div>
      <div class="tools">
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
    const cb = tg.closest<HTMLElement>('.kt-cats [data-cat]');
    if (cb) { cat = cat === cb.dataset.cat ? '' : cb.dataset.cat!; return render(); }
    const act = tg.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    switch (act) {
      case 'load': return void load();
      case 'save': return void saveDraft();
      case 'publish': return void publish();
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
    if (tg.classList.contains('kt-reflow')) { reflow = tg.checked; return; }
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
