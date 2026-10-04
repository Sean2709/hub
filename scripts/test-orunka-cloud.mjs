// node scripts/test-orunka-cloud.mjs — /admin/ 오룬카 「서버 저장」 패널(lib/orunka-cloud.ts) 시험
//   단위: 필드 8개·검사·백업 id·시각 꼴 / 실측(--live): 익명 시험 계정으로 자기 saves/{uid} 를 만들고
//   패널과 같은 commit(백업 + updateTime 전제조건)을 실제 Firestore 에 보내 본다 — 끝나면 문서·계정을 지운다.
//   관리자 목록(다른 사람 저장 읽기)은 관리자 Google 로그인이 필요해 여기선 못 본다(규칙은 tools/cloud/test_cloud.py).
const m = await import('../src/lib/orunka-cloud.ts');
let fails = 0;
const t = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : ' — ' + extra)); if (!ok) fails++; };

const save = { ver: 3, name: '투바', lv: 7, exp: 10, money: 1234, playTime: 3725.5, pets: [{ sp: 'tuba', lv: 5 }], inv: [], quests: [] };
const now = new Date(2026, 9, 4, 23, 5, 9);
const f = m.saveFields(save, now);
t('필드 8개', Object.keys(f).sort().join() === 'client,device,json,lv,name,playTime,savedAt,ver');
t('json = 저장 그대로', JSON.stringify(JSON.parse(f.json.stringValue)) === JSON.stringify(save));
t('lv 정수 문자열', f.lv.integerValue === '7' && f.ver.integerValue === '3');
t('playTime double', f.playTime.doubleValue === 3725.5);
t('device/client = admin', f.device.stringValue === 'admin' && f.client.stringValue === 'admin');
t('savedAt 기기 시각 꼴', /^2026-10-04T23:05:09[+-]\d\d:\d\d$/.test(f.savedAt.stringValue), f.savedAt.stringValue);
t('백업 id 꼴(serve.py 와 같음)', m.backupId(now) === 'replaced-20261004-230509');
const cb = m.commitBody('U1', { json: { stringValue: '{}' } }, '2026-10-04T01:00:00.1Z', save, now);
t('commit 2건: 백업 → 본문(전제조건)', cb.writes.length === 2 && cb.writes[0].update.name.endsWith('/saves/U1/days/replaced-20261004-230509')
  && !cb.writes[0].currentDocument && cb.writes[1].update.name.endsWith('/documents/saves/U1')
  && cb.writes[1].currentDocument.updateTime === '2026-10-04T01:00:00.1Z');
t('검사: 정상 저장 통과', m.checkSave(save).length === 0);
t('검사: 배열 거절', m.checkSave([]).length === 1);
t('검사: 이름 없음', m.checkSave({ ...save, name: '' }).length === 1);
t('검사: lv 0·소수', m.checkSave({ ...save, lv: 0 }).length === 1 && m.checkSave({ ...save, lv: 2.5 }).length === 1);
t('검사: 라이 음수', m.checkSave({ ...save, money: -1 }).length === 1);
t('검사: pets 배열 아님', m.checkSave({ ...save, pets: {} }).length === 1);
t('검사: 400KB', m.checkSave({ ...save, pad: 'x'.repeat(400000) }).length === 1);
t('val()', m.val({ integerValue: '5' }) === 5 && m.val({ doubleValue: 1.5 }) === 1.5 && m.val({ stringValue: 'a' }) === 'a' && m.val(undefined) === undefined);

if (process.argv.includes('--live')) {
  const KEY = 'AIzaSyC4gjiwEudf6GMBpm1u3vlGEmhk-lBijKs';
  const FS = m.FS_URL;
  const js = async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) });
  const { j: acct } = await js(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) }));
  const uid = acct.localId, H = { Authorization: `Bearer ${acct.idToken}`, 'Content-Type': 'application/json' };
  t('익명 시험 계정', !!uid, JSON.stringify(acct).slice(0, 200));
  try {
    const first = m.saveFields(save, now);
    let r = await js(await fetch(`${FS}/saves/${uid}?currentDocument.exists=false`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: first }) }));
    t('본문 만들기', r.s === 200, JSON.stringify(r.j).slice(0, 200));
    const prevUpdate = r.j.updateTime, prevFields = r.j.fields;
    const edited = { ...save, money: 99999 };
    const later = new Date(now.getTime() + 61000);
    r = await js(await fetch(`${FS}:commit`, { method: 'POST', headers: H, body: JSON.stringify(m.commitBody(uid, prevFields, prevUpdate, edited, later)) }));
    t('commit(백업 + 전제조건) 성공', r.s === 200 && r.j.writeResults?.length === 2, JSON.stringify(r.j).slice(0, 300));
    r = await js(await fetch(`${FS}/saves/${uid}`, { headers: H }));
    t('본문 = 고친 판', JSON.parse(r.j.fields.json.stringValue).money === 99999 && r.j.fields.device.stringValue === 'admin' && r.j.updateTime !== prevUpdate);
    r = await js(await fetch(`${FS}/saves/${uid}/days/${m.backupId(later)}`, { headers: H }));
    t('백업 = 고치기 전 판', r.s === 200 && JSON.parse(r.j.fields.json.stringValue).money === 1234 && r.j.fields.device.stringValue === 'admin');
    r = await js(await fetch(`${FS}:commit`, { method: 'POST', headers: H, body: JSON.stringify(m.commitBody(uid, prevFields, prevUpdate, { ...save, money: 1 }, new Date(later.getTime() + 5000))) }));
    t('옛 updateTime 이면 거절(FAILED_PRECONDITION)', r.s === 400 && r.j.error?.status === 'FAILED_PRECONDITION', JSON.stringify(r.j).slice(0, 200));
    r = await js(await fetch(`${FS}/saves/${uid}`, { headers: H }));
    t('거절된 commit 은 백업도 안 남김(원자적)', JSON.parse(r.j.fields.json.stringValue).money === 99999);
    r = await js(await fetch(`${FS}/saves/${uid}/days?pageSize=10&mask.fieldPaths=lv`, { headers: H }));
    t('백업 목록 1건', (r.j.documents ?? []).length === 1, JSON.stringify(r.j).slice(0, 200));
    r = await js(await fetch(`${FS}/saves?pageSize=10&mask.fieldPaths=lv`, { headers: H }));
    t('관리자 아님 → 전체 목록 거절', r.s === 403, String(r.s));
  } finally {
    const r = await js(await fetch(`${FS}/saves/${uid}/days?pageSize=50`, { headers: H }));
    for (const d of r.j.documents ?? []) await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE', headers: H });
    await fetch(`${FS}/saves/${uid}`, { method: 'DELETE', headers: H });
    const del = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: acct.idToken }) }); // Bearer 붙이면 401
    t('정리(문서·시험 계정 지움)', del.ok);
  }
}
console.log(fails ? `FAIL ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
