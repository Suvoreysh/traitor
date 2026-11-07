// Traitor — online social deduction game. Single file, zero dependencies.
// Run:  node server.js   (PORT env optional, default 3000)  → open http://localhost:3000
const http = require('http'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const T = { discuss: 180, vote: 60, reveal: 10, night: 45, dawn: 10 }; // seconds
const MIN_PLAYERS = 3;
const rooms = {};

const rnd = n => Math.floor(Math.random() * n);
const uid = () => crypto.randomBytes(8).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const newCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 5; i++) s += c[rnd(c.length)]; } while (rooms[s]); return s; };

function addPlayer(room, name) {
  const p = { id: uid(), token: uid(), name, role: 'innocent', alive: true, ready: false, vote: null, res: null };
  room.players.push(p); return p;
}
const alive = r => r.players.filter(p => p.alive);
const find = (r, id) => r.players.find(p => p.id === id);

function view(room, me) {
  const over = room.phase === 'over', lobby = room.phase === 'lobby', isT = me.role === 'traitor' && !lobby;
  return {
    now: Date.now(), code: room.code, phase: room.phase, round: room.round, deadline: room.deadline, winner: room.winner,
    me: { id: me.id, role: lobby ? null : me.role, admin: me.id === room.adminId, alive: me.alive, vote: me.vote },
    players: room.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive, ready: p.ready, voted: p.vote != null,
      role: !lobby && (over || !p.alive || p.id === me.id || (isT && p.role === 'traitor')) ? p.role : null
    })),
    chat: room.chat.filter(m => m.ch === 'all' || (m.ch === 'traitor' && isT)).slice(-100),
    tally: room.tally, result: room.result,
    nightVotes: isT && room.phase === 'night' ? room.nightVotes : null,
    protect: me.role === 'warden' && room.phase === 'night' ? room.protect : null
  };
}
function push(room) {
  for (const p of room.players) if (p.res) p.res.write('data: ' + JSON.stringify(view(room, p)) + '\n\n');
}
function go(room, phase) {
  clearTimeout(room.timer);
  room.phase = phase;
  const secs = T[phase];
  room.deadline = secs ? Date.now() + secs * 1000 : 0;
  if (phase === 'discuss') { room.players.forEach(p => { p.ready = false; p.vote = null; }); room.tally = null; room.result = null; }
  if (phase === 'vote') { room.players.forEach(p => { p.vote = null; }); }
  if (phase === 'night') { room.nightVotes = {}; room.protect = null; room.result = null; room.tally = null; }
  if (secs) room.timer = setTimeout(() => advance(room), secs * 1000);
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
  room.winner = w; room.phase = 'over'; room.deadline = 0; push(room);
}
function top(counts) {
  let max = 0, ids = [];
  for (const [id, c] of Object.entries(counts)) { if (c > max) { max = c; ids = [id]; } else if (c === max) ids.push(id); }
  return { max, ids };
}
function advance(room) {
  const ph = room.phase;
  if (ph === 'discuss') return go(room, 'vote');
  if (ph === 'vote') {
    const counts = {};
    alive(room).forEach(p => { if (p.vote) counts[p.vote] = (counts[p.vote] || 0) + 1; });
    room.tally = Object.entries(counts).map(([id, c]) => ({ name: find(room, id).name, count: c })).sort((a, b) => b.count - a.count);
    const { max, ids } = top(counts);
    if (!max || ids.length > 1) room.result = 'The Circle of Doubt is split — nobody is banished.';
    else {
      const v = find(room, ids[0]); v.alive = false;
      room.result = v.name + ' is banished from the circle. They were ' + (v.role === 'traitor' ? 'a TRAITOR!' : 'not a traitor (' + v.role + ').');
    }
    return go(room, 'reveal');
  }
  if (ph === 'reveal') { const w = win(room); return w ? end(room, w) : go(room, 'night'); }
  if (ph === 'night') {
    const counts = {};
    Object.values(room.nightVotes).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
    const { max, ids } = top(counts);
    if (!max) room.result = 'The traitors stayed silent. Everyone survives the night.';
    else {
      const id = ids[rnd(ids.length)];
      if (room.protect === id) room.result = 'The Warden\'s protection held — nobody died tonight.';
      else { const v = find(room, id); v.alive = false; room.result = v.name + ' was murdered in the night. They were ' + v.role + '.'; }
    }
    return go(room, 'dawn');
  }
  if (ph === 'dawn') {
    const w = win(room);
    if (w) return end(room, w);
    room.round++; return go(room, 'discuss');
  }
}
function checkEarly(room) {
  const a = alive(room);
  if (room.phase === 'discuss' && a.every(p => p.ready)) return advance(room);
  if (room.phase === 'vote' && a.every(p => p.vote)) return advance(room);
  if (room.phase === 'night') {
    const ts = a.filter(p => p.role === 'traitor'), w = a.find(p => p.role === 'warden');
    if (ts.every(p => room.nightVotes[p.id]) && (!w || room.protect)) return advance(room);
  }
  push(room);
}

