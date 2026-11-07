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

// n명이 들어와 모두 준비한 방
function makeRoom(n = 4, cfg, readyAll = true) {
  const changes = [];
  const r = new Room('TEST', (room) => changes.push(room.phase), cfg);
  const toks = [];
  for (let i = 0; i < n; i++) {
    const t = `tok${i}`;
    r.join(t, `P${i}`);
    if (readyAll) r.setReady(t, true);
    toks.push(t);
  }
  return { r, toks, changes };
}
const roleOf = (r, t) => r.view(t).me.role;
const find = (r, toks, role) => toks.find((t) => roleOf(r, t) === role);
const tokOf = (r, id) => [...r.players.values()].find((p) => p.id === id).token;
const asker = (r) => tokOf(r, r.view(r.masterToken).turn.askerId);

// 질문 한 번 하고 출제자가 답한다
function qa(r, text = '먹는 건가요?', kind = 'yes') {
  r.ask(asker(r), text);
  r.answer(r.masterToken, kind);
}

// ── 게임 준비 ────────────────────────────────────────────────
test('준비한 사람이 4명 미만이면 시작할 수 없다', () => {
  const { r } = makeRoom(4, undefined, false);
  r.setReady('tok0', true); r.setReady('tok1', true); r.setReady('tok2', true);
  assert.strictEqual(r.readyCount(), 3);
  throwsMsg(() => r.start('tok0'), /4명 이상/);
  r.setReady('tok3', true);
  assert.strictEqual(r.readyCount(), 4);
  r.start('tok0');
  assert.strictEqual(r.phase, 'asking');
  r.dispose();
});

test('방장이 아니어도 누구든 시작할 수 있다', () => {
  const { r } = makeRoom(4);
  assert.notStrictEqual(r.hostToken, 'tok3');
  r.start('tok3');
  assert.strictEqual(r.phase, 'asking');
  r.dispose();
});

test('준비를 안 누른 사람은 시작 인원에 포함되지 않고 관전자가 된다', () => {
  const { r } = makeRoom(5, undefined, false);
  ['tok0', 'tok1', 'tok2', 'tok3'].forEach((t) => r.setReady(t, true));
  r.start('tok4');
  assert.strictEqual(roleOf(r, 'tok4'), 'spectator');
  assert.strictEqual(r.actives().length, 4);
  assert.notStrictEqual(r.masterToken, 'tok4');
  assert.notStrictEqual(r.insiderToken, 'tok4');
  r.dispose();
});

test('준비 취소하면 다시 인원 부족, 접속 끊긴 사람은 준비 인원에서 빠진다', () => {
  const { r } = makeRoom(4);
  r.setReady('tok0', false);
  throwsMsg(() => r.start('tok1'), /4명 이상/);
  r.setReady('tok0', true);
  r.setConnected('tok1', false);
  assert.strictEqual(r.readyCount(), 3);
  throwsMsg(() => r.start('tok0'), /4명 이상/);
});

test('준비한 사람이 9명 이상이면 시작 불가', () => {
  const { r } = makeRoom(9);
  throwsMsg(() => r.start('tok0'), /최대 8명/);
});

test('라운드 중에는 준비를 바꿀 수 없고, 참가자의 준비는 다음 라운드까지 유지된다', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  throwsMsg(() => r.setReady('tok0', false), /끝난 뒤/);
  r.finish({ winner: 'none', reason: 'timeout' });
  assert.ok(toks.every((t) => r.view(t).me.ready));
  assert.strictEqual(r.view('tok0').readyCount, 4);
  r.start('tok2'); // 누구든 다음 라운드 시작
  assert.strictEqual(r.round, 2);
  r.dispose();
});

test('중복 이름은 번호가 붙는다', () => {
  const r = new Room('X');
  r.join('a', '민수'); r.join('b', '민수');
  assert.deepStrictEqual(r.view('a').players.map((p) => p.name), ['민수', '민수2']);
});

// ── 역할과 정보 분리 ─────────────────────────────────────────
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
  assert.strictEqual(r.view(c).result, null);
  r.dispose();
});

// ── 질문과 답변 (차례제) ─────────────────────────────────────
test('질문 순서에는 출제자를 뺀 참가자 전원이 한 번씩 들어 있다', () => {
  const { r, toks } = makeRoom(5);
  r.start('tok0');
  const order = r.view(r.masterToken).turn.order.map((o) => o.id);
  assert.strictEqual(order.length, 4);
  assert.strictEqual(new Set(order).size, 4);
  assert.ok(!order.includes(r.players.get(r.masterToken).id));
  r.dispose();
});

