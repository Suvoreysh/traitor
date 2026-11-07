// TRAITOR v2 — online social-deduction game. Single file, zero dependencies.
// Run: node traitor-single.js   (PORT env optional)  → http://localhost:3000
const http = require('http'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = '7908979021';           // only this number can create games
const MIN_PLAYERS = 4;
const T = { round1: 300, circle: 180, reveal: 12, night: 90, dawn: 12 }; // seconds
const rooms = {};

const rnd = n => Math.floor(Math.random() * n);
const uid = () => crypto.randomBytes(8).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const newCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 5; i++) s += c[rnd(c.length)]; } while (rooms[s]); return s; };
const traitorsFor = n => (n <= 7 ? 1 : n <= 13 ? 2 : 3);
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10);
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 16);
const alive = r => r.players.filter(p => p.alive);
const find = (r, id) => r.players.find(p => p.id === id);
const locked = r => r.deadline && Date.now() >= r.deadline;

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
  let vs = null;
  if (voting) vs = { voted: al.filter(p => p.vote).length, total: al.length };
  else if (ph === 'night' && isT) { const ts = al.filter(p => p.role === 'traitor'); vs = { voted: ts.filter(p => p.vote).length, total: ts.length }; }
  const team = isT && (voting || ph === 'night') ? al.filter(p => p.role === 'traitor' && p.vote).map(p => ({ voter: p.name, target: p.vote })) : null;
  return {
    now: Date.now(), code: room.code, phase: ph, stage: room.stage, circleNo: room.circleNo, gameNo: room.gameNo,
    deadline: room.deadline, dur: room.dur, winner: room.winner, minPlayers: MIN_PLAYERS,
    times: { round1: room.T.round1, circle: room.T.circle, night: room.T.night },
    me: { id: me.id, name: me.name, role: started ? me.role : null, admin: me.id === room.adminId, alive: me.alive, vote: me.vote },
    players: room.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive,
      role: started && (over || !p.alive || p.id === me.id || (isT && p.role === 'traitor')) ? p.role : null
    })),
    counts: { alive: al.length, traitorsLeft: tl, totalTraitors: room.totalTraitors, total: room.players.length },
    voteStat: vs, team,
    chat: room.chat.filter(m => m.ch === 'all' || (m.ch === 'traitor' && isT)),
    result: room.result, tally: room.tally, log: room.log, event: room.event
  };
}
function push(room) {
  for (const p of room.players) if (p.res) p.res.write('data: ' + JSON.stringify(view(room, p)) + '\n\n');
}

