'use strict';
/**
 * 인사이더 게임 로직 (소켓/HTTP 의존성 없음).
 * server.js 가 Room 을 만들고, 상태가 바뀔 때마다 onChange 로 알려 준다.
 */
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
// 제시어 (예/아니오 질문으로 좁혀 갈 수 있는 구체적인 명사 위주)
// 여기만 고치면 단어가 바뀐다.
// ─────────────────────────────────────────────────────────────
const WORDS = [
  // 음식
  '김치찌개', '떡볶이', '치킨', '라면', '피자', '초밥', '삼겹살', '짜장면', '아이스크림', '김밥',
  '햄버거', '순대', '붕어빵', '호떡', '마라탕', '냉면', '비빔밥', '샌드위치', '팝콘', '초콜릿',
  // 장소
  '놀이공원', '도서관', '편의점', '지하철', '목욕탕', '노래방', '영화관', '공항', '캠핑장', '수영장',
  '병원', '찜질방', '피시방', '동물원', '해수욕장', '헬스장',
  // 사물
  '우산', '냉장고', '선풍기', '안경', '칫솔', '리모컨', '에어컨', '이어폰', '보조배터리', '가위',
  '거울', '시계', '베개', '텀블러', '자전거', '캐리어', '전자레인지', '마우스', '키보드', '지갑',
  '열쇠', '라이터', '손톱깎이', '빨래건조대', '청소기',
  // 직업
  '소방관', '의사', '요리사', '경찰관', '선생님', '가수', '택배기사', '변호사', '파일럿', '개그맨',
  '마술사', '유튜버',
  // 동물
  '고양이', '펭귄', '코끼리', '카멜레온', '앵무새', '기린', '고래', '거북이', '토끼', '햄스터',
  // 상황과 행사
  '무지개', '눈사람', '태풍', '화산', '사막', '크리스마스', '생일파티', '소풍', '월드컵', '올림픽',
  '결혼식', '롤러코스터', '낙하산', '불꽃놀이', '캠프파이어', '첫눈', '방학', '월급날', '야근', '회식',
];

const CFG = {
  minPlayers: 4,
  maxPlayers: 8,
  maxRoomSize: 12, // 관전자 포함
  askMs: 5 * 60 * 1000,
  discussMs: 3 * 60 * 1000,
  voteMs: 60 * 1000,
  turnBased: true, // true: 한 명씩 차례대로 질문, false: 아무나 아무 때나 질문
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ANSWERS = { yes: '예', no: '아니오', idk: '모르겠음' };

function userError(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}

const clean = (s, n) =>
  String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

const pick = (arr) => arr[crypto.randomInt(arr.length)];

function makeCode(exists) {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!exists(c)) return c;
  }
  throw userError('방 코드를 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
}