test('차례가 아닌 사람은 질문할 수 없고, 질문 후 답이 올 때까지 다음 질문도 불가', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const a = asker(r);
  const other = toks.find((t) => t !== a && t !== r.masterToken);
  throwsMsg(() => r.ask(other, '새치기'), /내 차례가 아니/);
  throwsMsg(() => r.ask(r.masterToken, '출제자 질문'), /출제자는/);
  r.ask(a, '살아 있나요?');
  throwsMsg(() => r.ask(a, '또 질문'), /기다려/);
  assert.strictEqual(r.view(a).turn.waiting, true);
  r.dispose();
});

test('출제자가 답하면 질문에 답이 붙고 다음 사람 차례가 된다', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const first = asker(r);
  throwsMsg(() => r.answer(r.masterToken, 'yes'), /답할 질문이 아직/);
  r.ask(first, '먹는 건가요?');
  throwsMsg(() => r.answer(first, 'yes'), /출제자만/);
  throwsMsg(() => r.answer(r.masterToken, 'maybe'), /알 수 없는/);
  r.answer(r.masterToken, 'no');
  const q = r.qa.find((m) => m.type === 'question');
  assert.deepStrictEqual(q.ans, { kind: 'no', text: '아니오' });
  assert.notStrictEqual(asker(r), first);
  assert.strictEqual(r.view(first).turn.waiting, false);
  r.dispose();
});

test('차례는 순서대로 한 바퀴 돌아 처음 사람에게 돌아온다', () => {
  const { r } = makeRoom(4);
  r.start('tok0');
  const seq = [];
  for (let i = 0; i < 6; i++) { seq.push(asker(r)); qa(r); }
  assert.deepStrictEqual(seq.slice(0, 3), seq.slice(3, 6));
  assert.strictEqual(new Set(seq).size, 3);
  r.dispose();
});

test('패스하면 다음 사람에게 넘어가고, 내 차례가 아니면 패스 불가', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const a = asker(r);
  const other = toks.find((t) => t !== a && t !== r.masterToken);
  throwsMsg(() => r.pass(other), /내 차례에만/);
  r.pass(a);
  assert.notStrictEqual(asker(r), a);
  r.ask(asker(r), '질문');
  throwsMsg(() => r.pass(asker(r)), /이미 질문/);
  r.dispose();
});

test('접속이 끊긴 사람의 차례는 건너뛴다', () => {
  const { r } = makeRoom(4);
  r.start('tok0');
  const a = asker(r);
  r.setConnected(a, false);
  assert.notStrictEqual(asker(r), a);
  r.dispose();
});

test('차례제를 끄면 아무나 아무 때나 질문하고 출제자는 오래된 질문부터 답한다', () => {
  const { r, toks } = makeRoom(4, { turnBased: false });
  r.start('tok0');
  const qs = toks.filter((t) => t !== r.masterToken);
  r.ask(qs[0], '첫 질문');
  r.ask(qs[1], '둘째 질문');
  r.answer(r.masterToken, 'yes');
  const questions = r.qa.filter((m) => m.type === 'question');
  assert.strictEqual(questions[0].ans.kind, 'yes');
  assert.strictEqual(questions[1].ans, null);
  assert.strictEqual(r.view(qs[0]).turn.askerId, null);
  throwsMsg(() => r.pass(qs[0]), /차례제에서만/);
  r.dispose();
});

// ── 채널 분리 ────────────────────────────────────────────────
test('질문/답변은 qa 채널, 잡담은 chat 채널로 분리된다', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const a = asker(r);
  r.chatMsg(a, '잡담이에요');
  qa(r, '질문이에요');
  const v = r.view(a);
  assert.ok(v.chat.some((m) => m.type === 'chat' && m.text === '잡담이에요'));
  assert.ok(!v.chat.some((m) => m.type === 'question'));
  assert.ok(v.qa.some((m) => m.type === 'question' && m.text === '질문이에요'));
  assert.ok(!v.qa.some((m) => m.type === 'chat'));
  r.dispose();
});

test('출제자는 질문 시간에 잡담도 할 수 없고, 다른 단계에서는 가능', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  throwsMsg(() => r.chatMsg(r.masterToken, '힌트'), /버튼/);
  const c = find(r, toks, 'commoner');
  r.chatMsg(c, '잡담 가능');
  r.guess(c, r.word);
  r.judge(r.masterToken, r.qa.find((m) => m.type === 'guess').id, true);
  r.chatMsg(r.masterToken, '이제 말할 수 있다');
  r.dispose();
});

test('라운드가 시작되면 질문/답변 기록이 새로 시작된다', () => {
  const { r } = makeRoom(4);
  r.start('tok0'); qa(r, '지난 라운드 질문');
  r.finish({ winner: 'none', reason: 'timeout' });
  r.start('tok0');
  assert.ok(!r.qa.some((m) => m.text === '지난 라운드 질문'));
  r.dispose();
});

