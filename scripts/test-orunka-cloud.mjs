// node scripts/test-orunka-cloud.mjs [--live [--server https://…]] [--help] — /admin/ 오룬카 저장 패널 시험
//   단위: lib/orunka-cloud.ts 필드 8개·검사·백업 id·시각 꼴(인터넷 없이)
//   실측(--live): 게임 서버(기본 https://game.seanson.com)에 QA 시험 신원(tok "qa:<무작위>" + 헤더 x-orunka-qa = QA 열쇠,
//     게임 레포 tools/server/qa/qaid.py 와 같은 길)으로 /api/me/chars 를 불러 보고, 열쇠 없음·틀림 거절, 그 신원으로 관리 API(/admin/api/saves) 거절을 본 뒤
//     /api/me/delete 로 치운다(Firebase 계정 안 만듦). 열쇠 = 환경 변수 ORUNKA_QA_KEY, 없으면 ~/.config/orunka/qa.key(서버 env ORUNKA_QA_KEY 와 같아야).
//   익명 로그인은 없앰(게임 레포 41f8b7a W22 — 서버는 anonymous 토큰을 언제나 거절, Firestore saves 쓰기도 규칙으로 막힘) → 옛 익명 signUp·Firestore commit 실측은 지웠다.
//   관리자 목록(다른 사람 저장 읽기)은 관리자 Google 로그인이 필요해 여기선 못 본다.
const HELP = `node scripts/test-orunka-cloud.mjs            단위 시험만
node scripts/test-orunka-cloud.mjs --live     + 실서버 QA 시험 신원 실측(열쇠: ORUNKA_QA_KEY 또는 ~/.config/orunka/qa.key)
  --server <https://…>                        실측 대상(기본 https://game.seanson.com)`;
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); process.exit(0); }
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : ''; };
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
  // QA 시험 신원(게임 레포 tools/server/qa/qaid.py · Auth.cs W22) — 열쇠는 출력하지 않는다
  const { readFileSync, existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  const kf = `${homedir()}/.config/orunka/qa.key`;
  const QA = (process.env.ORUNKA_QA_KEY || (existsSync(kf) ? readFileSync(kf, 'utf8') : '')).trim();
  if (!QA) { console.log('FAIL QA 열쇠 없음(ORUNKA_QA_KEY · ~/.config/orunka/qa.key) — 서버는 익명 토큰을 받지 않고, 시험 신원은 열쇠가 있어야 만든다'); process.exit(2); }
  const base = (arg('--server') || 'https://game.seanson.com').replace(/\/+$/, '');
  const tok = 'qa:' + randomBytes(8).toString('hex');   // = 서버 uid
  const H = { Authorization: `Bearer ${tok}`, 'x-orunka-qa': QA, 'Content-Type': 'application/json' };
  const js = async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) });
  const brief = (r) => `${r.s} ${JSON.stringify(r.j).slice(0, 200)}`;
  console.log(`실측: ${base} · 시험 신원 ${tok}`);
  try {
    let r = await js(await fetch(`${base}/api/me/chars`, { headers: H }));
    t('QA 시험 신원 → /api/me/chars 200 · 자리 3 · 빈 목록', r.s === 200 && r.j.max === 3 && Array.isArray(r.j.chars) && r.j.chars.length === 0, brief(r));
    r = await js(await fetch(`${base}/api/me/chars`, { headers: { Authorization: `Bearer ${tok}` } }));
    t('열쇠 없이 qa 토큰 → 401', r.s === 401, brief(r));
    r = await js(await fetch(`${base}/api/me/chars`, { headers: { ...H, 'x-orunka-qa': QA + 'x' } }));
    t('틀린 열쇠 → 401', r.s === 401, brief(r));
    r = await js(await fetch(`${base}/admin/api/saves`, { headers: H }));
    t('QA 시험 신원은 관리 API 못 씀(/admin/api/saves → 401)', r.s === 401, brief(r));
  } finally {
    const r = await js(await fetch(`${base}/api/me/delete`, { method: 'POST', headers: H, body: '{}' }));
    t('정리(/api/me/delete — 시험 신원 캐릭터 지움)', r.s === 200 && r.j.ok === true, brief(r));
  }
}
console.log(fails ? `FAIL ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