class Room {
  constructor(code, onChange, cfg) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.cfg = Object.assign({}, CFG, cfg || {});
    this.players = new Map(); // token -> player
    this.hostToken = null;
    this.phase = 'lobby'; // lobby | asking | discussion | vote | result
    this.round = 0;
    this.chat = []; // 잡담 채널
    this.qa = []; // 질문과 답변 채널 (라운드마다 비움)
    this.msgSeq = 0;
    this.joinSeq = 0;
    this.usedWords = new Set();
    this.timer = null;
    this.endsAt = null;
    this.touch();
    this.resetRound();
  }

  // ── 내부 유틸 ──────────────────────────────────────────────
  touch() { this.lastActivity = Date.now(); }

  resetRound() {
    this.masterToken = null;
    this.insiderToken = null;
    this.word = null;
    this.guessedBy = null;
    this.skip = new Set();
    this.votes = new Map(); // voterToken -> targetId
    this.result = null;
    this.qOrder = []; // 질문 순서 (출제자 제외 참가자 token)
    this.turnIdx = 0;
    this.queue = []; // 출제자의 답을 기다리는 질문 id
  }

  byId(id) {
    for (const p of this.players.values()) if (p.id === id) return p;
    return null;
  }

  actives() { return [...this.players.values()].filter((p) => p.active); }
  connectedActives() { return this.actives().filter((p) => p.connected); }
  connectedCount() { return [...this.players.values()].filter((p) => p.connected).length; }

  push(msg, ch) {
    msg.id = ++this.msgSeq;
    msg.t = Date.now();
    const arr = ch === 'qa' ? this.qa : this.chat;
    arr.push(msg);
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    return msg;
  }
  // ch: 'talk'(기본) | 'qa' | 'both'
  sys(text, ch) {
    if (ch === 'both') {
      this.push({ type: 'sys', text }, 'talk');
      return this.push({ type: 'sys', text }, 'qa');
    }
    return this.push({ type: 'sys', text }, ch || 'talk');
  }

  setPhase(phase, ms) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.endsAt = ms ? Date.now() + ms : null;
    this.timer = ms ? setTimeout(() => this.onTimer(phase), ms) : null;
  }

  onTimer(phase) {
    if (this.phase !== phase) return;
    if (phase === 'asking') {
      this.finish({ winner: 'none', reason: 'timeout' });
    } else if (phase === 'discussion') {
      this.toVote();
    } else if (phase === 'vote') {
      this.resolveVote();
    }
    this.onChange(this);
  }

  ensureHost() {
    const host = this.players.get(this.hostToken);
    if (host && host.connected) return;
    for (const p of this.players.values()) {
      if (p.connected) { this.hostToken = p.token; return; }
    }
  }

  dispose() { clearTimeout(this.timer); this.timer = null; }

  // ── 입장과 퇴장 ─────────────────────────────────────────────
  join(token, rawName) {
    this.touch();
    let p = this.players.get(token);
    if (p) {
      p.connected = true;
      return p;
    }
    const base = clean(rawName, 10);
    if (!base) throw userError('이름을 입력해 주세요.');
    if (this.players.size >= this.cfg.maxRoomSize) throw userError('방이 가득 찼어요.');
    let name = base;
    let n = 2;
    const names = new Set([...this.players.values()].map((x) => x.name));
    while (names.has(name)) name = `${base}${n++}`;
    p = {
      token,
      id: crypto.randomBytes(4).toString('hex'),
      name,
      connected: true,
      active: this.phase === 'lobby' || this.phase === 'result',
      ready: false,
      score: 0,
      masterCount: 0,
      order: ++this.joinSeq,
      sid: null,
    };
    this.players.set(token, p);
    if (!this.hostToken) this.hostToken = token;
    this.sys(`${name}님이 들어왔어요.`);
    return p;
  }

  setConnected(token, connected) {
    const p = this.players.get(token);
    if (!p) return;
    p.connected = connected;
    if (!connected) p.sid = null;
    this.touch();
    this.afterPresenceChange();
  }

  // 접속이 끊긴 사람을 기다리다 막히지 않도록 진행 조건을 다시 확인한다.
  afterPresenceChange() {
    if (this.phase === 'asking') {
      this.normalizeTurn();
    } else if (this.phase === 'discussion') {
      const act = this.connectedActives();
      if (act.length && act.every((p) => this.skip.has(p.token))) this.toVote();
    } else if (this.phase === 'vote') {
      const act = this.connectedActives();
      if (act.length && act.every((p) => this.votes.has(p.token))) this.resolveVote();
    }
  }

  leave(token) {
    const p = this.players.get(token);
    if (!p) return;
    this.touch();
    if (this.phase === 'lobby' || this.phase === 'result') {
      this.players.delete(token);
      this.sys(`${p.name}님이 나갔어요.`);
    } else {
      p.connected = false;
      p.sid = null;
      this.sys(`${p.name}님의 접속이 끊겼어요.`);
      this.afterPresenceChange();
    }
    this.ensureHost();
  }

  kick(token, targetId) {
    if (token !== this.hostToken) throw userError('방장만 내보낼 수 있어요.');
    if (this.phase !== 'lobby' && this.phase !== 'result') throw userError('라운드 중에는 내보낼 수 없어요.');
    const t = this.byId(targetId);
    if (!t || t.token === token) throw userError('내보낼 수 없는 대상이에요.');
    this.players.delete(t.token);
    this.sys(`${t.name}님이 방에서 나갔어요.`);
    return t.sid;
  }

  // ── 라운드 진행 ─────────────────────────────────────────────
  // ── 게임 준비 ───────────────────────────────────────────────
  setReady(token, flag) {
    const p = this.players.get(token);
    if (!p) return;
    if (this.phase !== 'lobby' && this.phase !== 'result') throw userError('라운드가 끝난 뒤에 준비할 수 있어요.');
    p.ready = !!flag;
    this.touch();
  }

  readyCount() {
    return [...this.players.values()].filter((p) => p.connected && p.ready).length;
  }

  // ── 라운드 진행 ─────────────────────────────────────────────
  // 준비를 누른 사람이 min명 이상이면 누구든 시작할 수 있다. 준비한 사람만 참가자가 된다.
  start(token) {
    if (!this.players.has(token)) throw userError('방 정보를 찾을 수 없어요.');
    if (this.phase !== 'lobby' && this.phase !== 'result') throw userError('이미 진행 중이에요.');
    const n = this.readyCount();
    if (n < this.cfg.minPlayers) throw userError(`게임 준비를 누른 사람이 ${this.cfg.minPlayers}명 이상이어야 해요.`);
    if (n > this.cfg.maxPlayers) {
      throw userError(`최대 ${this.cfg.maxPlayers}명까지 할 수 있어요. 일부는 준비를 취소해 주세요.`);
    }
    for (const p of this.players.values()) p.active = p.connected && p.ready;

    const actives = this.actives();
    // 출제자는 맡은 횟수가 적은 사람부터 (동률이면 먼저 들어온 사람)
    const master = [...actives].sort((a, b) => a.masterCount - b.masterCount || a.order - b.order)[0];
    const insider = pick(actives.filter((p) => p !== master));

    if (this.usedWords.size >= WORDS.length) this.usedWords.clear();
    const word = pick(WORDS.filter((w) => !this.usedWords.has(w)));
    this.usedWords.add(word);

    this.resetRound();
    this.qa = [];
    this.round += 1;
    master.masterCount += 1;
    this.masterToken = master.token;
    this.insiderToken = insider.token;
    this.word = word;

    // 질문 순서는 무작위로 섞는다 (인사이더가 항상 같은 순번이 되지 않도록)
    const askers = actives.filter((p) => p !== master).map((p) => p.token);
    for (let i = askers.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [askers[i], askers[j]] = [askers[j], askers[i]];
    }
    this.qOrder = askers;
    this.turnIdx = 0;

    this.setPhase('asking', this.cfg.askMs);
    this.normalizeTurn();
    this.sys(`${this.round}번째 라운드를 시작해요. 출제자는 ${master.name}님이에요.`, 'both');
    this.touch();
  }

  cancel(token) {
    if (token !== this.hostToken) throw userError('방장만 중단할 수 있어요.');
    if (this.phase === 'lobby') return;
    clearTimeout(this.timer);
    this.timer = null;
    this.resetRound();
    this.phase = 'lobby';
    this.endsAt = null;
    for (const p of this.players.values()) p.active = true;
    this.sys('방장이 라운드를 중단했어요.');
    this.touch();
  }

  chatMsg(token, rawText) {
    const p = this.players.get(token);
    if (!p) return;
    const text = clean(rawText, 200);
    if (!text) return;
    if (this.phase === 'asking' && token === this.masterToken) {
      throw userError('출제자는 예, 아니오, 모르겠음 버튼으로만 답할 수 있어요.');
    }
    const spectating = ['asking', 'discussion', 'vote'].includes(this.phase) && !p.active;
    this.push({ type: 'chat', pid: p.id, name: p.name, text, spec: spectating }, 'talk');
    this.touch();
  }

  // 차례 계산: 접속이 끊긴 사람은 건너뛴다 (답을 기다리는 질문이 있으면 건드리지 않는다)
  normalizeTurn() {
    if (!this.cfg.turnBased || this.phase !== 'asking' || this.queue.length) return;
    const n = this.qOrder.length;
    for (let i = 0; i < n; i++) {
      const p = this.players.get(this.qOrder[this.turnIdx]);
      if (p && p.connected) return;
      this.turnIdx = (this.turnIdx + 1) % n;
    }
  }

  advanceTurn() {
    if (!this.cfg.turnBased || !this.qOrder.length) return;
    this.turnIdx = (this.turnIdx + 1) % this.qOrder.length;
    this.normalizeTurn();
  }

  currentAsker() {
    return this.cfg.turnBased ? this.players.get(this.qOrder[this.turnIdx]) || null : null;
  }

  ask(token, rawText) {
    if (this.phase !== 'asking') throw userError('지금은 질문할 수 없어요.');
    const p = this.players.get(token);
    if (!p || !p.active) throw userError('관전 중에는 질문할 수 없어요.');
    if (token === this.masterToken) throw userError('출제자는 질문할 수 없어요.');
    const text = clean(rawText, 120);
    if (!text) return;
    if (this.cfg.turnBased) {
      this.normalizeTurn();
      if (this.qOrder[this.turnIdx] !== token) throw userError('아직 내 차례가 아니에요.');
      if (this.queue.length) throw userError('출제자가 답할 때까지 기다려 주세요.');
    } else if (this.queue.length >= 10) {
      throw userError('답을 기다리는 질문이 너무 많아요.');
    }
    const m = this.push({ type: 'question', pid: p.id, name: p.name, text, ans: null }, 'qa');
    this.queue.push(m.id);
    this.touch();
  }

  pass(token) {
    if (this.phase !== 'asking') throw userError('지금은 패스할 수 없어요.');
    if (!this.cfg.turnBased) throw userError('패스는 차례제에서만 쓸 수 있어요.');
    this.normalizeTurn();
    if (this.qOrder[this.turnIdx] !== token) throw userError('내 차례에만 패스할 수 있어요.');
    if (this.queue.length) throw userError('이미 질문을 보냈어요.');
    const p = this.players.get(token);
    this.sys(`${p.name}님이 패스했어요.`, 'qa');
    this.advanceTurn();
    this.touch();
  }

  answer(token, kind) {
    if (this.phase !== 'asking') throw userError('지금은 답할 수 없어요.');
    if (token !== this.masterToken) throw userError('출제자만 답할 수 있어요.');
    if (!ANSWERS[kind]) throw userError('알 수 없는 답이에요.');
    if (!this.queue.length) throw userError('답할 질문이 아직 없어요.');
    const qid = this.queue.shift();
    const q = this.qa.find((x) => x.id === qid);
    if (q) q.ans = { kind, text: ANSWERS[kind] };
    this.advanceTurn();
    this.touch();
  }

  guess(token, rawText) {
    if (this.phase !== 'asking') throw userError('지금은 정답을 말할 수 없어요.');
    const p = this.players.get(token);
    if (!p || !p.active) throw userError('관전 중에는 참여할 수 없어요.');
    if (token === this.masterToken) throw userError('출제자는 정답을 말할 수 없어요.');
    const text = clean(rawText, 20);
    if (!text) return;
    if (this.qa.some((m) => m.type === 'guess' && m.pid === p.id && m.status === 'pending')) {
      throw userError('이전 정답 시도를 출제자가 판정할 때까지 기다려 주세요.');
    }
    this.push({ type: 'guess', pid: p.id, name: p.name, text, status: 'pending' }, 'qa');
    this.touch();
  }

  judge(token, msgId, correct) {
    if (this.phase !== 'asking') throw userError('지금은 판정할 수 없어요.');
    if (token !== this.masterToken) throw userError('출제자만 판정할 수 있어요.');
    const m = this.qa.find((x) => x.id === msgId && x.type === 'guess');
    if (!m || m.status !== 'pending') throw userError('판정할 정답 시도가 없어요.');
    if (!correct) {
      m.status = 'wrong';
      this.touch();
      return;
    }
    m.status = 'correct';
    for (const x of this.qa) if (x.type === 'guess' && x.status === 'pending') x.status = 'void';
    this.queue = [];
    this.guessedBy = m.name;
    this.sys(`정답이에요. ${m.name}님이 맞혔어요. 이제 인사이더를 찾아 보세요.`, 'both');
    this.setPhase('discussion', this.cfg.discussMs);
    this.touch();
  }

  skipDiscuss(token) {
    if (this.phase !== 'discussion') throw userError('지금은 투표로 넘어갈 수 없어요.');
    const p = this.players.get(token);
    if (!p || !p.active) throw userError('관전 중에는 참여할 수 없어요.');
    this.skip.add(token);
    this.touch();
    this.afterPresenceChange();
  }

  toVote() {
    this.votes = new Map();
    this.setPhase('vote', this.cfg.voteMs);
    this.sys('투표 시간이에요. 인사이더로 의심되는 사람을 골라 주세요.');
  }

  castVote(token, targetId) {
    if (this.phase !== 'vote') throw userError('지금은 투표할 수 없어요.');
    const p = this.players.get(token);
    if (!p || !p.active) throw userError('관전 중에는 투표할 수 없어요.');
    const t = this.byId(targetId);
    if (!t || !t.active) throw userError('투표할 수 없는 대상이에요.');
    if (t.token === token) throw userError('자기 자신에게는 투표할 수 없어요.');
    this.votes.set(token, t.id);
    this.touch();
    this.afterPresenceChange();
  }

  resolveVote() {
    const tally = new Map();
    for (const id of this.votes.values()) tally.set(id, (tally.get(id) || 0) + 1);
    const max = Math.max(0, ...tally.values());
    const leaders = [...tally].filter(([, n]) => n === max).map(([id]) => id);
    const insider = this.players.get(this.insiderToken);
    const caught = max > 0 && leaders.length === 1 && leaders[0] === insider.id;
    this.finish({ winner: caught ? 'crew' : 'insider', reason: caught ? 'caught' : (leaders.length > 1 || max === 0 ? 'tie' : 'missed') });
  }

  finish({ winner, reason }) {
    const insider = this.players.get(this.insiderToken);
    const master = this.players.get(this.masterToken);
    const votes = [...this.votes].map(([voter, targetId]) => ({
      from: this.players.get(voter) ? this.players.get(voter).name : '?',
      to: this.byId(targetId) ? this.byId(targetId).name : '?',
    }));
    const tally = {};
    for (const v of votes) tally[v.to] = (tally[v.to] || 0) + 1;

    if (winner === 'insider') {
      insider.score += 2;
    } else if (winner === 'crew') {
      for (const p of this.actives()) if (p.token !== insider.token) p.score += 1;
    }

    this.result = {
      winner, // 'insider' | 'crew' | 'none'
      reason, // 'caught' | 'missed' | 'tie' | 'timeout'
      insiderId: insider.id,
      insiderName: insider.name,
      masterName: master.name,
      guessedBy: this.guessedBy,
      word: this.word,
      votes,
      tally,
    };
    this.setPhase('result', 0);
    const msg = {
      crew: `인사이더 ${insider.name}님을 찾아냈어요.`,
      insider: `인사이더 ${insider.name}님의 승리예요.`,
      none: `시간이 끝났어요. 인사이더는 ${insider.name}님이었어요.`,
    }[winner];
    this.sys(msg, 'both');
  }

  turnView() {
    const asker = this.currentAsker();
    return {
      turnBased: this.cfg.turnBased,
      askerId: asker ? asker.id : null,
      order: this.cfg.turnBased
        ? this.qOrder.map((t) => this.players.get(t)).filter(Boolean).map((p) => ({ id: p.id, name: p.name }))
        : [],
      waiting: this.queue.length > 0,
    };
  }

  // ── 플레이어별 화면 상태 ─────────────────────────────────────
  view(token) {
    const me = this.players.get(token);
    const inRound = this.phase !== 'lobby';
    let role = null;
    if (me && inRound) {
      if (!me.active) role = 'spectator';
      else if (token === this.masterToken) role = 'master';
      else if (token === this.insiderToken) role = 'insider';
      else role = 'commoner';
    }
    const wordPublic = ['discussion', 'vote', 'result'].includes(this.phase);
    const canSeeWord = wordPublic || role === 'master' || role === 'insider';

    const online = [...this.players.values()].filter((p) => p.connected).length;

    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      cfg: { min: this.cfg.minPlayers, max: this.cfg.maxPlayers },
      online,
      readyCount: this.readyCount(),
      me: {
        id: me ? me.id : null,
        name: me ? me.name : '',
        role,
        isHost: token === this.hostToken,
        ready: !!(me && me.ready),
        word: canSeeWord ? this.word : null,
        myVote: this.phase === 'vote' && this.votes.has(token) ? this.votes.get(token) : null,
        skipped: this.phase === 'discussion' && this.skip.has(token),
      },
      players: [...this.players.values()]
        .sort((a, b) => a.order - b.order)
        .map((p) => ({
          id: p.id,
          name: p.name,
          connected: p.connected,
          active: p.active,
          ready: p.ready,
          score: p.score,
          isHost: p.token === this.hostToken,
          isMaster: inRound && p.token === this.masterToken,
          voted: this.phase === 'vote' && this.votes.has(p.token),
          skipped: this.phase === 'discussion' && this.skip.has(p.token),
        })),
      guessedBy: this.guessedBy,
      result: this.phase === 'result' ? this.result : null,
      turn: this.phase === 'asking' ? this.turnView() : null,
      qa: this.qa.slice(-80),
      chat: this.chat.slice(-120),
    };
  }
}

module.exports = { Room, makeCode, userError, WORDS, CFG };
