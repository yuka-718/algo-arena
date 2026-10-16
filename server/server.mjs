import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(root, 'server', 'data');
const dbFile = join(dataDir, 'db.json');
const sessions = new Map();
const matches = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8' };
let db;

async function loadDb() {
  await mkdir(dataDir, { recursive:true });
  try { db = JSON.parse(await readFile(dbFile, 'utf8')); } catch { db = { users: [], games: [] }; await saveDb(); }
}
async function saveDb() { await writeFile(dbFile, JSON.stringify(db, null, 2)); }
function json(res, status, body) { res.writeHead(status, {'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*'}); res.end(JSON.stringify(body)); }
async function body(req) { let raw=''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; }
function passwordHash(password, salt=randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function validPassword(password, stored) { const [salt, hash] = stored.split(':'); return timingSafeEqual(Buffer.from(hash,'hex'), scryptSync(password, salt, 64)); }
function tokenFor(user) { const token = randomBytes(24).toString('hex'); sessions.set(token, user.id); return token; }
function userFrom(req) { const token = req.headers.authorization?.replace('Bearer ',''); return db.users.find(u => u.id === sessions.get(token)); }
function publicUser(user) { return { id:user.id, username:user.username, rating:user.rating, games:user.games }; }
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, {'access-control-allow-origin':'*','access-control-allow-headers':'content-type, authorization'}); return res.end(); }
  if (url.pathname === '/api/health') return json(res, 200, { ok:true, service:'algo-arena-api' });
  if (url.pathname === '/api/auth/guest' && req.method === 'POST') {
    const input = await body(req); const username = String(input.username || `guest_${randomBytes(3).toString('hex')}`).slice(0,24);
    const user = { id:randomUUID(), username, password:null, rating:1000, games:0, guest:true }; db.users.push(user); await saveDb(); return json(res,201,{ token:tokenFor(user), user:publicUser(user) });
  }
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    const input = await body(req); const username = String(input.username||'').trim(); const password = String(input.password||'');
    if (username.length < 3 || password.length < 6) return json(res,400,{error:'ユーザー名は3文字以上、パスワードは6文字以上です。'});
    if (db.users.some(u=>u.username.toLowerCase()===username.toLowerCase())) return json(res,409,{error:'そのユーザー名は使用されています。'});
    const user={id:randomUUID(),username,password:passwordHash(password),rating:1000,games:0,guest:false}; db.users.push(user); await saveDb(); return json(res,201,{token:tokenFor(user),user:publicUser(user)});
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const input=await body(req); const user=db.users.find(u=>u.username===input.username); if (!user || !user.password || !validPassword(String(input.password||''),user.password)) return json(res,401,{error:'ログイン情報が正しくありません。'}); return json(res,200,{token:tokenFor(user),user:publicUser(user)});
  }
  if (url.pathname === '/api/lobby' && req.method === 'GET') return json(res,200,{rooms:[...matches.values()].filter(m=>m.status==='waiting').map(m=>({id:m.id,mode:m.mode,players:m.players.length})),leaderboard:db.users.filter(u=>!u.guest).sort((a,b)=>b.rating-a.rating).slice(0,20).map(publicUser)});
  if (url.pathname === '/api/me' && req.method === 'GET') { const user=userFrom(req); return user ? json(res,200,{user:publicUser(user)}) : json(res,401,{error:'ログインが必要です。'}); }
  if (url.pathname === '/api/matches' && req.method === 'POST') {
    const user=userFrom(req) || {id:'guest-local',username:'yuki_718',rating:1824}; const input=await body(req); const id=randomUUID(); const match={id,mode:input.mode==='casual'?'casual':'rated',players:[user.username,'mika.cards'],target:4,status:'active',createdAt:new Date().toISOString()}; matches.set(id,match); return json(res,201,{match:{id,opponent:match.players[1],opponentRating:1808,target:4}});
  }
  const guessMatch = url.pathname.match(/^\/api\/matches\/([^/]+)\/guess$/);
  if (guessMatch && req.method === 'POST') { const match=matches.get(guessMatch[1]); if(!match) return json(res,404,{error:'対戦が見つかりません。'}); const input=await body(req); const correct=Number(input.value)===match.target; if(correct){match.status='won'; const user=userFrom(req); if(user){user.rating+=24;user.games++;await saveDb();}} return json(res,200,{correct, status:match.status, ratingDelta:correct?24:0}); }
  const requested = normalize(join(root, url.pathname));
  if (!requested.startsWith(root) || url.pathname.startsWith('/server')) return json(res,404,{error:'Not found'});
  try { const file=await readFile(requested); res.writeHead(200,{'content-type':mime[extname(requested)]||'application/octet-stream'}); res.end(file); } catch { json(res,404,{error:'Not found'}); }
}

await loadDb();
createServer((req,res)=>route(req,res).catch(error=>json(res,500,{error:error.message}))).listen(process.env.PORT||4173,()=>console.log(`ALGO ARENA running at http://localhost:${process.env.PORT||4173}`));
