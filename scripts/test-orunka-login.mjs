// node scripts/test-orunka-login.mjs — /orunka/login/ cb·state 검사 단위 시험(Node 24 타입 벗기기)
// Node 24 는 .ts 의 타입을 벗겨 바로 import 한다
const mod = await import('../src/lib/orunka-login.ts');
let fails = 0;
const t = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };
for (const ok of ['http://127.0.0.1:51234/cb', 'orunka://auth', 'http://127.0.0.1:7800/admin/cloud/cb', 'http://127.0.0.1:1024/'])
  t('허용 ' + ok, mod.validCb(ok));
for (const bad of ['https://evil.example/cb', 'http://127.0.0.1.evil.com:8000/cb', 'http://localhost:51234/cb', 'orunka://authx', 'orunka://auth?x=1',
  'http://127.0.0.1:80/cb', 'http://127.0.0.1:70000/cb', 'http://127.0.0.1:51234/cb?x=1', 'http://127.0.0.1:51234/cb#x', 'http://127.0.0.1:51234@evil.com/cb',
  'javascript:alert(1)', '', null, 'http://127.0.0.1:5123/../cb'.replace('..', '%2e%2e')])
  t('거절 ' + bad, !mod.validCb(bad));
t('state 정상', mod.validState('abcDEF12_-xyz'));
for (const bad of ['short', 'a'.repeat(129), 'has space!!', null, '<script>'])
  t('state 거절 ' + bad, !mod.validState(bad));
t('backUrl', mod.backUrl('http://127.0.0.1:5555/cb', 'abcdefgh', { idt: 'a.b+c' }) === 'http://127.0.0.1:5555/cb?state=abcdefgh&idt=a.b%2Bc');
console.log('FAILS', fails); process.exit(fails ? 1 : 0);
