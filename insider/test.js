'use strict';
// node test.js  (의존성 없이 게임 로직만 검증)
const assert = require('assert');
const { Room, WORDS } = require('./insider');

let passed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
async function runAll() {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('ok  -', name); }
    catch (e) { console.error('FAIL-', name, '\n', e); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${queue.length} tests passed`);
}
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.userMessage || ''));

function makeRoom(n = 4, cfg) {
  const changes = [];
  const r = new Room('TEST', (room) => changes.push(room.phase), cfg);
  const toks = [];
  for (let i = 0; i < n; i++) {
    const t = `tok${i}`;
    r.join(t, `P${i}`);
    toks.push(t);
  }
  return { r, toks, changes };
}
const roleOf = (r, t) => r.view(t).me.role;
const find = (r, toks, role) => toks.find((t) => roleOf(r, t) === role);

test('lobby: 방장은 첫 입장자, 인원 부족이면 시작 불가', () => {
  const { r, toks } = makeRoom(3);
  assert.strictEqual(r.hostToken, 'tok0');
  throwsMsg(() => r.start('tok0'), /최소 4명/);
  throwsMsg(() => makeRoom(4).r.start('tok1'), /방장만/);
  r.join('tok3', 'P3');
  r.start('tok0');
  assert.strictEqual(r.phase, 'asking');
  r.dispose();
});

test('중복 이름은 번호가 붙는다', () => {
  const r = new Room('X');
  r.join('a', '민수'); r.join('b', '민수');
  assert.deepStrictEqual(r.view('a').players.map((p) => p.name), ['민수', '민수2']);
});

test('9명 이상 시작 불가', () => {
  const { r } = makeRoom(9);
  throwsMsg(() => r.start('tok0'), /최대 8명/);
});

test('역할 배정: 출제자 1, 인사이더 1, 나머지 일반인', () => {
  const { r, toks } = makeRoom(6);
  r.start('tok0');
  const roles = toks.map((t) => roleOf(r, t));
  assert.strictEqual(roles.filter((x) => x === 'master').length, 1);
  assert.strictEqual(roles.filter((x) => x === 'insider').length, 1);
  assert.strictEqual(roles.filter((x) => x === 'commoner').length, 4);
  r.dispose();
});

test('정보 분리: 일반인에게는 제시어와 인사이더 정체가 새지 않는다', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const m = find(r, toks, 'master'), i = find(r, toks, 'insider'), c = find(r, toks, 'commoner');
  assert.ok(WORDS.includes(r.view(m).me.word));
  assert.strictEqual(r.view(i).me.word, r.view(m).me.word);
  assert.strictEqual(r.view(c).me.word, null);
  const raw = JSON.stringify(r.view(c));
  assert.ok(!raw.includes(r.word), '일반인 화면 JSON에 제시어가 들어 있음');
  assert.ok(!raw.includes(r.players.get(i).id) || raw.split(r.players.get(i).id).length === 2);
  assert.strictEqual(r.view(c).result, null);
  r.dispose();
});

test('출제자는 질문 단계에서 채팅 불가, 버튼 답만 가능', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const m = find(r, toks, 'master'), c = find(r, toks, 'commoner');
  throwsMsg(() => r.chatMsg(m, '힌트'), /버튼/);
  r.chatMsg(c, '먹는 건가요?');
  r.answer(m, 'yes');
  throwsMsg(() => r.answer(c, 'yes'), /출제자만/);
  throwsMsg(() => r.answer(m, 'maybe'), /알 수 없는/);
  const types = r.chat.map((x) => x.type);
  assert.ok(types.includes('chat') && types.includes('answer'));
  r.dispose();
});

test('정답 시도: 출제자 본인/관전자 불가, 대기 중엔 중복 불가', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const m = find(r, toks, 'master'), c = find(r, toks, 'commoner');
  throwsMsg(() => r.guess(m, '아무거나'), /출제자는/);
  r.join('late', '지각생');
  throwsMsg(() => r.guess('late', '아무거나'), /관전/);
  r.guess(c, '틀린답');
  throwsMsg(() => r.guess(c, '또'), /기다려/);
  const g = r.chat.find((x) => x.type === 'guess');
  throwsMsg(() => r.judge(c, g.id, true), /출제자만/);
  r.judge(m, g.id, false);
  assert.strictEqual(g.status, 'wrong');
  r.guess(c, '두번째');
  r.dispose();
});

test('정답이면 토론 단계로, 제시어가 모두에게 공개된다', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const m = find(r, toks, 'master'), c = find(r, toks, 'commoner');
  r.guess(c, r.word);
  r.judge(m, r.chat.find((x) => x.type === 'guess').id, true);
  assert.strictEqual(r.phase, 'discussion');
  assert.strictEqual(r.view(c).me.word, r.word);
  assert.strictEqual(r.view(c).guessedBy, r.players.get(c).name);
  r.chatMsg(m, '이제 말할 수 있다');
  r.dispose();
});

function toVote(r, toks) {
  const m = find(r, toks, 'master'), c = find(r, toks, 'commoner');
  r.guess(c, r.word);
  r.judge(m, r.chat.find((x) => x.type === 'guess' && x.status === 'pending').id, true);
  toks.forEach((t) => r.skipDiscuss(t));
  assert.strictEqual(r.phase, 'vote');
}

test('전원이 넘기기를 누르면 투표로 이동', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const m = find(r, toks, 'master'), c = find(r, toks, 'commoner');
  r.guess(c, r.word);
  r.judge(m, r.chat.find((x) => x.type === 'guess').id, true);
  toks.slice(0, 3).forEach((t) => r.skipDiscuss(t));
  assert.strictEqual(r.phase, 'discussion');
  r.skipDiscuss(toks[3]);
  assert.strictEqual(r.phase, 'vote');
  r.dispose();
});

test('투표: 자기 자신/존재하지 않는 대상 거부', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0'); toVote(r, toks);
  throwsMsg(() => r.castVote('tok0', r.players.get('tok0').id), /자기 자신/);
  throwsMsg(() => r.castVote('tok0', 'nope'), /대상/);
  r.dispose();
});

test('인사이더를 최다 득표로 지목하면 일반 진영 승리(+1씩, 인사이더 0)', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0'); toVote(r, toks);
  const ins = find(r, toks, 'insider'), insId = r.players.get(ins).id;
  toks.forEach((t) => {
    if (t === ins) {
      const other = toks.find((x) => x !== ins);
      r.castVote(t, r.players.get(other).id);
    } else r.castVote(t, insId);
  });
  assert.strictEqual(r.phase, 'result');
  assert.strictEqual(r.result.winner, 'crew');
  assert.strictEqual(r.players.get(ins).score, 0);
  toks.filter((t) => t !== ins).forEach((t) => assert.strictEqual(r.players.get(t).score, 1));
  assert.strictEqual(r.result.insiderName, r.players.get(ins).name);
  r.dispose();
});

test('다른 사람을 지목하면 인사이더 승리(+2)', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0'); toVote(r, toks);
  const ins = find(r, toks, 'insider');
  const innocent = find(r, toks, 'commoner'), innId = r.players.get(innocent).id;
  const innocentVoter = toks.find((t) => t !== innocent);
  toks.forEach((t) => r.castVote(t, t === innocent ? r.players.get(innocentVoter).id : innId));
  assert.strictEqual(r.result.winner, 'insider');
  assert.strictEqual(r.players.get(ins).score, 2);
  r.dispose();
});

test('동점이면 인사이더 승리', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0'); toVote(r, toks);
  const [a, b, c, d] = toks.map((t) => r.players.get(t).id);
  r.castVote(toks[0], b); r.castVote(toks[1], a); r.castVote(toks[2], d); r.castVote(toks[3], c);
  assert.strictEqual(r.result.winner, 'insider');
  assert.strictEqual(r.result.reason, 'tie');
  r.dispose();
});

test('접속이 끊긴 사람은 기다리지 않는다', () => {
  const { r, toks } = makeRoom(5);
  r.start('tok0'); toVote(r, toks);
  const ins = find(r, toks, 'insider');
  const voters = toks.filter((t) => t !== toks[4]);
  voters.forEach((t) => r.castVote(t, r.players.get(t === ins ? toks.find((x) => x !== ins) : ins).id));
  assert.strictEqual(r.phase, 'vote');
  r.setConnected(toks[4], false);
  assert.strictEqual(r.phase, 'result');
  r.dispose();
});

test('방장이 나가면 다음 접속자에게 방장이 넘어간다', () => {
  const { r } = makeRoom(4);
  r.setConnected('tok0', false);
  r.ensureHost();
  assert.strictEqual(r.hostToken, 'tok1');
});

test('다음 라운드: 출제자가 돌아가며, 지각생은 참가자가 된다', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const firstMaster = r.masterToken;
  r.join('late', '지각생');
  assert.strictEqual(roleOf(r, 'late'), 'spectator');
  r.finish({ winner: 'none', reason: 'timeout' });
  assert.strictEqual(r.phase, 'result');
  r.start('tok0');
  assert.notStrictEqual(r.masterToken, firstMaster);
  assert.notStrictEqual(roleOf(r, 'late'), 'spectator');
  assert.strictEqual(r.round, 2);
  r.dispose();
});

test('4라운드 동안 모든 사람이 한 번씩 출제자를 맡는다', () => {
  const { r, toks } = makeRoom(4);
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    r.start('tok0');
    seen.add(r.masterToken);
    r.finish({ winner: 'none', reason: 'timeout' });
  }
  assert.strictEqual(seen.size, 4);
  r.dispose();
});

test('같은 단어가 연속해서 나오지 않는다', () => {
  const { r } = makeRoom(4);
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    r.start('tok0');
    assert.ok(!seen.has(r.word));
    seen.add(r.word);
    r.finish({ winner: 'none', reason: 'timeout' });
  }
  r.dispose();
});

test('방장 중단: 로비로 돌아가고 점수는 유지', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  throwsMsg(() => r.cancel('tok1'), /방장만/);
  r.cancel('tok0');
  assert.strictEqual(r.phase, 'lobby');
  assert.strictEqual(r.view('tok0').me.role, null);
  r.dispose();
});

test('타이머: 질문 시간이 끝나면 전원 패배(0점)로 결과 화면', async () => {
  const { r, toks, changes } = makeRoom(4, { askMs: 30 });
  r.start('tok0');
  await new Promise((res) => setTimeout(res, 80));
  assert.strictEqual(r.phase, 'result');
  assert.strictEqual(r.result.winner, 'none');
  assert.ok(toks.every((t) => r.players.get(t).score === 0));
  assert.ok(changes.includes('result'));
  assert.ok(r.view('tok0').result.word);
});

test('타이머: 토론과 투표 시간이 지나면 자동 진행', async () => {
  const { r, toks } = makeRoom(4, { discussMs: 30, voteMs: 150 });
  r.start('tok0');
  const m = find(r, toks, 'master'), c = find(r, toks, 'commoner');
  r.guess(c, r.word);
  r.judge(m, r.chat.find((x) => x.type === 'guess').id, true);
  await new Promise((res) => setTimeout(res, 70));
  assert.strictEqual(r.phase, 'vote');
  await new Promise((res) => setTimeout(res, 200));
  assert.strictEqual(r.phase, 'result');
  assert.strictEqual(r.result.winner, 'insider'); // 무투표는 인사이더 승리
});

runAll();