function act(room, me, b) {
  const a = b.type, ph = room.phase;
  const tgt = find(room, b.target);
  if (a === 'start') {
    if (me.id !== room.adminId || ph !== 'lobby') return 'Not allowed';
    if (room.players.length < MIN_PLAYERS) return 'Need at least ' + MIN_PLAYERS + ' players';
    const ps = shuffle(room.players.slice()), n = ps.length, nT = n < 6 ? 1 : 2;
    room.players.forEach(p => { p.role = 'innocent'; p.alive = true; });
    ps.slice(0, nT).forEach(p => p.role = 'traitor');
    if (n >= 4) ps[nT].role = 'warden';
    room.round = 1; room.winner = null; room.chat = [];
    return go(room, 'discuss');
  }
  if (a === 'chat') {
    const text = String(b.text || '').trim().slice(0, 300);
    if (!text || (ph !== 'lobby' && !me.alive)) return 'Cannot chat';
    const ch = b.ch === 'traitor' && me.role === 'traitor' && ph !== 'lobby' ? 'traitor' : 'all';
    room.chat.push({ ch, name: me.name, text, t: Date.now() });
    return push(room);
  }
  if (a === 'ready') { if (ph !== 'discuss' || !me.alive) return 'Not allowed'; me.ready = !me.ready; return checkEarly(room); }
  if (a === 'skip') { if (me.id !== room.adminId || ph !== 'discuss') return 'Not allowed'; return advance(room); }
  if (a === 'vote') {
    if (ph !== 'vote' || !me.alive || !tgt || !tgt.alive || tgt.id === me.id) return 'Invalid vote';
    me.vote = tgt.id; return checkEarly(room);
  }
  if (a === 'kill') {
    if (ph !== 'night' || !me.alive || me.role !== 'traitor' || !tgt || !tgt.alive || tgt.role === 'traitor') return 'Invalid target';
    room.nightVotes[me.id] = tgt.id; return checkEarly(room);
  }
  if (a === 'protect') {
    if (ph !== 'night' || !me.alive || me.role !== 'warden' || !tgt || !tgt.alive) return 'Invalid target';
    room.protect = tgt.id; return checkEarly(room);
  }
  if (a === 'restart') {
    if (me.id !== room.adminId || ph !== 'over') return 'Not allowed';
    room.players.forEach(p => { p.role = 'innocent'; p.alive = true; p.ready = false; p.vote = null; });
    room.chat = []; room.winner = null; room.result = null; room.tally = null; room.round = 0;
    return go(room, 'lobby');
  }
  return 'Unknown action';
}

