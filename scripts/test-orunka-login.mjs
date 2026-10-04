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
// ---- Sign in with Apple
const u = new URL(mod.appleAuthUrl('as123456', 'ab'.repeat(32)));
t('apple url 호스트', u.origin + u.pathname === 'https://appleid.apple.com/auth/authorize');
t('apple url 값', u.searchParams.get('client_id') === 'com.seanson.orunka.signin' && u.searchParams.get('redirect_uri') === 'https://hub.seanson.com/orunka/login/'
  && u.searchParams.get('response_type') === 'code id_token' && u.searchParams.get('response_mode') === 'fragment' && u.searchParams.get('state') === 'as123456');
t('apple url scope 없음(fragment 조건)', !u.searchParams.has('scope') && !mod.appleAuthUrl('a', 'b').includes('+'));
t('sha256hex', (await mod.sha256hex('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
t('randomHex 길이', mod.randomHex(32).length === 64 && mod.randomHex(32) !== mod.randomHex(32));
const sv = { cb: 'orunka://auth', state: 'gamestate1', as: 'appleSt1', nonce: 'rawnonce' };
const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhIn0.c2ln';
let r = mod.appleReturn(`#code=c1.0.x&id_token=${jwt}&state=appleSt1`, sv);
t('apple 돌아옴 정상', r.ok && r.cb === 'orunka://auth' && r.state === 'gamestate1' && r.kv.idt === jwt && r.kv.prov === 'apple.com' && r.kv.nonce === 'rawnonce' && r.kv.code === 'c1.0.x');
t('apple state 다름', !mod.appleReturn(`#id_token=${jwt}&state=other`, sv).ok && mod.appleReturn(`#id_token=${jwt}&state=other`, sv).cb === undefined);
t('apple 저장값 없음', !mod.appleReturn(`#id_token=${jwt}&state=appleSt1`, null).ok);
t('apple 저장값 cb 위조', !mod.appleReturn(`#id_token=${jwt}&state=appleSt1`, { ...sv, cb: 'https://evil.example/cb' }).ok);
r = mod.appleReturn('#error=user_cancelled_authorize&state=appleSt1', sv);
t('apple 취소 → 게임에 err', !r.ok && r.cb === 'orunka://auth' && /그만뒀/.test(r.msg));
t('apple 토큰 꼴 아님', !mod.appleReturn('#id_token=<x>&state=appleSt1', sv).ok);
// Google 리디렉트(iPhone 시트)
const gu = new URL(mod.googleAuthUrl('cid.apps.googleusercontent.com', 'gSt1', 'n1'));
t('google 주소', gu.origin === 'https://accounts.google.com' && gu.searchParams.get('redirect_uri') === 'https://hub.seanson.com/orunka/login/'
  && gu.searchParams.get('response_type') === 'id_token' && gu.searchParams.get('state') === 'gSt1' && gu.searchParams.get('nonce') === 'n1' && gu.searchParams.get('client_id') === 'cid.apps.googleusercontent.com');
const gs = { cb: 'orunka://auth', state: 'gamestate1', as: 'gSt1', nonce: 'n1' };
r = mod.googleReturn(`#state=gSt1&id_token=${jwt}&authuser=0&prompt=consent`, gs);
t('google 돌아옴 정상', r.ok && r.cb === 'orunka://auth' && r.kv.idt === jwt && r.kv.prov === 'google.com' && !('nonce' in r.kv));
t('google state 다름', !mod.googleReturn(`#state=x&id_token=${jwt}`, gs).ok);
t('google 저장값 cb 위조', !mod.googleReturn(`#state=gSt1&id_token=${jwt}`, { ...gs, cb: 'https://evil.example/cb' }).ok);
r = mod.googleReturn('#error=access_denied&state=gSt1', gs);
t('google 취소 → 게임에 err', !r.ok && r.cb === 'orunka://auth' && /그만뒀/.test(r.msg));
console.log('FAILS', fails); process.exit(fails ? 1 : 0);