// ── 정답 시도 ────────────────────────────────────────────────
test('정답 시도: 출제자 본인/관전자 불가, 대기 중엔 중복 불가, 차례와 무관하게 가능', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  r.join('late', '지각생');
  const m = r.masterToken;
  const notMyTurn = toks.find((t) => t !== asker(r) && t !== m);
  throwsMsg(() => r.guess(m, '아무거나'), /출제자는/);
  throwsMsg(() => r.guess('late', '아무거나'), /관전/);
  r.guess(notMyTurn, '틀린답');
  throwsMsg(() => r.guess(notMyTurn, '또'), /기다려/);
  const g = r.qa.find((x) => x.type === 'guess');
  throwsMsg(() => r.judge(notMyTurn, g.id, true), /출제자만/);
  r.judge(m, g.id, false);
  assert.strictEqual(g.status, 'wrong');
  r.guess(notMyTurn, '두번째');
  r.dispose();
});

test('정답이면 토론 단계로, 제시어가 모두에게 공개되고 대기 질문은 비워진다', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const c = find(r, toks, 'commoner');
  r.ask(asker(r), '질문');
  r.guess(c, r.word);
  r.judge(r.masterToken, r.qa.find((x) => x.type === 'guess').id, true);
  assert.strictEqual(r.phase, 'discussion');
  assert.strictEqual(r.view(c).me.word, r.word);
  assert.strictEqual(r.view(c).guessedBy, r.players.get(c).name);
  assert.strictEqual(r.view(c).turn, null);
  r.dispose();
});

// ── 토론과 투표 ──────────────────────────────────────────────
function toVote(r, toks) {
  const c = find(r, toks, 'commoner');
  r.guess(c, r.word);
  r.judge(r.masterToken, r.qa.find((x) => x.type === 'guess' && x.status === 'pending').id, true);
  toks.forEach((t) => r.skipDiscuss(t));
  assert.strictEqual(r.phase, 'vote');
}

test('전원이 넘기기를 누르면 투표로 이동', () => {
  const { r, toks } = makeRoom(4);
  r.start('tok0');
  const c = find(r, toks, 'commoner');
  r.guess(c, r.word);
  r.judge(r.masterToken, r.qa.find((x) => x.type === 'guess').id, true);
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
    if (t === ins) r.castVote(t, r.players.get(toks.find((x) => x !== ins)).id);
    else r.castVote(t, insId);
  });
  assert.strictEqual(r.phase, 'result');
  assert.strictEqual(r.result.winner, 'crew');
  assert.strictEqual(r.players.get(ins).score, 0);
  toks.filter((t) => t !== ins).forEach((t) => assert.strictEqual(r.players.get(t).score, 1));
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

// ── 방 운영 ──────────────────────────────────────────────────
test('방장이 나가면 다음 접속자에게 방장이 넘어간다', () => {
  const { r } = makeRoom(4);
  r.setConnected('tok0', false);
  r.ensureHost();
  assert.strictEqual(r.hostToken, 'tok1');
});

test('다음 라운드: 출제자가 돌아가며, 지각생은 준비하면 참가자가 된다', () => {
  const { r } = makeRoom(4);
  r.start('tok0');
  const firstMaster = r.masterToken;
  r.join('late', '지각생');
  assert.strictEqual(roleOf(r, 'late'), 'spectator');
  r.finish({ winner: 'none', reason: 'timeout' });
  r.setReady('late', true);
  assert.strictEqual(r.readyCount(), 5);
  r.start('late');
  assert.notStrictEqual(r.masterToken, firstMaster);
  assert.notStrictEqual(roleOf(r, 'late'), 'spectator');
  assert.strictEqual(r.round, 2);
  r.dispose();
});

test('4라운드 동안 모든 사람이 한 번씩 출제자를 맡는다', () => {
  const { r } = makeRoom(4);
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

test('방장 중단: 로비로 돌아가고 점수와 준비 상태는 유지', () => {
  const { r } = makeRoom(4);
  r.start('tok0');
  throwsMsg(() => r.cancel('tok1'), /방장만/);
  r.cancel('tok0');
  assert.strictEqual(r.phase, 'lobby');
  assert.strictEqual(r.view('tok0').me.role, null);
  assert.strictEqual(r.readyCount(), 4);
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
  const c = find(r, toks, 'commoner');
  r.guess(c, r.word);
  r.judge(r.masterToken, r.qa.find((x) => x.type === 'guess').id, true);
  await new Promise((res) => setTimeout(res, 70));
  assert.strictEqual(r.phase, 'vote');
  await new Promise((res) => setTimeout(res, 200));
  assert.strictEqual(r.phase, 'result');
  assert.strictEqual(r.result.winner, 'insider'); // 무투표는 인사이더 승리
});

runAll();
