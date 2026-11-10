// TRAITOR v3 — online social-deduction game. Single file, zero dependencies.
// Run: node traitor-single.js   (PORT env optional)  → http://localhost:3000
const http = require('http'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = '7908979021';           // only this number can create games
const MIN_PLAYERS = 4;
const T = { round1: 300, circle: 180, reveal: 12, night: 90, dawn: 12 }; // default seconds (admin can change in lobby)
const rooms = {};

const rnd = n => crypto.randomInt(n);
const uid = () => crypto.randomBytes(8).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const newCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 5; i++) s += c[rnd(c.length)]; } while (rooms[s]); return s; };
const traitorsFor = n => (n > 12 ? 3 : n > 7 ? 2 : 1);   // 4-7 → 1, 8-12 → 2, 13+ → 3
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10);
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 16);
const alive = r => r.players.filter(p => p.alive);
const find = (r, id) => r.players.find(p => p.id === id);
const locked = r => r.deadline && Date.now() >= r.deadline;
const VOTE_PHASES = ['round1', 'circle', 'night'];

function say(room, text, title, kind) { room.event = { id: room.event.id + 1, text, title: title || '', kind: kind || 'info' }; }
function addPlayer(room, name, phone) {
  const p = { id: uid(), token: uid(), phone, name, role: 'innocent', alive: true, vote: null, res: null };
  room.players.push(p); return p;
}

// ---------- state view (per player, hides secrets) ----------
function view(room, me) {
  const ph = room.phase, lobby = ph === 'lobby', over = ph === 'over', started = !lobby, isT = started && me.role === 'traitor';
  const al = alive(room), tl = al.filter(p => p.role === 'traitor').length;
  const voting = ph === 'round1' || ph === 'circle';
  let vs = null, waiting = null;
  if (voting) { vs = { voted: al.filter(p => p.vote).length, total: al.length }; waiting = al.filter(p => !p.vote).map(p => p.name); }
  else if (ph === 'night' && isT) {
    const ts = al.filter(p => p.role === 'traitor');
    vs = { voted: ts.filter(p => p.vote).length, total: ts.length }; waiting = ts.filter(p => !p.vote).map(p => p.name);
  }
  const team = isT && (voting || ph === 'night') ? al.filter(p => p.role === 'traitor' && p.vote).map(p => ({ voter: p.name, target: p.vote })) : null;
  return {
    now: Date.now(), code: room.code, phase: ph, stage: room.stage, final: !!room.final, circleNo: room.circleNo, gameNo: room.gameNo,
    deadline: room.deadline, dur: room.dur, early: !!room.deadline && room.deadline !== room.fullDeadline,
    winner: room.winner, minPlayers: MIN_PLAYERS,
    times: { round1: room.T.round1, circle: room.T.circle, night: room.T.night },
    me: { id: me.id, name: me.name, role: started ? me.role : null, admin: me.id === room.adminId, alive: me.alive, vote: me.vote },
    players: room.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive,
      role: started && (over || !p.alive || p.id === me.id || (isT && p.role === 'traitor')) ? p.role : null
    })),
    counts: { alive: al.length, traitorsLeft: tl, totalTraitors: room.totalTraitors, total: room.players.length },
    candidates: room.candidates, voteStat: vs, waiting, team,
    chat: room.chat.filter(m => m.ch === 'all' || (m.ch === 'traitor' && isT)),
    result: room.result, tally: room.tally, log: room.log, event: room.event
  };
}
function push(room) {
  for (const p of room.players) if (p.res) p.res.write('data: ' + JSON.stringify(view(room, p)) + '\n\n');
}

// ---------- game flow ----------
function schedule(room) {
  clearTimeout(room.timer);
  if (room.deadline) room.timer = setTimeout(() => advance(room), Math.max(0, room.deadline - Date.now()));
}
// When every voter has voted, the timer shortens to 15s (changing a vote is still allowed); if someone undoes, the full timer returns.
function sync(room) {
  const ph = room.phase;
  if (VOTE_PHASES.includes(ph) && room.fullDeadline) {
    const voters = ph === 'night' ? alive(room).filter(p => p.role === 'traitor') : alive(room);
    const all = voters.length > 0 && voters.every(p => p.vote);
    const want = all ? Math.min(room.fullDeadline, Date.now() + 15000) : room.fullDeadline;
    if (want !== room.deadline) { room.deadline = want; schedule(room); }
  }
  push(room);
}
function go(room, phase) {
  clearTimeout(room.timer);
  room.phase = phase;
  let dur = room.T[phase] || 0;
  if (phase === 'circle' && room.candidates) dur = Math.max(30, Math.round(room.T.circle / 2)); // revote is shorter
  room.dur = dur;
  room.fullDeadline = dur ? Date.now() + dur * 1000 : 0;
  room.deadline = room.fullDeadline;
  if (VOTE_PHASES.includes(phase)) {
    room.stage = phase; room.final = false; room.players.forEach(p => { p.vote = null; }); room.tally = null; room.result = null;
  }
  if (phase === 'circle') {
    if (room.candidates) {
      const names = room.candidates.map(id => find(room, id).name).join(' and ');
      say(room, 'Revote! The circle must choose between ' + names + '.', 'REVOTE', 'info');
    } else {
      room.circleNo++; room.final = killPointless(room);
      if (room.final) say(room, 'The final Circle of Doubt. Catch the traitor, or the traitors win.', 'FINAL CIRCLE', 'info');
      else say(room, 'The Circle of Doubt begins. Vote for who you think is a traitor.', 'CIRCLE OF DOUBT', 'info');
    }
  }
  if (phase === 'night') say(room, 'Night falls. Everyone, close your eyes.', 'KILLING ROUND', 'info');
  schedule(room);
  push(room);
}
function win(room) {
  const a = alive(room), t = a.filter(p => p.role === 'traitor').length;
  if (!t) return 'innocents';
  if (t >= a.length - t) return 'traitors';
  return null;
}
// A traitor kill is pointless when it would instantly hand the traitors the win → go straight to a decisive final circle.
function killPointless(room) {
  const a = alive(room), t = a.filter(p => p.role === 'traitor').length;
  return (a.length - t) - 1 <= t;
}
function end(room, w) {
  clearTimeout(room.timer);
  room.winner = w; room.phase = 'over'; room.deadline = 0; room.fullDeadline = 0; room.dur = 0; room.candidates = null;
  const txt = w === 'traitors' ? 'The traitors win! The innocents are outnumbered.' : 'The innocents win! Every traitor has been found.';
  say(room, txt, w === 'traitors' ? 'TRAITORS WIN' : 'INNOCENTS WIN', w === 'traitors' ? 'bad' : 'good');
  room.log.push('🏁 ' + txt);
  push(room);
}
function top(counts) {
  let max = 0, ids = [];
  for (const [id, c] of Object.entries(counts)) { if (c > max) { max = c; ids = [id]; } else if (c === max) ids.push(id); }
  return { max, ids };
}
function advance(room) {
  const ph = room.phase;
  if (ph === 'round1') {
    // Round 1: only the traitors' votes count, so nobody can tell who the real traitors are.
    const a = alive(room), counts = {};
    a.filter(p => p.role === 'traitor' && p.vote).forEach(p => { counts[p.vote] = (counts[p.vote] || 0) + 1; });
    const { ids } = top(counts), nonT = a.filter(p => p.role !== 'traitor');
    const v = find(room, ids.length ? ids[rnd(ids.length)] : nonT[rnd(nonT.length)].id);
    v.alive = false; room.tally = null;
    room.result = v.name + ' has been voted out of the circle. They were innocent.';
    say(room, v.name + ' has been voted out of the circle. ' + v.name + ' was innocent.', 'VOTED OUT', 'bad');
    room.log.push('Round 1 — ' + room.result);
    return go(room, 'reveal');
  }
  if (ph === 'circle') {
    const voters = alive(room), counts = {}, abst = [];
    voters.forEach(p => { if (p.vote) counts[p.vote] = (counts[p.vote] || 0) + 1; else abst.push(p.name); });
    const rows = Object.entries(counts).map(([id, c]) => ({ name: find(room, id).name, count: c })).sort((x, y) => y.count - x.count);
    room.tally = { rows, counted: voters.length - abst.length, total: voters.length, abstained: abst, tie: null, fate: false };
    let { max, ids } = top(counts);
    const lab = (room.candidates ? 'Revote' : room.final ? 'Final circle' : 'Circle #' + room.circleNo) + ' — ';
    if (max && ids.length > 1) {
      if (room.runoffs < 2) {                       // tie → revote between the tied players
        room.runoffs++; room.candidates = ids; room.revote = true;
        const names = ids.map(id => find(room, id).name);
        room.tally.tie = names;
        room.result = 'Tie between ' + names.join(' & ') + ' — the circle must vote again!';
        say(room, 'A tie between ' + names.join(' and ') + '. The circle must vote again.', 'TIE — REVOTE', 'info');
        room.log.push(lab + room.result);
        return go(room, 'reveal');
      }
      ids = [ids[rnd(ids.length)]]; room.tally.fate = true; // still tied after two revotes: fate decides
    }
    room.candidates = null; room.runoffs = 0; room.revote = false;
    if (!max) {
      room.result = 'Nobody voted. Nobody is banished.';
      say(room, room.result, 'NO VOTES', 'info');
    } else {
      const v = find(room, ids[0]); v.alive = false;
      const fate = room.tally.fate ? ' (still tied after two revotes — fate decided)' : '';
      if (v.role === 'traitor') {
        room.result = v.name + ' was banished — and they WERE a traitor!' + fate;
        say(room, v.name + ' has been banished. And ' + v.name + ' was a traitor! The circle got it right.', 'TRAITOR CAUGHT', 'good');
      } else {
        room.result = v.name + ' was banished — but they were innocent. An innocent is lost.' + fate;
        say(room, v.name + ' has been banished. ' + v.name + ' was innocent. An innocent is lost.', 'WRONG GUESS', 'bad');
      }
    }
    room.log.push(lab + room.result);
    return go(room, 'reveal');
  }
  if (ph === 'reveal') {
    if (room.revote) { room.revote = false; return go(room, 'circle'); }
    const w = win(room);
    if (w) return end(room, w);
    if (room.stage !== 'round1' && killPointless(room)) room.log.push('⚖️ Too few players left for a killing round — straight to the Final Circle of Doubt!');
    return go(room, room.stage === 'round1' || killPointless(room) ? 'circle' : 'night');
  }
  if (ph === 'night') {
    const counts = {};
    alive(room).filter(p => p.role === 'traitor' && p.vote).forEach(p => { counts[p.vote] = (counts[p.vote] || 0) + 1; });
    const { max, ids } = top(counts);
    if (!max) {
      room.result = 'The traitors stayed silent. Nobody was killed.';
      say(room, 'The night passes quietly. Nobody was killed.', 'A QUIET NIGHT', 'info');
    } else {
      const v = find(room, ids[rnd(ids.length)]); v.alive = false;
      room.result = v.name + ' was murdered in the night. They were innocent.';
      say(room, v.name + ' was killed by the traitors in the night.', 'MURDERED', 'bad');
    }
    room.log.push('Night — ' + room.result);
    return go(room, 'dawn');
  }
  if (ph === 'dawn') {
    const w = win(room);
    return w ? end(room, w) : go(room, 'circle');
  }
}

