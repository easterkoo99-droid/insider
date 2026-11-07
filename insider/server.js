'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room, makeCode, userError } = require('./insider');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 15000 });

const rooms = new Map(); // code -> Room

// 방 상태가 바뀔 때마다 접속 중인 모든 사람에게 "자기 시점"의 화면을 보낸다.
function broadcast(room) {
  room.ensureHost();
  for (const p of room.players.values()) {
    if (p.connected && p.sid) io.to(p.sid).emit('state', room.view(p.token));
  }
}

function newRoom() {
  const code = makeCode((c) => rooms.has(c));
  const room = new Room(code, broadcast);
  rooms.set(code, room);
  return room;
}

const validToken = (t) => typeof t === 'string' && t.length >= 8 && t.length <= 80;

function attach(socket, room, token, name) {
  const p = room.join(token, name);
  p.sid = socket.id;
  p.connected = true;
  socket.data.code = room.code;
  socket.data.token = token;
  broadcast(room);
}

function run(cb, fn) {
  try {
    const result = fn();
    if (typeof cb === 'function') cb(Object.assign({ ok: true }, result || {}));
  } catch (e) {
    if (!e.userMessage) console.error(e);
    if (typeof cb === 'function') cb({ ok: false, error: e.userMessage || '문제가 생겼어요. 다시 시도해 주세요.' });
  }
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('create', (d, cb) =>
    run(cb, () => {
      d = d || {};
      if (!validToken(d.token)) throw userError('잘못된 요청이에요.');
      const room = newRoom();
      try {
        attach(socket, room, d.token, d.name);
      } catch (e) {
        rooms.delete(room.code);
        room.dispose();
        throw e;
      }
      return { code: room.code };
    })
  );

  socket.on('join', (d, cb) =>
    run(cb, () => {
      d = d || {};
      if (!validToken(d.token)) throw userError('잘못된 요청이에요.');
      const room = rooms.get(String(d.code || '').trim().toUpperCase());
      if (!room) throw userError('없는 방이에요. 방 코드를 다시 확인해 주세요.');
      attach(socket, room, d.token, d.name);
      return { code: room.code };
    })
  );

  const actions = {
    start: (r, t) => r.start(t),
    cancel: (r, t) => r.cancel(t),
    chat: (r, t, d) => r.chatMsg(t, d.text),
    answer: (r, t, d) => r.answer(t, d.kind),
    guess: (r, t, d) => r.guess(t, d.text),
    judge: (r, t, d) => r.judge(t, d.id, d.correct === true),
    skipDiscuss: (r, t) => r.skipDiscuss(t),
    vote: (r, t, d) => r.castVote(t, d.target),
    kick: (r, t, d) => {
      const sid = r.kick(t, d.id);
      if (sid) io.to(sid).emit('kicked');
    },
    leave: (r, t) => {
      r.leave(t);
      socket.data = {};
    },
  };

  for (const [event, fn] of Object.entries(actions)) {
    socket.on(event, (d, cb) =>
      run(cb, () => {
        const { code, token } = socket.data || {};
        const room = rooms.get(code);
        if (!room || !room.players.has(token)) throw userError('방 정보를 찾을 수 없어요. 새로고침해 주세요.');
        fn(room, token, d || {});
        room.touch();
        broadcast(room);
      })
    );
  }

  socket.on('disconnect', () => {
    const { code, token } = socket.data || {};
    const room = rooms.get(code);
    const p = room && room.players.get(token);
    // 같은 사람이 새 탭/새로고침으로 다시 붙은 경우에는 건드리지 않는다.
    if (p && p.sid === socket.id) {
      room.setConnected(token, false);
      room.ensureHost();
      broadcast(room);
    }
  });
});

// 오래 비어 있는 방 정리 (무료 인스턴스 메모리 보호)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.connectedCount() === 0 && now - room.lastActivity > 30 * 60 * 1000) {
      room.dispose();
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`insider listening on :${PORT}`));