// ---------- HTTP ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 16);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms[(url.searchParams.get('code') || '').toUpperCase()];
    const me = room && room.players.find(p => p.token === url.searchParams.get('token'));
    if (!me) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    me.res = res;
    res.write('data: ' + JSON.stringify(view(room, me)) + '\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); if (me.res === res) me.res = null; });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body = ''; req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'Bad JSON' }); }
      if (url.pathname === '/api/create') {
        const name = cleanName(b.name); if (!name) return send(res, 400, { error: 'Enter a name' });
        const room = { code: newCode(), phase: 'lobby', round: 0, players: [], chat: [], deadline: 0, timer: null, adminId: null, nightVotes: {}, protect: null, tally: null, result: null, winner: null };
        rooms[room.code] = room;
        const p = addPlayer(room, name); room.adminId = p.id;
        return send(res, 200, { code: room.code, token: p.token });
      }
      if (url.pathname === '/api/join') {
        const room = rooms[String(b.code || '').toUpperCase().trim()], name = cleanName(b.name);
        if (!room) return send(res, 404, { error: 'Game not found' });
        if (!name) return send(res, 400, { error: 'Enter a name' });
        if (room.phase !== 'lobby') return send(res, 400, { error: 'Game already started' });
        if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'Name taken' });
        const p = addPlayer(room, name); push(room);
        return send(res, 200, { code: room.code, token: p.token });
      }
      if (url.pathname === '/api/act') {
        const room = rooms[String(b.code || '').toUpperCase()];
        const me = room && room.players.find(p => p.token === b.token);
        if (!me) return send(res, 404, { error: 'Session expired' });
        const err = act(room, me, b);
        return send(res, 200, typeof err === 'string' ? { error: err } : { ok: true });
      }
      send(res, 404, { error: 'Not found' });
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log('Traitor running on http://localhost:' + PORT));

setInterval(() => { // drop abandoned rooms
  for (const [c, r] of Object.entries(rooms)) if (!r.players.some(p => p.res) && Date.now() - (r.last || 0) > 6e5) { clearTimeout(r.timer); delete rooms[c]; }
}, 6e4);
setInterval(() => { for (const r of Object.values(rooms)) if (r.players.some(p => p.res)) r.last = Date.now(); }, 3e4);