function act(room, me, b) {
  const a = b.type, ph = room.phase, inGame = ph !== 'lobby' && ph !== 'over';
  const tgt = b.target ? find(room, b.target) : null;
  if (a === 'start') {
    if (me.id !== room.adminId || ph !== 'lobby') return 'Not allowed';
    if (room.players.length < MIN_PLAYERS) return 'Need at least ' + MIN_PLAYERS + ' players';
    const ps = shuffle(room.players.slice()), nT = traitorsFor(ps.length);
    room.players.forEach(p => { p.role = 'innocent'; p.alive = true; p.vote = null; });
    // Fair + unpredictable: crypto-random weighted pick. Everyone (admin included) can be traitor;
    // players who have been traitor less often in earlier games get a higher chance.
    const pool = ps.slice();
    for (let k = 0; k < nT; k++) {
      const mx = Math.max(...pool.map(p => p.tc || 0));
      const w = pool.map(p => 2 + (mx - (p.tc || 0)) * 2);
      let r = rnd(w.reduce((x, y) => x + y, 0)), i = 0;
      while (r >= w[i]) { r -= w[i]; i++; }
      const pick = pool.splice(i, 1)[0]; pick.role = 'traitor'; pick.tc = (pick.tc || 0) + 1;
    }
    room.totalTraitors = nT; room.gameNo++; room.circleNo = 0; room.winner = null; room.candidates = null; room.runoffs = 0; room.revote = false;
    room.chat = []; room.audios = {}; room.log = ['🎲 Game started: ' + ps.length + ' players, ' + nT + ' traitor' + (nT > 1 ? 's' : '') + ' hiding among them.'];
    say(room, 'The game begins. ' + ps.length + ' players. ' + nT + (nT > 1 ? ' traitors hide' : ' traitor hides') + ' among you.', 'GAME START', 'info');
    return go(room, 'round1');
  }
  if (a === 'chat') {
    const ch = b.ch === 'traitor' ? 'traitor' : 'all';
    if (ch === 'traitor') { if (!inGame || me.role !== 'traitor' || !me.alive) return 'Secret chat is for living traitors'; }
    else if (inGame) {
      if (!me.alive) return 'You are out — you can watch but not chat';
      if (ph === 'night') return 'Everyone sleeps during the killing round';
    }
    let aid = null;
    const text = String(b.text || '').trim().slice(0, 300);
    if (b.audio) {
      const buf = Buffer.from(String(b.audio), 'base64');
      if (!buf.length || buf.length > 700000) return 'Voice message too long';
      aid = uid();
      room.audios[aid] = { buf, mime: /^audio\/(webm|mp4|ogg|mpeg|aac|x-m4a)/.test(b.mime) ? b.mime : 'audio/webm', ch };
    } else if (!text) return 'Empty message';
    room.chat.push({ id: ++room.seq, ch, name: me.name, text: aid ? '' : text, audio: aid, dur: aid ? Math.min(+b.dur || 0, 60) : 0, t: Date.now() });
    while (room.chat.length > 150) { const o = room.chat.shift(); if (o.audio) delete room.audios[o.audio]; }
    return push(room);
  }
  if (a === 'vote') {
    if ((ph !== 'round1' && ph !== 'circle') || !me.alive) return 'Voting is closed';
    if (locked(room)) return 'Time is up — votes are locked';
    if (!tgt) { me.vote = null; return sync(room); }
    if (!tgt.alive || tgt.id === me.id) return 'Invalid vote';
    if (ph === 'round1' && me.role === 'traitor' && tgt.role === 'traitor') return 'Pick someone who is not a traitor';
    if (ph === 'circle' && room.candidates && !room.candidates.includes(tgt.id)) return 'Revote: pick one of the tied players';
    me.vote = tgt.id; return sync(room);
  }
  if (a === 'kill') {
    if (ph !== 'night' || !me.alive || me.role !== 'traitor') return 'Not allowed';
    if (locked(room)) return 'Time is up — votes are locked';
    if (!tgt) { me.vote = null; return sync(room); }
    if (!tgt.alive || tgt.role === 'traitor') return 'Invalid target';
    me.vote = tgt.id; return sync(room);
  }
  if (a === 'settime') {
    if (me.id !== room.adminId || ph !== 'lobby') return 'Not allowed';
    for (const k of ['round1', 'circle', 'night']) { const v = Math.round(+b[k]); if (v) room.T[k] = Math.min(1800, Math.max(30, v)); }
    return push(room);
  }
  if (a === 'extend') {
    if (me.id !== room.adminId || !VOTE_PHASES.includes(ph) || !room.deadline) return 'Not allowed';
    room.fullDeadline += 60000; room.dur += 60; room.deadline = room.fullDeadline;
    return sync(room);
  }
  if (a === 'skip') {
    if (me.id !== room.adminId || !T[ph]) return 'Not allowed';
    return advance(room);
  }
  if (a === 'restart') {
    if (me.id !== room.adminId || ph !== 'over') return 'Not allowed';
    room.players.forEach(p => { p.role = 'innocent'; p.alive = true; p.vote = null; });
    room.chat = []; room.audios = {}; room.log = []; room.winner = null; room.result = null; room.tally = null;
    room.totalTraitors = 0; room.stage = null; room.final = false; room.candidates = null; room.runoffs = 0; room.revote = false;
    return go(room, 'lobby');
  }
  return 'Unknown action';
}