// ---------- game flow ----------
function go(room, phase) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.dur = room.T[phase] || 0;
  room.deadline = room.dur ? Date.now() + room.dur * 1000 : 0;
  if (phase === 'round1' || phase === 'circle' || phase === 'night') {
    room.stage = phase; room.players.forEach(p => { p.vote = null; }); room.tally = null; room.result = null;
  }
  if (phase === 'circle') { room.circleNo++; say(room, 'The Circle of Doubt begins. Vote for who you think is a traitor.', 'CIRCLE OF DOUBT', 'info'); }
  if (phase === 'night') say(room, 'Night falls. Everyone, close your eyes.', 'KILLING ROUND', 'info');
  if (room.dur) room.timer = setTimeout(() => advance(room), room.dur * 1000);
  push(room);
}
function win(room) {
  const a = alive(room), t = a.filter(p => p.role === 'traitor').length;
  if (!t) return 'innocents';
  if (t >= a.length - t) return 'traitors';
  return null;
}
function end(room, w) {
  clearTimeout(room.timer);
  room.winner = w; room.phase = 'over'; room.deadline = 0; room.dur = 0;
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
    // Only traitors' votes count in round 1, so nobody can tell who the real traitors are.
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
    const counts = {};
    alive(room).forEach(p => { if (p.vote) counts[p.vote] = (counts[p.vote] || 0) + 1; });
    room.tally = Object.entries(counts).map(([id, c]) => ({ name: find(room, id).name, count: c })).sort((x, y) => y.count - x.count);
    const { max, ids } = top(counts), lab = 'Circle #' + room.circleNo + ' — ';
    if (!max || ids.length > 1) {
      room.result = 'The circle is split. Nobody is banished.';
      say(room, room.result, 'NO MAJORITY', 'info');
    } else {
      const v = find(room, ids[0]); v.alive = false;
      if (v.role === 'traitor') {
        room.result = v.name + ' was banished — and they WERE a traitor!';
        say(room, v.name + ' has been banished. And ' + v.name + ' was a traitor! The circle got it right.', 'TRAITOR CAUGHT', 'good');
      } else {
        room.result = v.name + ' was banished — but they were innocent. An innocent is lost.';
        say(room, v.name + ' has been banished. ' + v.name + ' was innocent. An innocent is lost.', 'WRONG GUESS', 'bad');
      }
    }
    room.log.push(lab + room.result);
    return go(room, 'reveal');
  }
  if (ph === 'reveal') {
    const w = win(room);
    if (w) return end(room, w);
    return go(room, room.stage === 'round1' ? 'circle' : 'night');
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
    ps.slice(0, nT).forEach(p => { p.role = 'traitor'; });
    room.totalTraitors = nT; room.gameNo++; room.circleNo = 0; room.winner = null;
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
    if (!tgt) { me.vote = null; return push(room); }
    if (!tgt.alive || tgt.id === me.id) return 'Invalid vote';
    if (ph === 'round1' && me.role === 'traitor' && tgt.role === 'traitor') return 'Pick someone who is not a traitor';
    me.vote = tgt.id; return push(room);
  }
  if (a === 'kill') {
    if (ph !== 'night' || !me.alive || me.role !== 'traitor') return 'Not allowed';
    if (locked(room)) return 'Time is up — votes are locked';
    if (!tgt) { me.vote = null; return push(room); }
    if (!tgt.alive || tgt.role === 'traitor') return 'Invalid target';
    me.vote = tgt.id; return push(room);
  }
  if (a === 'settime') {
    if (me.id !== room.adminId || ph !== 'lobby') return 'Not allowed';
    for (const k of ['round1', 'circle', 'night']) { const v = Math.round(+b[k]); if (v) room.T[k] = Math.min(1800, Math.max(30, v)); }
    return push(room);
  }
  if (a === 'extend') {
    if (me.id !== room.adminId || !['round1', 'circle', 'night'].includes(ph) || !room.deadline) return 'Not allowed';
    room.deadline += 60000; room.dur += 60; clearTimeout(room.timer);
    room.timer = setTimeout(() => advance(room), room.deadline - Date.now());
    return push(room);
  }
  if (a === 'skip') {
    if (me.id !== room.adminId || !T[ph]) return 'Not allowed';
    return advance(room);
  }
  if (a === 'restart') {
    if (me.id !== room.adminId || ph !== 'over') return 'Not allowed';
    room.players.forEach(p => { p.role = 'innocent'; p.alive = true; p.vote = null; });
    room.chat = []; room.audios = {}; room.log = []; room.winner = null; room.result = null; room.tally = null; room.totalTraitors = 0; room.stage = null;
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
    const room = { code: newCode(), phase: 'lobby', stage: null, circleNo: 0, gameNo: 0, totalTraitors: 0, T: { ...T }, players: [], chat: [], audios: {}, seq: 0, log: [], deadline: 0, dur: 0, timer: null, adminId: null, tally: null, result: null, winner: null, event: { id: 0, text: '', title: '', kind: 'info' }, last: Date.now() };
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
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
  const room = rooms[(url.searchParams.get('code') || '').toUpperCase()];
  const me = room && room.players.find(p => p.token === url.searchParams.get('token'));
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!me) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (me.res) { try { me.res.end(); } catch (e) {} }
    me.res = res; room.last = Date.now();
    res.write('data: ' + JSON.stringify(view(room, me)) + '\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
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
        return send(res, 200, typeof err === 'string' ? { error: err } : { ok: true });
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
:root{--gold:#f4d27a;--red:#e0483a;--green:#3ddc84;--bg:#0b0b10;--card:#161923;--mut:#8b90a0}
body{margin:0;background:radial-gradient(1100px 560px at 50% -8%,#3d1016 0%,#0b0b10 62%) fixed;color:#ecebf2;font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;overflow-x:hidden}
.wrap{max-width:560px;margin:0 auto;padding:12px 12px 96px}
.hero{font-size:clamp(40px,13vw,58px);font-weight:900;letter-spacing:7px;text-align:center;margin:34px 0 4px;color:var(--gold);
 text-shadow:0 1px 0 #c9a24a,0 2px 0 #a8832f,0 3px 0 #8a6a22,0 4px 0 #6d5219,0 5px 0 #4d3a12,0 14px 18px rgba(0,0,0,.75);transform:perspective(520px) rotateX(16deg)}
.sub{text-align:center;color:var(--mut);margin-bottom:22px}
.card{background:linear-gradient(160deg,#1d2030,#12141c);border:1px solid #2b2f42;border-radius:18px;padding:14px;margin-bottom:12px;box-shadow:0 16px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06)}
.tilt{transform:perspective(900px) rotateX(3deg)}
label{font-size:13px;color:var(--mut);display:block;margin:2px 0 4px}
input{width:100%;padding:13px;border-radius:12px;border:1px solid #2d3246;background:#0f1118;color:#fff;font-size:16px;margin-bottom:10px;outline:none}
input:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(244,210,122,.15)}
.btn{display:block;width:100%;padding:14px;border:0;border-radius:14px;color:#fff;font-size:16px;font-weight:800;cursor:pointer;margin-bottom:12px;
 background:linear-gradient(#ee5a4b,#b52a1d);box-shadow:0 6px 0 #6e140c,0 12px 18px rgba(0,0,0,.5);transition:transform .08s,box-shadow .08s}
.btn:active{transform:translateY(5px);box-shadow:0 1px 0 #6e140c,0 4px 8px rgba(0,0,0,.5)}
.btn.alt{background:linear-gradient(#3a4057,#272b3c);box-shadow:0 6px 0 #14161f,0 12px 18px rgba(0,0,0,.5)}
.btn.alt:active{box-shadow:0 1px 0 #14161f}
.btn.gold{background:linear-gradient(#f6d77f,#c79a2c);color:#2a1d00;box-shadow:0 6px 0 #7b5a12,0 12px 18px rgba(0,0,0,.5)}
.btn.gold:active{box-shadow:0 1px 0 #7b5a12}
.btn.sm{display:inline-block;width:auto;padding:10px 16px;margin:0;font-size:14px;box-shadow:0 4px 0 #6e140c}
.btn:disabled{opacity:.45;pointer-events:none}
.ib{background:#1d2030;border:1px solid #2d3246;color:#fff;border-radius:12px;width:42px;height:42px;font-size:18px;cursor:pointer;flex:none}
.err{color:#ff8a7a;text-align:center;min-height:22px;font-size:14px}
.mut{color:var(--mut)}.sm{font-size:13px}.center{text-align:center}.row{display:flex;gap:8px;align-items:center}
#top{position:sticky;top:0;z-index:20;display:flex;gap:8px;align-items:center;padding:10px 12px;background:rgba(11,11,16,.88);backdrop-filter:blur(8px);border-bottom:1px solid #22263a}
.chip{background:#241a0a;border:1px solid #6d5219;color:var(--gold);font-weight:900;letter-spacing:4px;padding:8px 12px;border-radius:12px;cursor:pointer;font-size:16px}
#phasepill{flex:1;text-align:center;font-weight:700;font-size:14px;color:#ddd}
#nav{position:fixed;bottom:0;left:0;right:0;z-index:20;display:flex;background:rgba(14,15,22,.96);border-top:1px solid #22263a;padding-bottom:env(safe-area-inset-bottom)}
#nav button{flex:1;background:none;border:0;color:var(--mut);padding:10px 0 8px;font-size:20px;cursor:pointer;position:relative}
#nav button span{display:block;font-size:11px}#nav button.on{color:var(--gold)}
#bd{position:absolute;top:4px;right:28%;background:var(--red);color:#fff;border-radius:10px;font-size:11px;font-style:normal;padding:1px 6px;display:none}
.steps{display:flex;gap:6px;margin-bottom:10px;font-size:12px;align-items:center}
.steps div{flex:1;text-align:center;padding:7px 4px;border-radius:10px;background:#171a26;color:var(--mut);border:1px solid #262a3c}
.steps div.cur{background:linear-gradient(#5a1a14,#33100c);color:#ffb0a4;border-color:var(--red);box-shadow:0 0 14px rgba(224,72,58,.35)}
.ex .exh{display:flex;gap:12px;align-items:center;margin-bottom:8px}.exi{font-size:34px;filter:drop-shadow(0 4px 4px #000)}.ext{font-size:19px;font-weight:800;flex:1}
.exw,.exy{font-size:14px;margin-top:6px}.exy{color:#b6b9c7}
.ring{position:relative;width:62px;height:62px;flex:none}.ring svg{display:block}.rb{fill:none;stroke:#252a3d;stroke-width:6}.rf{fill:none;stroke:var(--gold);stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset .4s linear}
#rt{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}
#rt.hot{color:var(--red);animation:pulse .6s infinite alternate}
@keyframes pulse{to{transform:scale(1.15)}}
.role{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;margin-bottom:12px;font-weight:700;cursor:pointer;box-shadow:0 8px 16px rgba(0,0,0,.4)}
.role.traitor{background:linear-gradient(135deg,#5e1a14,#2b0b08);color:#ff9d8f}.role.innocent{background:linear-gradient(135deg,#17492b,#0b2315);color:#93f7b0}.role small{display:block;font-weight:500;opacity:.8}
.stats{display:flex;gap:8px;margin-bottom:8px}.stats div{flex:1;background:#151824;border:1px solid #262a3c;border-radius:12px;text-align:center;padding:8px 4px}
.stats b{display:block;font-size:22px}.stats small{color:var(--mut);font-size:11px}.stats .g b{color:var(--green)}.stats .b b{color:var(--red)}
.meter{height:10px;border-radius:6px;background:var(--red);overflow:hidden;margin:6px 0 4px;box-shadow:inset 0 2px 3px rgba(0,0,0,.5)}.meter i{display:block;height:100%;background:var(--green);transition:width .6s}
.stage3d{position:relative;width:100%;aspect-ratio:1/.8;perspective:950px;margin:2px 0 6px}
.tbl{position:absolute;left:0;top:50%;width:100%;aspect-ratio:1/1;margin-top:-50%;transform-style:preserve-3d;transform:rotateX(56deg)}
.felt{pointer-events:none;position:absolute;inset:9%;border-radius:50%;background:radial-gradient(circle at 50% 40%,#6a1a26,#2a0b10 72%);box-shadow:0 0 0 7px #3a2810,0 0 0 10px #b08a3e,0 28px 40px rgba(0,0,0,.75),inset 0 0 40px rgba(0,0,0,.6)}
.felt.night{background:radial-gradient(circle at 50% 40%,#1c2350,#080a1c 72%)}
.ctr{pointer-events:none;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:44px;transform:rotateX(-56deg);opacity:.9;filter:drop-shadow(0 6px 6px #000)}
.seat{position:absolute;transform:translate(-50%,-50%) rotateX(-56deg);transform-origin:50% 60%;text-align:center;width:70px;cursor:default}
.av{margin:0 auto;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;border:3px solid rgba(255,255,255,.25);
 box-shadow:0 8px 10px rgba(0,0,0,.6),inset 0 -5px 8px rgba(0,0,0,.35),inset 0 4px 6px rgba(255,255,255,.25);position:relative;transition:transform .15s,box-shadow .15s}
.seat.pick{cursor:pointer}.seat.pick .av{animation:bob 1.6s ease-in-out infinite}
@keyframes bob{50%{transform:translateY(-4px)}}
.seat.sel .av{transform:scale(1.28);border-color:var(--gold);box-shadow:0 0 0 4px rgba(244,210,122,.35),0 0 22px var(--gold),0 8px 10px rgba(0,0,0,.6)}
.seat.mine .av{border-color:var(--green);box-shadow:0 0 0 4px rgba(61,220,132,.3),0 8px 10px rgba(0,0,0,.6)}
.seat.me .nm{color:var(--gold)}.seat.trt .av{border-color:var(--red);box-shadow:0 0 14px var(--red),0 8px 10px rgba(0,0,0,.6)}
.seat.dead .av{filter:grayscale(1) brightness(.55)}.seat.dead .nm{text-decoration:line-through;opacity:.6}
.nm{font-size:11px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 2px 3px #000;font-weight:600}
.bdg{position:absolute;top:-6px;right:-8px;font-size:12px;background:#000c;border-radius:10px;padding:0 5px;border:1px solid #fff3}
.rl{font-size:9px;color:#ff9d8f;text-transform:uppercase;letter-spacing:1px}
.chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-height:128px;overflow:auto;margin-bottom:6px}.chips button{background:#1c2030;border:1px solid #2b3047;color:#eee;border-radius:20px;padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer}.chips button.on{border-color:var(--gold);background:#3a2a0e;color:var(--gold)}
.bar{position:sticky;bottom:64px;z-index:15}
.bar .card{border-color:#6d5219;box-shadow:0 -6px 24px rgba(0,0,0,.6),0 16px 30px rgba(0,0,0,.45)}
.res{font-size:17px;font-weight:700;text-align:center}.res small{display:block;font-weight:500;color:var(--mut);margin-top:6px;font-size:13px}
.pl{display:inline-block;background:#1c2030;border:1px solid #2b3047;border-radius:20px;padding:6px 12px;margin:3px;font-size:14px}
.codebig{font-size:44px;font-weight:900;letter-spacing:10px;color:var(--gold);text-align:center;text-shadow:0 4px 0 #6d5219,0 10px 14px #000;transform:perspective(500px) rotateX(14deg)}
.msgs{height:50vh;overflow:auto;background:#0e1017;border:1px solid #232739;border-radius:14px;padding:10px;margin:8px 0}
.m{margin-bottom:8px;max-width:86%;background:#1b1f2e;border-radius:14px 14px 14px 4px;padding:7px 10px;font-size:15px;word-wrap:break-word}
.m.mine{margin-left:auto;background:#3a2a0e;border-radius:14px 14px 4px 14px}.m.t{background:#3a1511}
.m b{display:block;font-size:12px;color:var(--gold)}.m audio{width:210px;height:34px;margin-top:3px}
.tabs{display:flex;gap:8px}.tabs button{flex:1;padding:10px;border-radius:12px;border:1px solid #2b3047;background:#161923;color:#bbb;font-weight:700;cursor:pointer}
.tabs button.on{background:#3a2a0e;color:var(--gold);border-color:#6d5219}.tabs button.on.sec{background:#3a1511;color:#ff9d8f;border-color:var(--red)}
.comp input{margin:0;flex:1}.mic.rec{background:var(--red);animation:pulse .6s infinite alternate}
.log div{padding:10px 12px;border-left:3px solid var(--gold);background:#141725;border-radius:0 10px 10px 0;margin-bottom:8px;font-size:14px}
#ann{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(0,0,0,.78);padding:24px;text-align:center;perspective:700px}
#ann.on{display:flex}#ann .at{font-size:clamp(34px,11vw,56px);font-weight:900;letter-spacing:3px;animation:slam .6s cubic-bezier(.2,1.4,.4,1);text-shadow:0 2px 0 #000,0 6px 0 #000,0 16px 24px #000}
#ann .at.bad{color:#ff6a58}#ann .at.good{color:var(--green)}#ann .at.info{color:var(--gold)}
#ann .ax{margin-top:16px;font-size:19px;max-width:420px;animation:fade .9s}
@keyframes slam{0%{transform:rotateX(80deg) scale(2.4);opacity:0}100%{transform:none;opacity:1}}@keyframes fade{from{opacity:0}}
.ov{position:fixed;inset:0;z-index:40;background:rgba(5,5,9,.93);display:none;align-items:center;justify-content:center;flex-direction:column;padding:20px;overflow:auto}.ov.on{display:flex}
.flip{perspective:900px;width:min(300px,80vw);height:400px;cursor:pointer}
.c3{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform 1s cubic-bezier(.3,1.3,.5,1)}.c3.on{transform:rotateY(180deg)}
.face{position:absolute;inset:0;backface-visibility:hidden;border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px;box-shadow:0 30px 50px rgba(0,0,0,.7)}
.front{background:linear-gradient(160deg,#3a1a22,#16080c);border:3px solid var(--gold);font-size:22px;font-weight:800;color:var(--gold)}
.back{transform:rotateY(180deg);border:3px solid #fff3}.back.traitor{background:linear-gradient(160deg,#6a1a14,#220806)}.back.innocent{background:linear-gradient(160deg,#17492b,#06170d)}
.big{font-size:30px;font-weight:900}
</style></head><body>
<div id="root"></div><div id="ann" onclick="this.classList.remove('on')"></div><div class="ov" id="roleov"></div><div class="ov" id="overov"></div>
<script>
var S=null,SES=null,es=null,off=0,tab='game',chan='all',sel=null,lastEv=null,lastMsg=-1,unread=0,muted=false,rChan=null,rendered={},rec=null,recT=null,built=false,lastKey='',annT=null;
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function ld(k){try{return JSON.parse(localStorage.getItem(k)||'null')}catch(e){return null}}
function sv(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function api(p,b){return fetch(p,{method:'POST',body:JSON.stringify(b)}).then(function(r){return r.json()})}
function setErr(m){var e=$('err');if(e){e.textContent=m;if(m)setTimeout(function(){if(e.textContent===m)e.textContent=''},4000)}}
function act(type,x){if(!SES)return;var b={type:type,code:SES.code,token:SES.token};for(var k in x||{})b[k]=x[k];return api('/api/act',b).then(function(r){if(r.error)setErr(r.error)}).catch(function(){setErr('Connection problem')})}
function secs(){return S&&S.deadline?Math.max(0,Math.ceil((S.deadline-(Date.now()+off))/1000)):0}
function fmt(s){return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
function hue(n){var h=0;for(var i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))%360;return h}
function speak(t){if(muted||!window.speechSynthesis)return;try{speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(t);u.rate=.9;u.pitch=.7;u.volume=1;var v=speechSynthesis.getVoices().filter(function(x){return /^en/i.test(x.lang)})[0];if(v)u.voice=v;speechSynthesis.speak(u)}catch(e){}}
function unlockSpeech(){try{speechSynthesis.speak(new SpeechSynthesisUtterance(''))}catch(e){}}

/* ---------- login ---------- */
function showLogin(msg){
  if(es){es.close();es=null}built=false;SES=null;S=null;
  var u=ld('tr_user')||{},qc=(location.search.match(/[?&]code=([A-Za-z]{5})/)||[])[1]||'';
  $('root').innerHTML='<div class="wrap"><div class="hero">TRAITOR</div><div class="sub">Trust no one. Find the traitors.</div>'+
  '<div class="card tilt"><label>Your name</label><input id="n" maxlength="16" placeholder="e.g. Rahul" value="'+esc(u.name||'')+'">'+
  '<label>Phone number (your account — use the same one to come back)</label><input id="ph" type="tel" inputmode="numeric" maxlength="14" placeholder="10-digit mobile number" value="'+esc(u.phone||'')+'">'+
  '<label>Game code (not needed if you are returning)</label><input id="cd" maxlength="5" placeholder="ABCDE" style="text-transform:uppercase;letter-spacing:6px;text-align:center;font-weight:800" value="'+esc(qc)+'">'+
  '<button class="btn" id="go">Join / Resume game</button><button class="btn alt" id="mk">Create game (admin only)</button><div class="err" id="err">'+esc(msg||'')+'</div></div></div>';
  $('go').onclick=function(){doLogin(false)};$('mk').onclick=function(){doLogin(true)};
}
function doLogin(create,silent){
  unlockSpeech();
  var n=$('n')?$('n').value:'',ph=$('ph')?$('ph').value:'',cd=$('cd')?$('cd').value:'';
  return api('/api/login',{name:n,phone:ph,code:cd,create:create}).then(function(r){
    if(r.error)return showLogin(silent?'':r.error);
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
  $('root').innerHTML='<header id="top"><button class="chip" id="codechip" data-a="share">-----</button><div id="phasepill"></div><button class="ib" id="mute">🔊</button><button class="ib" id="lo">⎋</button></header>'+
  '<div class="wrap"><section id="t-game"></section>'+
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
function updBadge(){var b=$('bd');b.style.display=unread?'block':'none';b.textContent=unread}

/* ---------- connect ---------- */
function connect(){
  if(es)es.close();if(!built)build();lastEv=null;lastMsg=-1;rChan=null;
  es=new EventSource('/api/events?code='+SES.code+'&token='+SES.token);
  es.onmessage=function(e){handle(JSON.parse(e.data))};
  es.onerror=function(){if(es&&es.readyState===2){var u=ld('tr_user')||{};if(u.auto)autoLogin();else showLogin()}};
}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&SES&&(!es||es.readyState===2))autoLogin()});
function handle(d){
  S=d;off=d.now-Date.now();
  if(lastEv===null)lastEv=d.event.id;else if(d.event.id!==lastEv){lastEv=d.event.id;announce(d.event)}
  var mx=lastMsg;d.chat.forEach(function(m){if(m.id>mx){if(lastMsg>=0&&tab!=='chat'&&m.name!==d.me.name)unread++;mx=m.id}});lastMsg=mx;updBadge();
  var key=d.stage+d.phase+d.circleNo;if(key!==lastKey){lastKey=key;sel=null}
  updTop();updGame();updChat();updLog();checkRole();checkOver();
}
function announce(e){
  var a=$('ann');a.innerHTML='<div class="at '+esc(e.kind)+'">'+esc(e.title)+'</div><div class="ax">'+esc(e.text)+'</div>';a.classList.add('on');
  clearTimeout(annT);annT=setTimeout(function(){a.classList.remove('on')},5500);speak(e.text);
}

/* ---------- views ---------- */
var PN={lobby:'🏰 Gathering',round1:'🗣 Round 1',circle:'⚖️ Circle of Doubt',reveal:'📜 The Verdict',night:'🌙 Killing Round',dawn:'🌅 Dawn',over:'🏁 Game Over'};
function updTop(){$('codechip').textContent=S.code;$('phasepill').textContent=PN[S.phase]}
function explain(){
  var p=S.phase,r=S.me.role,t=r==='traitor',al=S.me.alive;
  if(p==='lobby')return{i:'🏰',t:'Gathering the circle',w:'Share the game code so friends can join. The admin starts the game once at least '+S.minPlayers+' players are in.',y:'Traitors are chosen in secret: 1 traitor for up to 7 players, 2 for 8–13, and 3 for 14 or more.'};
  if(p==='over')return{i:'🏁',t:S.winner==='traitors'?'The traitors win':'The innocents win',w:'See everyone\'s true role below. The admin can start a new game.',y:S.winner==='traitors'?'The traitors now equal the innocents, so they control every vote.':'Every traitor was found and removed.'};
  if(!al&&p!=='reveal'&&p!=='dawn')return{i:'👻',t:'You are out',w:'You can watch and read the chat, but you can no longer talk or vote.',y:'Out players keep watching so they can see how the game ends.'};
  if(p==='round1')return t?{i:'🗡',t:'Round 1 · The First Whisper',w:'Use the 🗡 Secret chat with your partner(s). Each traitor should vote for a DIFFERENT innocent so it does not look planned. Only traitor votes decide who leaves this round; ties are random.',y:'Because only your votes count, nobody can tell who the real traitors are. You can change your vote until the timer ends.'}:
   {i:'🗣',t:'Round 1 · The First Whisper',w:'Chat (or talk in person) and vote for who you suspect. You can change your vote until the timer ends. The most-voted player leaves the game.',y:'Traitors are hiding among you. Watch who stays quiet or accuses too fast.'};
  if(p==='circle')return t?{i:'⚖️',t:'Circle of Doubt',w:'Blend in. Steer the vote toward an innocent — or sacrifice a partner to look honest. Votes are secret.',y:'Every innocent banished brings you closer to equal numbers, which is a traitor win.'}:
   {i:'⚖️',t:'Circle of Doubt',w:'Vote for who you think is a traitor. Votes are secret and you can change yours until the timer ends.',y:'Hit a traitor and they are out. Miss, and an innocent is banished instead.'};
  if(p==='night')return t&&al?{i:'🌙',t:'Killing Round',w:'Pick one innocent to eliminate. Most traitor votes dies; ties are random. Change your vote until the timer ends.',y:'Traitors win when they equal the innocents.'}:
   {i:'🌙',t:'Night falls',w:'Everyone sleeps. The traitors are secretly choosing a victim. No chat or voting for you right now.',y:'At dawn the victim is announced.'};
  if(p==='reveal')return{i:'📜',t:'The verdict',w:'See the result of the vote below. The next phase starts automatically.',y:'Everyone learns whether the circle guessed right.'};
  return{i:'🌅',t:'Dawn',w:'See what happened in the night. The next Circle of Doubt starts automatically.',y:'Traitors win when they equal the innocents; innocents win when all traitors are out.'};
}
function ringHTML(){if(!S.deadline)return'';var s=secs(),f=S.dur?s/S.dur:0,C=2*Math.PI*24;
  return'<div class="ring"><svg width="62" height="62" viewBox="0 0 62 62"><circle cx="31" cy="31" r="24" class="rb"/><circle id="rg" cx="31" cy="31" r="24" class="rf" stroke-dasharray="'+C+'" stroke-dashoffset="'+(C*(1-f))+'" transform="rotate(-90 31 31)"/></svg><span id="rt">'+fmt(s)+'</span></div>'}
setInterval(function(){if(!S||!S.deadline)return;var s=secs(),rt=$('rt'),rg=$('rg');if(rt){rt.textContent=fmt(s);rt.className=s<=10?'hot':''}if(rg){var C=2*Math.PI*24;rg.setAttribute('stroke-dashoffset',C*(1-(S.dur?s/S.dur:0)))}},300);
function pById(id){return S.players.filter(function(x){return x.id===id})[0]}
function canPick(p){var me=S.me,ph=S.phase;if(!me.alive||!p.alive||p.id===me.id)return false;
  if(ph==='circle')return true;if(ph==='round1')return !(me.role==='traitor'&&p.role==='traitor');
  if(ph==='night')return me.role==='traitor'&&p.role!=='traitor';return false}
function seatHTML(p,i,n){
  var ang=i/n*2*Math.PI-Math.PI/2,x=50+43*Math.cos(ang),y=50+43*Math.sin(ang),sz=n>14?34:n>9?40:46,me=S.me;
  var cp=canPick(p),cls='seat'+(p.alive?'':' dead')+(p.id===me.id?' me':'')+(cp?' pick':'')+(sel===p.id?' sel':'')+(me.vote===p.id?' mine':'')+(p.role==='traitor'&&p.id!==me.id?' trt':'');
  var cnt=0;(S.team||[]).forEach(function(t){if(t.target===p.id)cnt++});
  var bd=!p.alive?'<span class="bdg">✝</span>':me.vote===p.id?'<span class="bdg">✔</span>':cnt?'<span class="bdg">🗡'+cnt+'</span>':'';
  var rl=p.role&&(!p.alive||S.phase==='over'||(p.role==='traitor'&&p.id!==me.id))?'<div class="rl">'+p.role+'</div>':'';
  return'<div class="'+cls+'" style="left:'+x+'%;top:'+y+'%" '+(cp?'data-a="pick" data-id="'+p.id+'"':'')+'><div class="av" style="width:'+sz+'px;height:'+sz+'px;font-size:'+(sz*.42)+'px;background:radial-gradient(circle at 35% 30%,hsl('+hue(p.name)+',65%,60%),hsl('+hue(p.name)+',60%,28%))">'+esc(p.name.charAt(0).toUpperCase())+bd+'</div><div class="nm">'+esc(p.name)+(p.id===me.id?' (you)':'')+'</div>'+rl+'</div>';
}
function updGame(){
  var me=S.me,p=S.phase,c=S.counts,inn=c.alive-c.traitorsLeft,ex=explain(),h='';var keep={},fid=document.activeElement&&document.activeElement.id;['tm1','tm2','tm3'].forEach(function(i){var e=$(i);if(e)keep[i]=e.value});
  if(p!=='lobby'&&p!=='over'){var st=S.stage;h+='<div class="steps"><div class="'+(st==='round1'?'cur':'')+'">1 · Round 1</div><div class="'+(st==='circle'?'cur':'')+'">⚖️ Circle</div><div class="'+(st==='night'?'cur':'')+'">🌙 Killing</div><span class="mut">↻</span></div>'}
  h+='<div class="card ex"><div class="exh"><span class="exi">'+ex.i+'</span><div class="ext">'+esc(ex.t)+'</div>'+ringHTML()+'</div><div class="exw"><b>What to do:</b> '+ex.w+'</div><div class="exy"><b>Why:</b> '+ex.y+'</div></div>';
  if(me.role&&p!=='lobby'){var mates=S.players.filter(function(x){return x.role==='traitor'&&x.id!==me.id}).map(function(x){return x.name});
    h+='<div class="role '+me.role+'" data-a="rolecard"><span style="font-size:28px">'+(me.role==='traitor'?'🗡':'🛡')+'</span><div>You are '+(me.role==='traitor'?'a TRAITOR':'INNOCENT')+(me.alive?'':' (out)')+'<small>'+(me.role==='traitor'?(mates.length?'Partner'+(mates.length>1?'s':'')+': '+esc(mates.join(', ')):'You are the only traitor'):'Find the traitors and vote them out')+'</small></div></div>'}
  if(p!=='lobby'){
    h+='<div class="stats"><div><b>'+c.alive+'</b><small>Alive</small></div><div class="g"><b>'+inn+'</b><small>Innocents</small></div><div class="b"><b>'+c.traitorsLeft+'</b><small>Traitors left</small></div></div>'+
    '<div class="meter"><i style="width:'+(c.alive?inn/c.alive*100:0)+'%"></i></div><div class="mut sm center">Traitors win when they equal the innocents ('+c.traitorsLeft+' vs '+inn+'). Innocents win when no traitor is left. '+c.totalTraitors+' traitor'+(c.totalTraitors>1?'s':'')+' started in this game.</div>';
  }
  if(p==='lobby'){
    h+='<div class="card tilt center"><div class="mut sm">GAME CODE</div><div class="codebig">'+S.code+'</div><div class="row" style="margin-top:12px"><button class="btn gold sm" data-a="share" style="flex:1">📤 Share</button><button class="btn alt sm" data-a="wa" style="flex:1">WhatsApp</button><button class="btn alt sm" data-a="copy" style="flex:1">Copy</button></div></div>'+
    '<div class="card"><div class="mut sm" style="margin-bottom:6px">Players joined ('+S.players.length+')</div>'+S.players.map(function(x){return'<span class="pl">'+esc(x.name)+(x.id===me.id?' (you)':'')+'</span>'}).join('')+'</div>';
    h+='<div class="card"><div class="mut sm" style="margin-bottom:8px">Round timers (minutes)'+(me.admin?'':' — set by admin')+'</div><div class="row">'+[['tm1','Round 1',S.times.round1],['tm2','Circle',S.times.circle],['tm3','Killing',S.times.night]].map(function(x){return'<div style="flex:1"><label>'+x[1]+'</label><input id="'+x[0]+'" type="number" step="0.5" min="0.5" max="30" value="'+(x[2]/60)+'"'+(me.admin?'':' disabled')+' style="margin:0;text-align:center"></div>'}).join('')+'</div>'+(me.admin?'<button class="btn alt" style="margin:10px 0 0;padding:10px" data-a="settime">Save timers</button>':'')+'</div>';
    h+=me.admin?'<button class="btn" data-a="start"'+(S.players.length<S.minPlayers?' disabled':'')+'>▶ Start game ('+(S.players.length<S.minPlayers?'need '+S.minPlayers+'+ players':S.players.length+' players')+')</button>':'<div class="card center mut">Waiting for the admin to start...</div>';
  }else{
    var n=S.players.length,ic={round1:'🗣',circle:'⚖️',reveal:'📜',night:'🌙',dawn:'🌅',over:'🏁'}[p];
    h+='<div class="stage3d"><div class="tbl"><div class="felt'+(p==='night'||(p==='dawn')?' night':'')+'"></div>'+S.players.map(function(x,i){return seatHTML(x,i,n)}).join('')+'<div class="ctr">'+ic+'</div></div></div>';
    if(S.voteStat&&(p==='round1'||p==='circle'||(p==='night'&&me.role==='traitor')))h+='<div class="mut sm center">'+S.voteStat.voted+' of '+S.voteStat.total+(p==='night'?' traitors have':' players have')+' voted</div>';
    if((p==='reveal'||p==='dawn')&&S.result){h+='<div class="card res">'+esc(S.result)+(S.tally&&S.tally.length&&p==='reveal'?'<small>Votes: '+S.tally.map(function(t){return esc(t.name)+' ('+t.count+')'}).join(' · ')+'</small>':'')+'</div>'}
    if(p==='over'){h+='<div class="card res">'+(S.winner==='traitors'?'🗡 The traitors win!':'🛡 The innocents win!')+'<small>'+S.players.map(function(x){return esc(x.name)+': '+x.role}).join(' · ')+'</small></div>'}
    var vp=(p==='round1'||p==='circle'||(p==='night'&&me.role==='traitor'))&&me.alive;
    if(vp){var night=p==='night',cur=me.vote?pById(me.vote):null,sp=sel?pById(sel):null;
      h+='<div class="bar"><div class="card center">'+(cur?'Your vote: <b>'+esc(cur.name)+'</b> ✔':'<span class="mut">No vote yet — tap a name below</span>');h+='<div class="chips" style="margin-top:8px">'+S.players.filter(canPick).map(function(x){return'<button class="'+(sel===x.id?'on':'')+'" data-a="pick" data-id="'+x.id+'">'+esc(x.name)+(me.vote===x.id?' ✔':'')+'</button>'}).join('')+'</div>';
      if(sp&&canPick(sp))h+='<button class="btn" style="margin:10px 0 0" data-a="'+(night?'kill':'vote')+'" data-id="'+sp.id+'">'+(night?'🗡 Kill ':'🗳 Vote for ')+esc(sp.name)+'</button>';
      if(cur)h+='<button class="btn alt" style="margin:10px 0 0;padding:10px" data-a="clear">Remove my vote</button>';
      h+='<div class="mut sm" style="margin-top:6px">'+(night?'Locks when the timer ends.':'Secret. You can change it until the timer ends.')+'</div></div></div>';
    }
    if(me.admin&&p==='over')h+='<button class="btn gold" data-a="again">🔄 Play again (same players)</button>';
    if(me.admin&&T_OK[p]){h+='<div class="row">'+((p==='round1'||p==='circle'||p==='night')?'<button class="btn alt" data-a="extend" style="padding:10px;font-size:14px">➕ +1 min</button>':'')+'<button class="btn alt" data-a="skip" style="padding:10px;font-size:14px">⏭ End timer now</button></div>'}
  }
  $('t-game').innerHTML=h;for(var k in keep){var e2=$(k);if(e2&&!e2.disabled&&keep[k]!=='')e2.value=keep[k]}if(fid&&keep[fid]!==undefined&&$(fid))$(fid).focus();
}
var T_OK={round1:1,circle:1,reveal:1,night:1,dawn:1};
function onGameClick(e){
  var b=e.target.closest('[data-a]');if(!b)return;var a=b.getAttribute('data-a'),id=b.getAttribute('data-id');
  if(a==='pick'){sel=id;updGame()}
  else if(a==='vote'){act('vote',{target:id})}
  else if(a==='kill'){act('kill',{target:id})}
  else if(a==='clear'){act(S.phase==='night'?'kill':'vote',{target:null})}
  else if(a==='settime'){act('settime',{round1:Math.round(parseFloat($('tm1').value)*60),circle:Math.round(parseFloat($('tm2').value)*60),night:Math.round(parseFloat($('tm3').value)*60)})}else if(a==='extend')act('extend');else if(a==='start')act('start');else if(a==='skip')act('skip');else if(a==='again')act('restart');
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
  '<div class="card" style="width:min(360px,100%)">'+S.players.map(function(x){return'<div class="row" style="justify-content:space-between;padding:5px 0"><span>'+esc(x.name)+(x.alive?'':' ✝')+'</span><b style="color:'+(x.role==='traitor'?'#ff8a7a':'#8aff9e')+'">'+x.role+'</b></div>'}).join('')+'</div><button class="btn gold" style="max-width:300px" id="ovk">See full results</button>';
  o.classList.add('on');setTimeout(function(){var b=$('ovk');if(b)b.onclick=function(){o.classList.remove('on')}},0);
}

/* ---------- log ---------- */
function updLog(){$('t-log').innerHTML='<div class="log">'+(S.log.length?S.log.slice().reverse().map(function(l){return'<div>'+esc(l)+'</div>'}).join(''):'<div class="mut">Nothing has happened yet.</div>')+'</div>'}

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
  $('note').textContent=ok?(chan==='traitor'?'Only traitors can see this chat.':''):(!me.alive?'You are out — you can read but not chat.':'Everyone sleeps during the killing round.');
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