// ---------- Client ----------
const HTML = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Traitor</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0d0f14;color:#e8e8ee;font:16px system-ui,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:14px}h1{font-size:34px;margin:30px 0 4px;text-align:center;letter-spacing:4px}
.sub{text-align:center;color:#8b90a0;margin-bottom:24px}
input{width:100%;padding:13px;border-radius:10px;border:1px solid #2a2e3b;background:#161923;color:#fff;font-size:16px;margin-bottom:10px}
button{padding:13px 16px;border:0;border-radius:10px;background:#c0392b;color:#fff;font-size:16px;font-weight:600;cursor:pointer;width:100%;margin-bottom:8px}
button.alt{background:#2a2e3b}button.sm{width:auto;padding:8px 12px;font-size:14px;margin:0}button:disabled{opacity:.4}
.card{background:#161923;border-radius:14px;padding:14px;margin-bottom:12px}
.top{display:flex;justify-content:space-between;align-items:center}.code{font-size:26px;font-weight:800;letter-spacing:6px;color:#f1c40f}
.timer{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.role{padding:10px 14px;border-radius:12px;font-weight:700;text-align:center;margin-bottom:12px}
.r-traitor{background:#5a1a14;color:#ff8a7a}.r-warden{background:#14405a;color:#7ac8ff}.r-innocent{background:#1a4a2a;color:#8aff9e}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pl{padding:11px;border-radius:10px;background:#1f2330;border:2px solid transparent;font-size:15px;text-align:left;margin:0;width:100%;color:#e8e8ee;font-weight:500}
.pl.dead{opacity:.35;text-decoration:line-through}.pl.sel{border-color:#f1c40f}.pl small{display:block;color:#8b90a0;font-size:12px}
.msgs{height:180px;overflow:auto;background:#10131a;border-radius:10px;padding:8px;margin-bottom:8px;font-size:14px}
.msgs b{color:#f1c40f}.msgs .t b{color:#ff8a7a}.row{display:flex;gap:8px}.row input{margin:0}.row button{width:auto;margin:0}
.big{font-size:20px;font-weight:700;margin:6px 0}.mut{color:#8b90a0;font-size:14px}.err{color:#ff8a7a;min-height:20px;text-align:center}
</style></head><body><div class="wrap" id="app"></div>
<script>
var S=null,ses=null,es=null,offset=0,ch='all',app=document.getElementById('app');
try{ses=JSON.parse(sessionStorage.getItem('ses')||'null')}catch(e){}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(path,body){return fetch(path,{method:'POST',body:JSON.stringify(body)}).then(function(r){return r.json()})}
function act(type,extra){var b=Object.assign({type:type,code:ses.code,token:ses.token},extra||{});return api('/api/act',b).then(function(r){if(r.error)setErr(r.error)})}
function setErr(m){var e=document.getElementById('err');if(e)e.textContent=m}
function connect(){
  if(es)es.close();
  es=new EventSource('/api/events?code='+ses.code+'&token='+ses.token);
  es.onmessage=function(e){S=JSON.parse(e.data);offset=S.now-Date.now();render()};
  es.onerror=function(){if(es.readyState===2){sessionStorage.removeItem('ses');ses=null;S=null;home()}};
}
function home(msg){
  app.innerHTML='<h1>TRAITOR</h1><div class="sub">Trust no one.</div><div class="card"><input id="n" maxlength="16" placeholder="Your name"><button id="c">Create game (you are admin)</button></div>'+
  '<div class="card"><input id="j" maxlength="5" placeholder="Game code" style="text-transform:uppercase;letter-spacing:4px;text-align:center"><button class="alt" id="jb">Join game</button></div><div class="err" id="err">'+(msg||'')+'</div>';
  var go=function(path,extra){api(path,Object.assign({name:document.getElementById('n').value},extra||{})).then(function(r){
    if(r.error)return setErr(r.error);ses={code:r.code,token:r.token};sessionStorage.setItem('ses',JSON.stringify(ses));connect()})};
  document.getElementById('c').onclick=function(){go('/api/create')};
  document.getElementById('jb').onclick=function(){go('/api/join',{code:document.getElementById('j').value})};
}
function secs(){return S.deadline?Math.max(0,Math.ceil((S.deadline-(Date.now()+offset))/1000)):0}
function fmt(s){return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
var LABEL={lobby:'Lobby',discuss:'Round discussion',vote:'Circle of Doubt',reveal:'The verdict',night:'Night falls',dawn:'Dawn',over:'Game over'};
function render(){
  if(!S)return;var p=S.phase,me=S.me,h='',myP=S.players.filter(function(x){return x.id===me.id})[0];
  h+='<div class="card top"><div><div class="mut">Game code</div><div class="code">'+S.code+'</div></div><div style="text-align:right"><div class="mut">'+LABEL[p]+(S.round?' · R'+S.round:'')+'</div><div class="timer" id="tm">'+(S.deadline?fmt(secs()):'')+'</div></div></div>';
  if(me.role){var nm={traitor:'You are a TRAITOR',warden:'You are the WARDEN — protect one player each night',innocent:'You are INNOCENT'}[me.role];
    var mates=S.players.filter(function(x){return x.role==='traitor'&&x.id!==me.id}).map(function(x){return x.name});
    h+='<div class="role r-'+me.role+'">'+nm+(me.role==='traitor'&&mates.length?'<div class="mut">Fellow traitor: '+esc(mates.join(', '))+'</div>':'')+'</div>'}
  if(!me.alive&&p!=='lobby'&&p!=='over')h+='<div class="card mut">You are out. Spectating.</div>';
  var pick=null,canPick=false;
  if(p==='vote'&&me.alive){canPick=true;pick='vote'}
  if(p==='night'&&me.alive&&me.role==='traitor'){canPick=true;pick='kill'}
  if(p==='night'&&me.alive&&me.role==='warden'){canPick=true;pick='protect'}
  var instr={lobby:'Share the code. Waiting for the admin to start ('+S.players.length+' joined).',
    discuss:'Ask questions in chat, by voice, or in person. When everyone confirms, voting starts (max 3 min).',
    vote:'Banish someone. Most votes leaves the game.',reveal:'',dawn:'',night:me.role==='traitor'?'Choose a victim (non-traitors only).':me.role==='warden'?'Choose who to protect tonight.':'Close your eyes. The traitors are choosing...',over:''}[p];
  if(instr)h+='<div class="card">'+instr+'</div>';
  if((p==='reveal'||p==='dawn')&&S.result)h+='<div class="card big">'+esc(S.result)+'</div>';
  if(p==='reveal'&&S.tally&&S.tally.length)h+='<div class="card mut">Votes: '+S.tally.map(function(t){return esc(t.name)+' ('+t.count+')'}).join(' · ')+'</div>';
  if(p==='over')h+='<div class="card big" style="text-align:center">'+(S.winner==='traitors'?'The TRAITORS win!':'The INNOCENTS win!')+'</div>';
  h+='<div class="card"><div class="grid">';
  S.players.forEach(function(x){
    var sel=false,sub='';
    if(pick==='vote'&&me.vote===x.id)sel=true;
    if(pick==='protect'&&S.protect===x.id)sel=true;
    if(pick==='kill'&&S.nightVotes){var vs=Object.keys(S.nightVotes).filter(function(k){return S.nightVotes[k]===x.id}).length;if(vs)sub='🗡 '+vs;sel=S.nightVotes[me.id]===x.id}
    if(x.role)sub+=(sub?' · ':'')+x.role;
    if(p==='discuss'&&x.alive&&x.ready)sub+=(sub?' · ':'')+'✓ ready';
    if(p==='vote'&&x.alive&&x.voted)sub+=(sub?' · ':'')+'voted';
    var ok=canPick&&x.alive&&x.id!==me.id&&!(pick==='kill'&&x.role==='traitor')||(pick==='protect'&&x.alive);
    h+='<button class="pl'+(x.alive?'':' dead')+(sel?' sel':'')+'" data-id="'+x.id+'"'+(ok?'':' disabled')+'>'+esc(x.name)+(x.id===me.id?' (you)':'')+(sub?'<small>'+sub+'</small>':'')+'</button>';
  });
  h+='</div></div>';
  if(p==='lobby'&&me.admin)h+='<button id="start"'+(S.players.length<3?' disabled':'')+'>Start game ('+(S.players.length<3?'need 3+':S.players.length+' players')+')</button>';
  if(p==='discuss'&&me.alive){h+='<button id="ready" class="'+(myP.ready?'alt':'')+'">'+(myP.ready?'Cancel ready':"I'm ready to vote")+'</button>';if(me.admin)h+='<button class="alt" id="skip">Admin: start voting now</button>'}
  if(p==='over'&&me.admin)h+='<button id="again">Play again</button>';
  var showChat=p==='lobby'||(me.alive&&p!=='over')||p==='over';
  if(showChat){
    h+='<div class="card"><div class="msgs" id="msgs">'+S.chat.map(function(m){return '<div class="'+(m.ch==='traitor'?'t':'')+'"><b>'+esc(m.name)+(m.ch==='traitor'?' 🗡':'')+':</b> '+esc(m.text)+'</div>'}).join('')+'</div>';
    if(me.alive||p==='lobby'){
      if(me.role==='traitor'&&p!=='lobby'&&p!=='over')h+='<div class="row" style="margin-bottom:8px"><button class="sm '+(ch==='all'?'':'alt')+'" id="cha">Everyone</button><button class="sm '+(ch==='traitor'?'':'alt')+'" id="cht">Traitors only</button></div>';
      h+='<div class="row"><input id="msg" maxlength="300" placeholder="Message..."><button id="send">Send</button></div>'}
    h+='</div>'}
  h+='<div class="err" id="err"></div>';
  var keep=document.getElementById('msg')?document.getElementById('msg').value:'',foc=document.activeElement&&document.activeElement.id==='msg';
  app.innerHTML=h;
  var m=document.getElementById('msgs');if(m)m.scrollTop=m.scrollHeight;
  var mi=document.getElementById('msg');if(mi){mi.value=keep;if(foc)mi.focus();mi.onkeydown=function(e){if(e.key==='Enter')sendMsg()}}
  function bind(id,fn){var e=document.getElementById(id);if(e)e.onclick=fn}
  bind('start',function(){act('start')});bind('ready',function(){act('ready')});bind('skip',function(){act('skip')});bind('again',function(){act('restart')});
  bind('send',sendMsg);bind('cha',function(){ch='all';render()});bind('cht',function(){ch='traitor';render()});
  Array.prototype.forEach.call(document.querySelectorAll('.pl'),function(b){b.onclick=function(){if(pick)act(pick,{target:b.getAttribute('data-id')})}});
}
function sendMsg(){var i=document.getElementById('msg');if(!i||!i.value.trim())return;var t=i.value;i.value='';act('chat',{text:t,ch:ch})}
setInterval(function(){var t=document.getElementById('tm');if(t&&S&&S.deadline)t.textContent=fmt(secs())},500);
if(ses)connect();else home();
</script></body></html>`;