// ---------- accounts / sessions (phone number = identity) ----------
function findMember(phone) {
  for (const r of Object.values(rooms)) { const p = r.players.find(x => x.phone === phone); if (p) return { room: r, p }; }
  return null;
}
const session = (room, p) => ({ code: room.code, token: p.token, name: p.name, admin: p.id === room.adminId });
function destroy(room) { clearTimeout(room.timer); for (const p of room.players) if (p.res) { try { p.res.end(); } catch (e) {} } delete rooms[room.code]; }
function leaveRoom(room, p) {
  if (p.id === room.adminId) return destroy(room);
  room.players.splice(room.players.indexOf(p), 1); if (p.res) { try { p.res.end(); } catch (e) {} } push(room);
}
function login(b) {
  const phone = normPhone(b.phone), name = cleanName(b.name), code = String(b.code || '').toUpperCase().trim();
  if (phone.length !== 10) return [400, { error: 'Enter a valid 10-digit phone number' }];
  if (b.create) {
    if (phone !== ADMIN_PHONE) return [403, { error: 'Only the admin can create games' }];
    if (!name) return [400, { error: 'Enter your name' }];
    for (const r of Object.values(rooms)) { const p = r.players.find(x => x.phone === phone); if (p && p.id === r.adminId) destroy(r); else if (p) leaveRoom(r, p); }
    const room = {
      code: newCode(), phase: 'lobby', stage: null, final: false, circleNo: 0, gameNo: 0, totalTraitors: 0, T: { ...T },
      players: [], chat: [], audios: {}, seq: 0, log: [], deadline: 0, fullDeadline: 0, dur: 0, timer: null, adminId: null,
      candidates: null, runoffs: 0, revote: false, tally: null, result: null, winner: null,
      event: { id: 0, text: '', title: '', kind: 'info' }, last: Date.now()
    };
    rooms[room.code] = room;
    const p = addPlayer(room, name, phone); room.adminId = p.id;
    return [200, session(room, p)];
  }
  const mem = findMember(phone);
  if (mem && (!code || code === mem.room.code || !['lobby', 'over'].includes(mem.room.phase))) return [200, session(mem.room, mem.p)];
  if (mem) leaveRoom(mem.room, mem.p);
  if (!code) return [404, { error: 'No active game for this number. Enter a game code.' }];
  const room = rooms[code];
  if (!room) return [404, { error: 'Game not found' }];
  if (room.phase !== 'lobby') return [400, { error: 'That game has already started' }];
  if (!name) return [400, { error: 'Enter your name' }];
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return [400, { error: 'That name is taken in this game' }];
  const p = addPlayer(room, name, phone); push(room);
  return [200, session(room, p)];
}

// ---------- HTTP ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(HTML); }
  const room = rooms[(url.searchParams.get('code') || '').toUpperCase()];
  const me = room && room.players.find(p => p.token === url.searchParams.get('token'));
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!me) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (me.res) { try { me.res.end(); } catch (e) {} }
    me.res = res; room.last = Date.now();
    res.write('data: ' + JSON.stringify(view(room, me)) + '\n\n');
    // heartbeat = fresh state, so stale screens heal themselves
    const ping = setInterval(() => { const m2 = room.players.find(p => p.id === me.id); if (m2) res.write('data: ' + JSON.stringify(view(room, m2)) + '\n\n'); }, 15000);
    req.on('close', () => { clearInterval(ping); if (me.res === res) me.res = null; });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/audio') {
    const au = me && room.audios[url.searchParams.get('id')];
    if (!au || (au.ch === 'traitor' && (me.role !== 'traitor' || room.phase === 'lobby'))) { res.writeHead(404); return res.end(); }
    const n = au.buf.length, m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const h = { 'Content-Type': au.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    if (m) {
      const s = m[1] ? +m[1] : 0, e = m[2] ? Math.min(+m[2], n - 1) : n - 1;
      res.writeHead(206, { ...h, 'Content-Range': 'bytes ' + s + '-' + e + '/' + n, 'Content-Length': e - s + 1 });
      return res.end(au.buf.subarray(s, e + 1));
    }
    res.writeHead(200, { ...h, 'Content-Length': n }); return res.end(au.buf);
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body = ''; req.on('data', d => { body += d; if (body.length > 1.2e6) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'Bad JSON' }); }
      if (url.pathname === '/api/login') { const [c, o] = login(b); return send(res, c, o); }
      if (url.pathname === '/api/act') {
        const r = rooms[String(b.code || '').toUpperCase()], m = r && r.players.find(p => p.token === b.token);
        if (!m) return send(res, 404, { error: 'Session expired — log in again' });
        const err = act(r, m, b);
        return send(res, 200, typeof err === 'string' ? { error: err } : { ok: true, state: view(r, m) });
      }
      send(res, 404, { error: 'Not found' });
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log('Traitor running on port ' + PORT));

setInterval(() => { // clean abandoned rooms (30 min with nobody connected)
  for (const r of Object.values(rooms)) {
    if (r.players.some(p => p.res)) r.last = Date.now();
    else if (Date.now() - r.last > 30 * 60e3) destroy(r);
  }
}, 60e3);

// ---------- Client ----------
const HTML = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0b10"><title>Traitor</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{max-width:100%;overflow-x:hidden}
:root{--gold:#f4d27a;--red:#e0483a;--green:#3ddc84;--bg:#0b0b10;--mut:#8b90a0;--line:#2b2f42}
body{margin:0;background:radial-gradient(1100px 560px at 50% -8%,#3d1016 0%,#0b0b10 62%) fixed;color:#ecebf2;font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
.wrap{max-width:600px;margin:0 auto;padding:12px 12px 96px}
.hero{font-size:clamp(40px,13vw,58px);font-weight:900;letter-spacing:7px;text-align:center;margin:34px 0 4px;color:var(--gold);
 text-shadow:0 1px 0 #c9a24a,0 2px 0 #a8832f,0 3px 0 #8a6a22,0 4px 0 #6d5219,0 5px 0 #4d3a12,0 14px 18px rgba(0,0,0,.75)}
.sub{text-align:center;color:var(--mut);margin-bottom:22px}
.card{background:linear-gradient(160deg,#1d2030,#12141c);border:1px solid var(--line);border-radius:18px;padding:14px;margin-bottom:12px;box-shadow:0 14px 28px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06)}
label{font-size:13px;color:var(--mut);display:block;margin:2px 0 4px}
input{width:100%;padding:13px;border-radius:12px;border:1px solid #2d3246;background:#0f1118;color:#fff;font-size:16px;margin-bottom:10px;outline:none}
input:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(244,210,122,.15)}
.btn{display:block;width:100%;padding:14px;border:0;border-radius:14px;color:#fff;font-size:16px;font-weight:800;cursor:pointer;margin-bottom:12px;
 background:linear-gradient(#ee5a4b,#b52a1d);box-shadow:0 6px 0 #6e140c,0 12px 18px rgba(0,0,0,.5);transition:transform .08s,box-shadow .08s}
.btn:active{transform:translateY(5px);box-shadow:0 1px 0 #6e140c,0 4px 8px rgba(0,0,0,.5)}
.btn.alt{background:linear-gradient(#3a4057,#272b3c);box-shadow:0 6px 0 #14161f,0 12px 18px rgba(0,0,0,.5)}.btn.alt:active{box-shadow:0 1px 0 #14161f}
.btn.gold{background:linear-gradient(#f6d77f,#c79a2c);color:#2a1d00;box-shadow:0 6px 0 #7b5a12,0 12px 18px rgba(0,0,0,.5)}.btn.gold:active{box-shadow:0 1px 0 #7b5a12}
.btn.sm{display:inline-block;width:auto;padding:10px 16px;margin:0;font-size:14px;box-shadow:0 4px 0 #6e140c}
.btn:disabled{opacity:.45;pointer-events:none}
.ib{background:#1d2030;border:1px solid #2d3246;color:#fff;border-radius:12px;width:42px;height:42px;font-size:18px;cursor:pointer;flex:none}
.err{color:#ff8a7a;text-align:center;min-height:22px;font-size:14px}
.mut{color:var(--mut)}.sm{font-size:13px}.center{text-align:center}.row{display:flex;gap:8px;align-items:center}.sb{justify-content:space-between}
h3{margin:14px 2px 8px;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut)}
#top{position:sticky;top:0;z-index:20;display:flex;gap:8px;align-items:center;padding:10px 12px;background:rgba(11,11,16,.9);backdrop-filter:blur(8px);border-bottom:1px solid #22263a}
.chip{background:#241a0a;border:1px solid #6d5219;color:var(--gold);font-weight:900;letter-spacing:4px;padding:8px 12px;border-radius:12px;cursor:pointer;font-size:16px}
#phasepill{flex:1;text-align:center;font-weight:700;font-size:14px;color:#ddd}
#nav{position:fixed;bottom:0;left:0;right:0;z-index:20;display:flex;background:rgba(14,15,22,.97);border-top:1px solid #22263a;padding-bottom:env(safe-area-inset-bottom)}
#nav button{flex:1;background:none;border:0;color:var(--mut);padding:10px 0 8px;font-size:20px;cursor:pointer;position:relative}
#nav button span{display:block;font-size:11px}#nav button.on{color:var(--gold)}
#bd{position:absolute;top:4px;right:28%;background:var(--red);color:#fff;border-radius:10px;font-size:11px;font-style:normal;padding:1px 6px;display:none}
/* flow stepper */
.flow{display:flex;gap:6px;margin-bottom:10px}
.flow div{flex:1;padding:8px 6px;border-radius:12px;background:#171a26;border:1px solid #262a3c;color:var(--mut);text-align:center;font-size:12px;line-height:1.25}
.flow b{display:block;font-size:13px;color:#cfd2de}.flow div.cur{background:linear-gradient(#5a1a14,#33100c);border-color:var(--red);box-shadow:0 0 14px rgba(224,72,58,.3)}.flow div.cur b{color:#ffb0a4}
.ex .exh{display:flex;gap:12px;align-items:center;margin-bottom:8px}.exi{font-size:34px}.ext{font-size:19px;font-weight:800;flex:1}
.exw,.exy{font-size:14px;margin-top:6px}.exy{color:#b6b9c7}
.ring{position:relative;width:62px;height:62px;flex:none}.ring svg{display:block}.rb{fill:none;stroke:#252a3d;stroke-width:6}.rf{fill:none;stroke:var(--gold);stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset .4s linear}
#rt{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}
#rt.hot{color:var(--red);animation:pulse .6s infinite alternate}@keyframes pulse{to{transform:scale(1.15)}}
.role{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;margin-bottom:12px;font-weight:700;cursor:pointer;box-shadow:0 8px 16px rgba(0,0,0,.4)}
.role.traitor{background:linear-gradient(135deg,#5e1a14,#2b0b08);color:#ff9d8f}.role.innocent{background:linear-gradient(135deg,#17492b,#0b2315);color:#93f7b0}.role small{display:block;font-weight:500;opacity:.85}
.stats{display:flex;gap:8px;margin-bottom:8px}.stats div{flex:1;background:#151824;border:1px solid #262a3c;border-radius:12px;text-align:center;padding:8px 4px}
.stats b{display:block;font-size:22px}.stats small{color:var(--mut);font-size:11px}.stats .g b{color:var(--green)}.stats .b b{color:var(--red)}
.meter{height:10px;border-radius:6px;background:var(--red);overflow:hidden;margin:6px 0 4px;box-shadow:inset 0 2px 3px rgba(0,0,0,.5)}.meter i{display:block;height:100%;background:var(--green);transition:width .6s}
/* player list — full-width rows, names never hidden */
.plist{display:grid;grid-template-columns:1fr;gap:10px}
@media(min-width:620px){.plist{grid-template-columns:1fr 1fr}}
.prow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px;border-radius:16px;min-height:68px;background:linear-gradient(160deg,#252a3d,#161925);border:2px solid #2d3248;box-shadow:0 4px 0 #0b0c12,0 8px 14px rgba(0,0,0,.4)}
.prow.me{border-color:#6d5a2a}.prow.trt{border-color:var(--red)}.prow.mine{border-color:var(--green);background:linear-gradient(160deg,#1c3a2a,#12201a)}.prow.tied{border-color:var(--gold)}
.prow.dead{opacity:.55;filter:grayscale(.7);box-shadow:none}.prow.dead b{text-decoration:line-through}
.av2{flex:none;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:19px;box-shadow:inset 0 -4px 6px rgba(0,0,0,.35),inset 0 3px 5px rgba(255,255,255,.25)}
.pn{flex:1 1 110px;min-width:0}.pn b{display:block;font-size:17px;line-height:1.15;word-break:break-word}.pn small{display:block;font-size:12px;color:var(--mut);margin-top:3px}
.vb{margin-left:auto;flex:none;min-width:104px;min-height:44px;border:0;border-radius:12px;padding:10px 14px;font-weight:800;font-size:15px;color:#fff;cursor:pointer;background:linear-gradient(#ee5a4b,#b52a1d);box-shadow:0 4px 0 #6e140c}
.vb:active{transform:translateY(3px);box-shadow:0 1px 0 #6e140c}.vb.on{background:linear-gradient(#35b46b,#1d7a44);box-shadow:0 4px 0 #0f4426}
.pbar{height:12px;border-radius:7px;background:#0e1017;overflow:hidden;border:1px solid #262a3c}.pbar i{display:block;height:100%;background:linear-gradient(90deg,#c79a2c,#f6d77f);transition:width .4s}
.res{font-size:18px;font-weight:800;text-align:center;margin-bottom:6px}
.tl{margin-top:10px}.tl .r{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:14px}.tl .nm{width:34%;min-width:80px;word-break:break-word}
.tl .bar{flex:1;height:14px;background:#0e1017;border-radius:7px;overflow:hidden}.tl .bar i{display:block;height:100%;background:linear-gradient(90deg,#b52a1d,#ee5a4b)}.tl .n{width:22px;text-align:right;font-weight:800}
.pl{display:inline-block;background:#1c2030;border:1px solid #2b3047;border-radius:20px;padding:6px 12px;margin:3px;font-size:14px}
.codebig{font-size:44px;font-weight:900;letter-spacing:10px;color:var(--gold);text-align:center;text-shadow:0 4px 0 #6d5219,0 10px 14px #000}
.msgs{height:50vh;overflow:auto;background:#0e1017;border:1px solid #232739;border-radius:14px;padding:10px;margin:8px 0}
.m{margin-bottom:8px;max-width:88%;background:#1b1f2e;border-radius:14px 14px 14px 4px;padding:7px 10px;font-size:15px;word-wrap:break-word}
.m.mine{margin-left:auto;background:#3a2a0e;border-radius:14px 14px 4px 14px}.m.t{background:#3a1511}
.m b{display:block;font-size:12px;color:var(--gold)}.m audio{width:210px;max-width:100%;height:34px;margin-top:3px}
.tabs{display:flex;gap:8px}.tabs button{flex:1;padding:10px;border-radius:12px;border:1px solid #2b3047;background:#161923;color:#bbb;font-weight:700;cursor:pointer}
.tabs button.on{background:#3a2a0e;color:var(--gold);border-color:#6d5219}.tabs button.on.sec{background:#3a1511;color:#ff9d8f;border-color:var(--red)}
.comp input{margin:0;flex:1}.mic.rec{background:var(--red);animation:pulse .6s infinite alternate}
.log div{padding:10px 12px;border-left:3px solid var(--gold);background:#141725;border-radius:0 10px 10px 0;margin-bottom:8px;font-size:14px}
#ann{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(0,0,0,.8);padding:24px;text-align:center}
#ann.on{display:flex}#ann .at{font-size:clamp(34px,11vw,60px);font-weight:900;letter-spacing:3px;animation:slam .6s cubic-bezier(.2,1.4,.4,1);text-shadow:0 2px 0 #000,0 6px 0 #000,0 16px 24px #000}
#ann .at.bad{color:#ff6a58}#ann .at.good{color:var(--green)}#ann .at.info{color:var(--gold)}
#ann .ax{margin-top:16px;font-size:19px;max-width:420px;animation:fade .9s}
@keyframes slam{0%{transform:perspective(700px) rotateX(80deg) scale(2.4);opacity:0}100%{transform:none;opacity:1}}@keyframes fade{from{opacity:0}}
.ov{position:fixed;inset:0;z-index:40;background:rgba(5,5,9,.93);display:none;align-items:center;justify-content:center;flex-direction:column;padding:20px;overflow:auto}.ov.on{display:flex}
.flip{perspective:900px;width:min(300px,80vw);height:400px;cursor:pointer}
.c3{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform 1s cubic-bezier(.3,1.3,.5,1)}.c3.on{transform:rotateY(180deg)}
.face{position:absolute;inset:0;backface-visibility:hidden;border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px;box-shadow:0 30px 50px rgba(0,0,0,.7)}
.front{background:linear-gradient(160deg,#3a1a22,#16080c);border:3px solid var(--gold);font-size:22px;font-weight:800;color:var(--gold)}
.back{transform:rotateY(180deg);border:3px solid #fff3}.back.traitor{background:linear-gradient(160deg,#6a1a14,#220806)}.back.innocent{background:linear-gradient(160deg,#17492b,#06170d)}
.big{font-size:30px;font-weight:900}
/* tablets & desktops: game on the left, chat + log always visible on the right */
@media(min-width:900px){
 .gw{max-width:1120px;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px;align-items:start;padding-bottom:30px}
 #t-game{grid-column:1;grid-row:1/span 2}#t-chat,#t-log{display:block!important}#t-chat{grid-column:2;grid-row:1}#t-log{grid-column:2;grid-row:2}
 .gw .err{grid-column:1/-1}#nav{display:none}.msgs{height:340px}.plist{grid-template-columns:1fr 1fr}
}
</style></head><body>
<div id="root"></div><div id="ann" onclick="this.classList.remove('on')"></div><div class="ov" id="roleov"></div><div class="ov" id="overov"></div>
<script>
var lastAt=Date.now(),S=null,SES=null,es=null,off=0,tab='game',chan='all',lastEv=null,lastMsg=-1,unread=0,muted=false,rChan=null,rendered={},rec=null,recT=null,built=false,annT=null;
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function ld(k){try{return JSON.parse(localStorage.getItem(k)||'null')}catch(e){return null}}
function sv(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function api(p,b){return fetch(p,{method:'POST',body:JSON.stringify(b)}).then(function(r){return r.json()})}
function wide(){return window.matchMedia&&matchMedia('(min-width:900px)').matches}
function setErr(m){var e=$('err');if(e){e.textContent=m;if(m)setTimeout(function(){if(e.textContent===m)e.textContent=''},4000)}}
function act(type,x){if(!SES)return;var b={type:type,code:SES.code,token:SES.token};for(var k in x||{})b[k]=x[k];
  return api('/api/act',b).then(function(r){if(r.error)setErr(r.error);else if(r.state)handle(r.state)}).catch(function(){setErr('Connection problem')})}
function secs(){return S&&S.deadline?Math.max(0,Math.ceil((S.deadline-(Date.now()+off))/1000)):0}
function fmt(s){return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
function hue(n){var h=0;for(var i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))%360;return h}
function tf(n){return n>12?3:n>7?2:1}
function speak(t){if(muted||!window.speechSynthesis)return;try{speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(t);u.rate=.9;u.pitch=.7;u.volume=1;var v=speechSynthesis.getVoices().filter(function(x){return /^en/i.test(x.lang)})[0];if(v)u.voice=v;speechSynthesis.speak(u)}catch(e){}}
function unlockSpeech(){try{speechSynthesis.speak(new SpeechSynthesisUtterance(''))}catch(e){}}

/* ---------- login ---------- */
function showLogin(msg){
  if(es){es.close();es=null}built=false;SES=null;S=null;
  var u=ld('tr_user')||{},qc=(location.search.match(/[?&]code=([A-Za-z]{5})/)||[])[1]||'';
  $('root').innerHTML='<div class="wrap"><div class="hero">TRAITOR</div><div class="sub">Trust no one. Find the traitors.</div>'+
  '<div class="card"><label>Your name</label><input id="n" maxlength="16" placeholder="e.g. Rahul" value="'+esc(u.name||'')+'">'+
  '<label>Phone number (your account — use the same one to come back)</label><input id="ph" type="tel" inputmode="numeric" maxlength="14" placeholder="10-digit mobile number" value="'+esc(u.phone||'')+'">'+
  '<label>Game code (not needed if you are returning)</label><input id="cd" maxlength="5" placeholder="ABCDE" style="text-transform:uppercase;letter-spacing:6px;text-align:center;font-weight:800" value="'+esc(qc)+'">'+
  '<button class="btn" id="go">Join / Resume game</button><button class="btn alt" id="mk">Create game (admin only)</button><div class="err" id="err">'+esc(msg||'')+'</div></div></div>';
  $('go').onclick=function(){doLogin(false)};$('mk').onclick=function(){doLogin(true)};
}
function doLogin(create){
  unlockSpeech();
  var n=$('n')?$('n').value:'',ph=$('ph')?$('ph').value:'',cd=$('cd')?$('cd').value:'';
  return api('/api/login',{name:n,phone:ph,code:cd,create:create}).then(function(r){
    if(r.error)return showLogin(r.error);
    sv('tr_user',{name:r.name,phone:ph.replace(/\D/g,'').slice(-10),auto:true});SES=r;connect();
  }).catch(function(){showLogin('Cannot reach server')});
}
function autoLogin(){
  var u=ld('tr_user'),qc=(location.search.match(/[?&]code=([A-Za-z]{5})/)||[])[1]||'';
  if(!(u&&u.auto&&u.phone))return showLogin();
  api('/api/login',{name:u.name,phone:u.phone,code:qc}).then(function(r){
    if(r.error)return showLogin(qc?r.error:'');SES=r;connect();
  }).catch(function(){showLogin('Cannot reach server')});
}
function logout(){var u=ld('tr_user')||{};u.auto=false;sv('tr_user',u);showLogin('Logged out. Log in with the same phone number to return to your game.')}

/* ---------- skeleton ---------- */
function build(){
  built=true;
  $('root').innerHTML='<header id="top"><button class="chip" id="codechip">-----</button><div id="phasepill"></div><button class="ib" id="mute">🔊</button><button class="ib" id="lo">⎋</button></header>'+
  '<div class="wrap gw"><section id="t-game"></section>'+
  '<section id="t-chat" hidden><div class="tabs" id="chtabs"></div><div class="msgs" id="msgs"></div><div class="mut sm center" id="note"></div>'+
  '<div class="row comp"><input id="msg" maxlength="300" placeholder="Type a message..."><button class="ib mic" id="mic">🎤</button><button class="btn sm" id="send">Send</button></div></section>'+
  '<section id="t-log" hidden></section><div class="err" id="err"></div></div>'+
  '<nav id="nav"><button data-tab="game" class="on">🎲<span>Game</span></button><button data-tab="chat">💬<span>Chat</span><i id="bd"></i></button><button data-tab="log">📜<span>Log</span></button></nav>';
  $('nav').onclick=function(e){var b=e.target.closest('button');if(b)setTab(b.getAttribute('data-tab'))};
  $('mute').onclick=function(){muted=!muted;sv('tr_mute',muted);$('mute').textContent=muted?'🔇':'🔊';if(muted&&window.speechSynthesis)speechSynthesis.cancel()};
  $('lo').onclick=logout;$('codechip').onclick=share;
  $('send').onclick=sendMsg;$('mic').onclick=toggleRec;$('msg').onkeydown=function(e){if(e.key==='Enter')sendMsg()};
  $('t-game').onclick=onGameClick;
  $('chtabs').onclick=function(e){var b=e.target.closest('button');if(b){chan=b.getAttribute('data-c');updChat()}};
  muted=!!ld('tr_mute');$('mute').textContent=muted?'🔇':'🔊';
}
function setTab(t){tab=t;['game','chat','log'].forEach(function(k){$('t-'+k).hidden=(k!==t)});
  Array.prototype.forEach.call($('nav').children,function(b){b.classList.toggle('on',b.getAttribute('data-tab')===t)});
  if(t==='chat'){unread=0;updBadge();var m=$('msgs');m.scrollTop=m.scrollHeight}window.scrollTo(0,0)}
function updBadge(){var b=$('bd');if(!b)return;b.style.display=unread?'block':'none';b.textContent=unread}

/* ---------- connection ---------- */
function connect(){
  if(es)es.close();if(!built)build();lastEv=null;lastMsg=-1;rChan=null;lastAt=Date.now();
  es=new EventSource('/api/events?code='+SES.code+'&token='+SES.token);
  es.onmessage=function(e){lastAt=Date.now();handle(JSON.parse(e.data))};
  es.onerror=function(){if(es&&es.readyState===2){var u=ld('tr_user')||{};if(u.auto)autoLogin();else showLogin()}};
}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&SES)connect()});
window.addEventListener('online',function(){if(SES)connect()});
setInterval(function(){if(SES&&built&&Date.now()-lastAt>40000)connect()},10000);
function handle(d){
  S=d;off=d.now-Date.now();
  if(lastEv===null)lastEv=d.event.id;else if(d.event.id!==lastEv){lastEv=d.event.id;announce(d.event)}
  var mx=lastMsg;d.chat.forEach(function(m){if(m.id>mx){if(lastMsg>=0&&!wide()&&tab!=='chat'&&m.name!==d.me.name)unread++;mx=m.id}});lastMsg=mx;updBadge();
  updTop();updGame();updChat();updLog();checkRole();checkOver();
}
function announce(e){
  var a=$('ann');a.innerHTML='<div class="at '+esc(e.kind)+'">'+esc(e.title)+'</div><div class="ax">'+esc(e.text)+'</div>';a.classList.add('on');
  clearTimeout(annT);annT=setTimeout(function(){a.classList.remove('on')},5500);speak(e.text);
}

/* ---------- game view ---------- */
var PN={lobby:'🏰 Gathering',round1:'🗣 Round 1',circle:'⚖️ Circle of Doubt',reveal:'📜 The Verdict',night:'🌙 Killing Round',dawn:'🌅 Dawn',over:'🏁 Game Over'};
function updTop(){$('codechip').textContent=S.code;$('phasepill').textContent=(S.phase==='circle'&&S.candidates?'🔁 Revote':S.phase==='circle'&&S.final?'🏁 Final Circle':PN[S.phase])}
function pById(id){return S.players.filter(function(x){return x.id===id})[0]}
function names(ids){return ids.map(function(i){var p=pById(i);return p?esc(p.name):''}).join(' & ')}
function explain(){
  var p=S.phase,t=S.me.role==='traitor',al=S.me.alive;
  if(p==='lobby')return{i:'🏰',t:'Gathering the circle',w:'Share the game code so friends can join. The admin starts once at least '+S.minPlayers+' players are in.',y:'Traitors are chosen secretly: 1 traitor for up to 7 players, 2 for 8–12, and 3 for 13 or more.'};
  if(p==='over')return{i:'🏁',t:S.winner==='traitors'?'The traitors win':'The innocents win',w:'Everyone\'s true role is shown below. The admin can start a new game.',y:S.winner==='traitors'?'The traitors now equal the innocents, so they control every vote.':'Every traitor was found and removed.'};
  if(!al&&p!=='reveal'&&p!=='dawn')return{i:'👻',t:'You are out',w:'You can watch and read the chat, but you can no longer talk or vote.',y:'Out players keep watching so they can see how the game ends.'};
  if(p==='round1')return t?{i:'🗡',t:'Round 1 · Traitors choose',w:'Use the 🗡 Secret chat. Each traitor votes for a DIFFERENT innocent so it does not look planned. Only traitor votes count this round; a tie is settled at random.',y:'Because only your votes count, nobody can tell who the real traitors are.'}:
   {i:'🗣',t:'Round 1 · The First Whisper',w:'Chat and vote for who you suspect. You can change your vote until the timer ends. The most-voted player leaves the game.',y:'Traitors hide among you. Watch who stays quiet or accuses too fast.'};
  if(p==='circle'&&S.candidates)return{i:'🔁',t:'REVOTE — it was a tie',w:'Vote again, but only for the tied players: '+names(S.candidates)+'. Every vote counts.',y:'A tie never banishes anyone. After two tied revotes, fate decides.'};
  if(p==='circle'&&S.final)return t?{i:'🏁',t:'FINAL Circle of Doubt',w:'Survive this vote and you win. Convince everyone you are innocent.',y:'No killing round is left — the circle decides. A tie means a revote.'}:
   {i:'🏁',t:'FINAL Circle of Doubt',w:'Last chance: vote for the traitor. Catch them and the innocents win; miss and the traitors win.',y:'A killing round would change nothing now, so the circle decides. A tie means a revote.'};
  if(p==='circle')return t?{i:'⚖️',t:'Circle of Doubt',w:'Blend in. Steer the vote toward an innocent — or sacrifice a partner to look honest. Votes are secret.',y:'Every innocent banished brings you closer to equal numbers, which is a traitor win.'}:
   {i:'⚖️',t:'Circle of Doubt',w:'Everyone votes for who they think the traitor is. Votes are secret and you can change yours until the timer ends. Every vote counts.',y:'Catch a traitor and they are out. Miss, and an innocent is banished instead.'};
  if(p==='night')return t&&al?{i:'🌙',t:'Killing Round',w:'Pick one innocent to eliminate. Most traitor votes dies; ties are random. Change your vote until the timer ends.',y:'Traitors win when they equal the innocents.'}:
   {i:'🌙',t:'Night falls',w:'Everyone sleeps. The traitors are secretly choosing a victim. No chat or voting for you right now.',y:'At dawn the victim is announced.'};
  if(p==='reveal')return{i:'📜',t:'The verdict',w:'See how the vote went below. The next phase starts automatically.',y:'Everyone learns whether the circle guessed right.'};
  return{i:'🌅',t:'Dawn',w:'See what happened during the night. The next Circle of Doubt starts automatically.',y:'Traitors win when they equal the innocents; innocents win when all traitors are out.'};
}
function ringHTML(){if(!S.deadline)return'';var s=secs(),f=S.dur?Math.min(1,s/S.dur):0,C=2*Math.PI*24;
  return'<div class="ring"><svg width="62" height="62" viewBox="0 0 62 62"><circle cx="31" cy="31" r="24" class="rb"/><circle id="rg" cx="31" cy="31" r="24" class="rf" stroke-dasharray="'+C+'" stroke-dashoffset="'+(C*(1-f))+'" transform="rotate(-90 31 31)"/></svg><span id="rt">'+fmt(s)+'</span></div>'}
setInterval(function(){if(!S||!S.deadline)return;var s=secs(),rt=$('rt'),rg=$('rg');if(rt){rt.textContent=fmt(s);rt.className=s<=10?'hot':''}if(rg){var C=2*Math.PI*24;rg.setAttribute('stroke-dashoffset',C*(1-(S.dur?Math.min(1,s/S.dur):0)))}var ea=$('early');if(ea)ea.textContent=s},300);
function canPick(p){var me=S.me,ph=S.phase;if(!me.alive||!p.alive||p.id===me.id)return false;
  if(ph==='circle'){return !S.candidates||S.candidates.indexOf(p.id)>=0}
  if(ph==='round1')return !(me.role==='traitor'&&p.role==='traitor');
  if(ph==='night')return me.role==='traitor'&&p.role!=='traitor';return false}
function rowHTML(p){
  var me=S.me,ph=S.phase,cp=canPick(p),mine=me.vote===p.id,night=ph==='night',tags=[],cnt=0,hh=hue(p.name);
  (S.team||[]).forEach(function(t){if(t.target===p.id)cnt++});
  if(p.id===me.id)tags.push('You');
  if(!p.alive)tags.push('✝ out'+(p.role?' · '+p.role:''));
  else if(ph==='over'&&p.role)tags.push(p.role);
  else if(p.role==='traitor'&&p.id!==me.id)tags.push('🗡 your partner');
  if(S.candidates&&S.candidates.indexOf(p.id)>=0&&p.alive)tags.push('⚖ tied');
  if(mine)tags.push('✔ your vote');
  if(cnt)tags.push('🗡 '+cnt+' traitor vote'+(cnt>1?'s':''));
  var cls='prow'+(p.alive?'':' dead')+(p.id===me.id?' me':'')+(mine?' mine':'')+(p.role==='traitor'&&p.id!==me.id&&p.alive?' trt':'')+(S.candidates&&S.candidates.indexOf(p.id)>=0&&p.alive?' tied':'');
  var btn='';
  if(cp)btn=mine?'<button class="vb on" data-a="undo" data-id="'+p.id+'">✔ Voted · undo</button>':'<button class="vb" data-a="'+(night?'kill':'vote')+'" data-id="'+p.id+'">'+(night?'🗡 Kill':'🗳 Vote')+'</button>';
  return'<div class="'+cls+'"><span class="av2" style="background:radial-gradient(circle at 35% 30%,hsl('+hh+',65%,60%),hsl('+hh+',60%,28%))">'+esc(p.name.charAt(0).toUpperCase())+'</span><span class="pn"><b>'+esc(p.name)+'</b><small>'+tags.join(' · ')+'</small></span>'+btn+'</div>';
}
function tallyHTML(){
  var t=S.tally;if(!t)return'';var mx=t.rows.length?t.rows[0].count:1;
  var h='<div class="tl">'+t.rows.map(function(r){return'<div class="r"><span class="nm">'+esc(r.name)+'</span><span class="bar"><i style="width:'+(r.count/mx*100)+'%"></i></span><span class="n">'+r.count+'</span></div>'}).join('')+'</div>';
  h+='<div class="mut sm center" style="margin-top:8px"><b>'+t.counted+' of '+t.total+' votes counted</b>'+(t.abstained.length?' · Did not vote: '+t.abstained.map(esc).join(', '):'')+'</div>';
  return h;
}
function updGame(){
  var me=S.me,p=S.phase,c=S.counts,inn=c.alive-c.traitorsLeft,ex=explain(),h='';
  var keep={},fid=document.activeElement&&document.activeElement.id;['tm1','tm2','tm3'].forEach(function(i){var e=$(i);if(e)keep[i]=e.value});
  // 1. where are we in the game
  if(p!=='lobby'&&p!=='over'){var st=S.stage;
    h+='<div class="flow"><div class="'+(st==='round1'?'cur':'')+'"><b>1 · Round 1</b>Traitors pick</div><div class="'+(st==='circle'?'cur':'')+'"><b>2 · '+(S.final?'Final circle':'Circle of Doubt')+'</b>Everyone votes</div><div class="'+(st==='night'?'cur':'')+'"><b>3 · Killing round</b>Traitors kill</div></div>'}
  h+='<div class="card ex"><div class="exh"><span class="exi">'+ex.i+'</span><div class="ext">'+esc(ex.t)+'</div>'+ringHTML()+'</div><div class="exw"><b>What to do:</b> '+ex.w+'</div><div class="exy"><b>Why:</b> '+ex.y+'</div></div>';
  // 2. who am I
  if(me.role&&p!=='lobby'){var mates=S.players.filter(function(x){return x.role==='traitor'&&x.id!==me.id}).map(function(x){return x.name});
    h+='<div class="role '+me.role+'" data-a="rolecard"><span style="font-size:28px">'+(me.role==='traitor'?'🗡':'🛡')+'</span><div>You are '+(me.role==='traitor'?'a TRAITOR':'INNOCENT')+(me.alive?'':' (out)')+'<small>'+(me.role==='traitor'?(mates.length?'Partner'+(mates.length>1?'s':'')+': '+esc(mates.join(', ')):'You are the only traitor'):'Find the traitors and vote them out')+'</small></div></div>'}
  // 3. the score
  if(p!=='lobby'){
    h+='<div class="stats"><div><b>'+c.alive+'</b><small>Alive</small></div><div class="g"><b>'+inn+'</b><small>Innocents</small></div><div class="b"><b>'+c.traitorsLeft+'</b><small>Traitors left</small></div></div>'+
    '<div class="meter"><i style="width:'+(c.alive?inn/c.alive*100:0)+'%"></i></div><div class="mut sm center">Traitors win when they equal the innocents ('+c.traitorsLeft+' vs '+inn+'). Innocents win when no traitor is left. This game started with '+c.totalTraitors+' traitor'+(c.totalTraitors>1?'s':'')+'.</div>';
  }
  if(p==='lobby'){
    h+='<div class="card center"><div class="mut sm">GAME CODE</div><div class="codebig">'+S.code+'</div><div class="row" style="margin-top:12px"><button class="btn gold sm" data-a="share" style="flex:1">📤 Share</button><button class="btn alt sm" data-a="wa" style="flex:1">WhatsApp</button><button class="btn alt sm" data-a="copy" style="flex:1">Copy</button></div></div>'+
    '<div class="card"><div class="mut sm" style="margin-bottom:6px">Players joined ('+S.players.length+') · this game will have <b>'+tf(S.players.length)+' traitor'+(tf(S.players.length)>1?'s':'')+'</b></div>'+S.players.map(function(x){return'<span class="pl">'+esc(x.name)+(x.id===me.id?' (you)':'')+'</span>'}).join('')+'</div>';
    h+='<div class="card"><div class="mut sm" style="margin-bottom:8px">Round timers (minutes)'+(me.admin?'':' — set by admin')+'</div><div class="row">'+[['tm1','Round 1',S.times.round1],['tm2','Circle',S.times.circle],['tm3','Killing',S.times.night]].map(function(x){return'<div style="flex:1"><label>'+x[1]+'</label><input id="'+x[0]+'" type="number" step="0.5" min="0.5" max="30" value="'+(x[2]/60)+'"'+(me.admin?'':' disabled')+' style="margin:0;text-align:center"></div>'}).join('')+'</div>'+(me.admin?'<button class="btn alt" style="margin:10px 0 0;padding:10px" data-a="settime">Save timers</button>':'')+'</div>';
    h+=me.admin?'<button class="btn" data-a="start"'+(S.players.length<S.minPlayers?' disabled':'')+'>▶ Start game ('+(S.players.length<S.minPlayers?'need '+S.minPlayers+'+ players':S.players.length+' players')+')</button>':'<div class="card center mut">Waiting for the admin to start...</div>';
  }else{
    // 4. vote progress
    var vp=S.voteStat&&(p==='round1'||p==='circle'||(p==='night'&&me.role==='traitor'));
    if(vp){var pc=S.voteStat.total?S.voteStat.voted/S.voteStat.total*100:0,cur=me.vote?pById(me.vote):null;
      h+='<div class="card"><div class="row sb"><b>'+(p==='night'?'Traitor votes':'Votes in')+'</b><b>'+S.voteStat.voted+' / '+S.voteStat.total+'</b></div><div class="pbar" style="margin:8px 0"><i style="width:'+pc+'%"></i></div>'+
      '<div class="sm">'+(me.alive?(cur?'Your vote: <b>'+esc(cur.name)+'</b> ✔ <span class="mut">— change or undo any time until the timer ends</span>':'<b style="color:var(--gold)">You have not voted yet.</b> Tap a Vote button below.'):'<span class="mut">You are out and cannot vote.</span>')+'</div>'+
      (S.early?'<div class="sm" style="margin-top:6px;color:var(--green)">✅ All votes are in — locking in <span id="early">'+secs()+'</span>s (you can still change yours)</div>':(S.waiting&&S.waiting.length?'<div class="sm mut" style="margin-top:6px">Waiting for: '+S.waiting.map(esc).join(', ')+'</div>':''))+'</div>';
    }
    if((p==='reveal'||p==='dawn')&&S.result)h+='<div class="card"><div class="res">'+esc(S.result)+'</div>'+(p==='reveal'?tallyHTML():'')+'</div>';
    if(p==='over')h+='<div class="card"><div class="res">'+(S.winner==='traitors'?'🗡 The traitors win!':'🛡 The innocents win!')+'</div></div>';
    // 5. players (alive first, out below) — full-width rows so names are never hidden
    var al=S.players.filter(function(x){return x.alive}),out=S.players.filter(function(x){return !x.alive});
    h+='<h3>'+(p==='circle'||p==='round1'?'Vote for the traitor':p==='night'&&me.role==='traitor'?'Choose a victim':'Players')+' · '+al.length+' alive</h3><div class="plist">'+al.map(rowHTML).join('')+'</div>';
    if(out.length)h+='<h3>Out of the game · '+out.length+'</h3><div class="plist">'+out.map(rowHTML).join('')+'</div>';
    if(me.admin&&p==='over')h+='<button class="btn gold" style="margin-top:14px" data-a="again">🔄 Play again (same players)</button>';
    if(me.admin&&{round1:1,circle:1,reveal:1,night:1,dawn:1}[p]){h+='<h3>Admin</h3><div class="row">'+((p==='round1'||p==='circle'||p==='night')?'<button class="btn alt" data-a="extend" style="padding:10px;font-size:14px">➕ +1 min</button>':'')+'<button class="btn alt" data-a="skip" style="padding:10px;font-size:14px">⏭ End timer now</button></div>'}
  }
  $('t-game').innerHTML=h;
  for(var k in keep){var e2=$(k);if(e2&&!e2.disabled&&keep[k]!=='')e2.value=keep[k]}if(fid&&keep[fid]!==undefined&&$(fid))$(fid).focus();
}
function onGameClick(e){
  var b=e.target.closest('[data-a]');if(!b)return;var a=b.getAttribute('data-a'),id=b.getAttribute('data-id');
  if(a==='vote')act('vote',{target:id});
  else if(a==='kill')act('kill',{target:id});
  else if(a==='undo')act(S.phase==='night'?'kill':'vote',{target:null});
  else if(a==='settime'){act('settime',{round1:Math.round(parseFloat($('tm1').value)*60),circle:Math.round(parseFloat($('tm2').value)*60),night:Math.round(parseFloat($('tm3').value)*60)})}
  else if(a==='extend')act('extend');else if(a==='start')act('start');else if(a==='skip')act('skip');else if(a==='again')act('restart');
  else if(a==='share')share();else if(a==='wa')window.open('https://wa.me/?text='+encodeURIComponent(shareText()),'_blank');
  else if(a==='copy')copyText(shareText(),'Invite copied!');else if(a==='rolecard')showRole(true);
}
function shareUrl(){return location.origin+'/?code='+S.code}
function shareText(){return 'Join my TRAITOR game! Code: '+S.code+'  '+shareUrl()}
function copyText(t,m){try{navigator.clipboard.writeText(t).then(function(){setErr(m)},function(){fb(t,m)})}catch(e){fb(t,m)}}
function fb(t,m){var x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();try{document.execCommand('copy');setErr(m)}catch(e){}document.body.removeChild(x)}
function share(){if(!S)return;if(navigator.share){navigator.share({title:'Traitor',text:'Join my TRAITOR game! Code: '+S.code,url:shareUrl()}).catch(function(){})}else copyText(shareText(),'Invite copied!')}

/* ---------- overlays ---------- */
function showRole(force){
  var me=S.me,mates=S.players.filter(function(x){return x.role==='traitor'&&x.id!==me.id}).map(function(x){return x.name}),t=me.role==='traitor';
  $('roleov').innerHTML='<div class="mut" style="margin-bottom:14px">Tap the card to reveal your secret role</div><div class="flip" id="fl"><div class="c3" id="c3"><div class="face front">🎭<br>Your role<br><span class="sm mut">tap to flip</span></div><div class="face back '+me.role+'"><div style="font-size:64px">'+(t?'🗡':'🛡')+'</div><div class="big">'+(t?'TRAITOR':'INNOCENT')+'</div><p>'+(t?(mates.length?'Your partner'+(mates.length>1?'s are ':' is ')+'<b>'+esc(mates.join(', '))+'</b>.<br>Use the Secret chat to talk privately.':'You are the only traitor. Trust no one.'):'You are not a traitor. Find them before they outnumber you.')+'</p></div></div></div><button class="btn gold" style="max-width:300px;margin-top:22px" id="rok">I understand</button>';
  $('roleov').classList.add('on');$('fl').onclick=function(){$('c3').classList.add('on')};
  $('rok').onclick=function(){sv('seen_'+S.code+'_'+S.gameNo,1);$('roleov').classList.remove('on')};
  if(!force)setTimeout(function(){var c=$('c3');if(c)c.classList.add('on')},1200);
}
function checkRole(){if(S.me.role&&S.phase!=='lobby'&&S.phase!=='over'&&!ld('seen_'+S.code+'_'+S.gameNo)&&!$('roleov').classList.contains('on'))showRole(false)}
function checkOver(){
  var o=$('overov');if(S.phase!=='over'){o.classList.remove('on');o.setAttribute('data-k','');return}
  var k='o'+S.code+S.gameNo;if(o.getAttribute('data-k')===k)return;o.setAttribute('data-k',k);
  var tw=S.winner==='traitors';
  o.innerHTML='<div class="big" style="color:'+(tw?'#ff6a58':'#3ddc84')+';text-align:center">'+(tw?'🗡 THE TRAITORS WIN':'🛡 THE INNOCENTS WIN')+'</div><p class="mut center" style="max-width:340px">'+(tw?'The traitors now equal the innocents — they control every vote.':'Every traitor has been found and removed.')+'</p>'+
  '<div class="card" style="width:min(360px,100%)">'+S.players.map(function(x){return'<div class="row sb" style="padding:5px 0"><span>'+esc(x.name)+(x.alive?'':' ✝')+'</span><b style="color:'+(x.role==='traitor'?'#ff8a7a':'#8aff9e')+'">'+x.role+'</b></div>'}).join('')+'</div><button class="btn gold" style="max-width:300px" id="ovk">See full results</button>';
  o.classList.add('on');setTimeout(function(){var b=$('ovk');if(b)b.onclick=function(){o.classList.remove('on')}},0);
}
function updLog(){$('t-log').innerHTML='<h3>Game log</h3><div class="log">'+(S.log.length?S.log.slice().reverse().map(function(l){return'<div>'+esc(l)+'</div>'}).join(''):'<div class="mut">Nothing has happened yet.</div>')+'</div>'}

/* ---------- chat ---------- */
function canChat(){var me=S.me,p=S.phase;if(p==='lobby'||p==='over')return true;if(!me.alive)return false;if(chan==='traitor')return me.role==='traitor';return p!=='night'}
function updChat(){
  var me=S.me,isT=me.role==='traitor'&&S.phase!=='lobby';if(!isT&&chan==='traitor')chan='all';
  $('chtabs').innerHTML='<button data-c="all" class="'+(chan==='all'?'on':'')+'">Everyone</button>'+(isT?'<button data-c="traitor" class="sec '+(chan==='traitor'?'on':'')+'">🗡 Secret (traitors)</button>':'');
  var box=$('msgs');if(rChan!==chan){box.innerHTML='';rendered={};rChan=chan}
  var near=box.scrollHeight-box.scrollTop-box.clientHeight<80;
  S.chat.filter(function(m){return m.ch===chan}).forEach(function(m){
    if(rendered[m.id])return;rendered[m.id]=1;var d=document.createElement('div');d.className='m'+(m.name===me.name?' mine':'')+(m.ch==='traitor'?' t':'');
    d.innerHTML='<b>'+esc(m.name)+(m.ch==='traitor'?' 🗡':'')+'</b>'+(m.audio?'🎙 '+m.dur+'s<br><audio controls preload="none" src="/api/audio?code='+SES.code+'&token='+SES.token+'&id='+m.audio+'"></audio>':esc(m.text));
    box.appendChild(d)});
  if(near)box.scrollTop=box.scrollHeight;
  var ok=canChat();$('msg').disabled=!ok;$('send').disabled=!ok;$('mic').disabled=!ok;
  if(!rec)$('note').textContent=ok?(chan==='traitor'?'Only traitors can see this chat.':''):(!me.alive?'You are out — you can read but not chat.':'Everyone sleeps during the killing round.');
}
function sendMsg(){var i=$('msg'),t=i.value.trim();if(!t)return;i.value='';act('chat',{text:t,ch:chan})}
function updMic(){var m=$('mic');if(m){m.classList.toggle('rec',!!rec);m.textContent=rec?'⏹':'🎤'}}
function toggleRec(){
  if(rec){rec.send=true;rec.mr.stop();return}
  if(!navigator.mediaDevices||!window.MediaRecorder)return setErr('Voice messages are not supported on this browser');
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    var mt=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg'].filter(function(m){return MediaRecorder.isTypeSupported(m)})[0]||'';
    var chunks=[],mr=new MediaRecorder(stream,mt?{mimeType:mt,audioBitsPerSecond:32000}:{audioBitsPerSecond:32000}),t0=Date.now();
    rec={mr:mr,send:true};
    mr.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data)};
    mr.onstop=function(){stream.getTracks().forEach(function(t){t.stop()});var send=rec&&rec.send;clearInterval(recT);rec=null;updMic();
      if(!send||!chunks.length)return;var type=mr.mimeType||mt||'audio/webm',blob=new Blob(chunks,{type:type}),dur=Math.round((Date.now()-t0)/1000),fr=new FileReader();
      fr.onload=function(){act('chat',{audio:String(fr.result).split(',')[1],mime:type,dur:dur,ch:chan})};fr.readAsDataURL(blob)};
    mr.start();updMic();recT=setInterval(function(){var s=Math.round((Date.now()-t0)/1000);$('note').textContent='🔴 Recording '+s+'s — tap ⏹ to send (max 25s)';if(s>=25&&rec){rec.send=true;rec.mr.stop()}},500);
  }).catch(function(){setErr('Microphone permission denied')});
}
autoLogin();
</script></body></html>`;
