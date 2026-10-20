import { createGame, attack, stay, resign, viewGame, chooseBotMove } from './engine.js';
import { hashPassword, verifyPassword } from './passwords.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_BODY = 16_384;
const ONLINE_WINDOW = 45_000;
const TOKEN_LIFETIME = 90 * DAY;

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});
const uuid = () => crypto.randomUUID();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function publicUser(user) {
  return { id: user.id, username: user.username, rating: user.rating, highestRating: user.highestRating || user.rating, games: user.games || 0,
    ratedGames: user.ratedGames || 0, wins: user.wins || 0, losses: user.losses || 0,
    guest: !user.bot && !user.registered, registered: !!user.registered, bot: !!user.bot };
}
const usernameKey = name => name.normalize('NFC').toLowerCase();
function availableUsername(state, name, exceptId) {
  if (Object.values(state.users).some(user => user.registered && user.id !== exceptId && usernameKey(user.username) === usernameKey(name))) {
    fail(409, 'USERNAME_TAKEN', 'そのユーザー名は登録済みです。');
  }
  return name;
}
function newUser(state, name, now) {
  if (Object.keys(state.users).length >= 1000 || new TextEncoder().encode(JSON.stringify(state)).byteLength > 1_500_000) {
    fail(503, 'ARENA_FULL', '現在アクセスが混み合っています。');
  }
  const user = { id: uuid(), username: availableUsername(state, name), rating: 1500, highestRating: 1500,
    games: 0, ratedGames: 0, wins: 0, losses: 0, createdAt: now, lastSeen: now, registered: false };
  state.users[user.id] = user;
  return user;
}
function issueSession(state, user, hash, now) {
  state.sessions[hash] = { userId: user.id, expiresAt: now + TOKEN_LIFETIME, issuedAt: now };
  const previous = Object.entries(state.sessions).filter(([key, session]) => key !== hash && session.userId === user.id).reverse().sort((a, b) => (b[1].issuedAt || 0) - (a[1].issuedAt || 0));
  for (const [key] of previous.slice(4)) delete state.sessions[key];
}
function cleanString(value, max, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') fail(400, 'INVALID_INPUT', `${label}を入力してください。`);
  const text = value.trim();
  if (!text || [...text].length > max || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) {
    fail(400, 'INVALID_INPUT', `${label}は1〜${max}文字で入力してください。`);
  }
  return text;
}
async function readInput(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) fail(413, 'BODY_TOO_LARGE', '送信データが大きすぎます。');
  if (!request.body) return {};
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '送信データが大きすぎます。'); }
    parts.push(value);
  }
  if (!size) return {};
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  try {
    const result = JSON.parse(new TextDecoder().decode(body));
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {}
  fail(400, 'INVALID_JSON', 'JSONデータを確認してください。');
}
function rateLimit(state, key, now, max = 120, window = MINUTE) {
  if (!Object.hasOwn(state.limits, key) && Object.keys(state.limits).length >= 2000) {
    for (const [oldKey, oldLimit] of Object.entries(state.limits)) if (oldLimit.resetAt <= now) delete state.limits[oldKey];
    if (Object.keys(state.limits).length >= 2000) fail(503, 'BUSY', 'ただいま混み合っています。');
  }
  let limit = state.limits[key];
  if (!limit || now >= limit.resetAt) limit = state.limits[key] = { count: 0, resetAt: now + window };
  if (limit.count >= max) fail(429, 'RATE_LIMIT', '操作が多すぎます。少し待ってからお試しください。');
  limit.count++;
}
function currentId(game) { return game.players[game.currentPlayerIndex]?.id; }
function playerFor(state, room, id) { return id === room.bot?.id ? room.bot : state.users[id]; }
function roomSummary(state, room) {
  return { id: room.id, name: room.name, mode: room.mode, private: room.private, status: room.status,
    version: room.version, players: room.playerIds.map(id => publicUser(playerFor(state, room, id))),
    playerIds: room.playerIds, timeSeconds: room.timeSeconds, createdAt: room.createdAt, updatedAt: room.updatedAt };
}
function roomView(state, room, userId) {
  const participant = room.playerIds.includes(userId);
  if (!participant && room.private) fail(403, 'PARTICIPANTS_ONLY', 'このルームの参加者だけが閲覧できます。');
  return { ...roomSummary(state, room), spectator: !participant, game: room.game ? viewGame(room.game, participant ? userId : null) : null,
    clocks: room.clocks, ratingResult: room.ratingResult, completedAt: room.completedAt ?? null };
}
function lobbyView(state, now) {
  const online = Object.values(state.users).filter(p => now - p.lastSeen < ONLINE_WINDOW).sort((a, b) => b.lastSeen - a.lastSeen);
  return { online: online.slice(0, 100).map(publicUser), onlineCount: online.length,
    rooms: Object.values(state.rooms).filter(room => !room.private && room.status !== 'finished' && room.mode !== 'bot').map(room => roomSummary(state, room)),
    queueCount: state.queue.length, leaderboard: Object.values(state.users).filter(p => p.ratedGames > 0).sort((a, b) => b.rating - a.rating || b.ratedGames - a.ratedGames).slice(0, 50).map(publicUser) };
}
function activeRoom(state, id) {
  return Object.values(state.rooms).find(room => room.status !== 'finished' && room.playerIds.includes(id));
}
function finalize(state, room, now) {
  if (room.completedAt !== undefined && room.completedAt !== null) return;
  room.status = 'finished';
  room.completedAt = now;
  room.updatedAt = now;
  room.version++;
  room.clocks.runningPlayerId = null;
  room.clocks.lastTickAt = now;
  const winner = room.game.winnerId;
  const players = room.playerIds.map(id => playerFor(state, room, id));
  const rated = room.mode === 'rated' && players.every(p => !p.bot);
  const before = players.map(p => p.rating);
  let delta = 0;
  if (rated) {
    const expected = 1 / (1 + 10 ** ((before[1] - before[0]) / 400));
    const actual = winner === players[0].id ? 1 : winner === players[1].id ? 0 : 0.5;
    delta = Math.round(40 * (actual - expected));
    room.ratingResult = {};
  }
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player.bot) continue;
    const change = rated ? (i === 0 ? delta : -delta) : 0;
    player.games = (player.games || 0) + 1;
    if (winner === player.id) player.wins = (player.wins || 0) + 1;
    else if (winner) player.losses = (player.losses || 0) + 1;
    if (rated) {
      player.ratedGames = (player.ratedGames || 0) + 1;
      player.rating += change;
      player.highestRating = Math.max(player.highestRating || before[i], player.rating);
      room.ratingResult[player.id] = { before: before[i], after: player.rating, delta: change };
    }
    state.history.push({ id: uuid(), roomId: room.id, userId: player.id,
      opponent: { ...publicUser(players[1 - i]), rating: before[1 - i] }, result: winner === player.id ? 'win' : winner ? 'loss' : 'draw',
      mode: room.mode, ratingDelta: change, ratingBefore: before[i], ratingAfter: player.rating,
      reason: room.game.resultReason || 'all-revealed', createdAt: now });
  }
  state.history = state.history.slice(-1000);
  state.queue = state.queue.filter(entry => !room.playerIds.includes(entry.userId));
}
function tickRoom(state, room, now) {
  if (room.status !== 'playing') return;
  if (room.game.status === 'finished') { finalize(state, room, now); return; }
  const id = currentId(room.game);
  const elapsed = Math.max(0, now - room.clocks.lastTickAt);
  room.clocks.remaining[id] = Math.max(0, room.clocks.remaining[id] - elapsed);
  room.clocks.lastTickAt = now;
  room.clocks.runningPlayerId = id;
  if (room.clocks.remaining[id] <= 0) {
    resign(room.game, id);
    room.game.resultReason = 'timeout';
    if (room.game.lastEvent) room.game.lastEvent.type = 'timeout';
    finalize(state, room, now);
  }
}
function applyMove(game, actorId, input) {
  try {
    if (input.type === 'attack') {
      if (typeof input.targetCardId !== 'string' || !Number.isInteger(input.guess) || input.guess < 0 || input.guess > 11) {
        fail(400, 'INVALID_MOVE', '相手のカードと0〜11の数字を指定してください。');
      }
      const result = attack(game, actorId, input.targetCardId, input.guess);
      game.history = game.history.slice(-256);
      return result;
    }
    if (input.type === 'stay') { const result = stay(game, actorId); game.history = game.history.slice(-256); return result; }
    if (input.type === 'resign') { const result = resign(game, actorId); game.history = game.history.slice(-256); return result; }
    fail(400, 'INVALID_MOVE', '操作を確認してください。');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, 'INVALID_MOVE', error.message || 'この操作はできません。');
  }
}
function settleBots(state, room, now) {
  if (!room.bot || room.status !== 'playing') return;
  // A bot can keep attacking; bound this loop even if the engine changes later.
  for (let turns = 0; turns < 64 && room.game.status === 'playing' && currentId(room.game) === room.bot.id; turns++) {
    const move = chooseBotMove(room.game, room.bot.id);
    if (!move) break;
    applyMove(room.game, room.bot.id, move);
    if (['attack', 'stay'].includes(move.type)) room.clocks.remaining[room.bot.id] += room.clocks.incrementSeconds * 1000;
  }
  room.clocks.lastTickAt = now;
  room.clocks.runningPlayerId = room.game.status === 'playing' ? currentId(room.game) : null;
  if (room.game.status === 'finished') finalize(state, room, now);
}
function startRoom(state, room, now) {
  room.status = 'playing';
  room.game = createGame(room.playerIds);
  room.clocks = { remaining: Object.fromEntries(room.playerIds.map(id => [id, room.timeSeconds * 1000])),
    runningPlayerId: currentId(room.game), lastTickAt: now, incrementSeconds: room.timeSeconds / 60 };
  room.version++;
  room.updatedAt = now;
  state.queue = state.queue.filter(entry => !room.playerIds.includes(entry.userId));
  settleBots(state, room, now);
}
function makeRoom(state, user, input, now) {
  if (!['casual', 'rated', 'bot'].includes(input.mode)) fail(400, 'INVALID_MODE', '対戦形式を選んでください。');
  if (input.timeSeconds !== undefined && ![300, 600].includes(input.timeSeconds)) fail(400, 'INVALID_TIME', '持ち時間は5分または10分です。');
  if (input.private !== undefined && typeof input.private !== 'boolean') fail(400, 'INVALID_INPUT', 'ルーム設定を確認してください。');
  if (Object.keys(state.rooms).length >= 100 || new TextEncoder().encode(JSON.stringify(state)).byteLength > 1_500_000) fail(503, 'ARENA_FULL', '現在ルームが混み合っています。');
  const room = { id: uuid(), name: cleanString(input.name, 40, 'ルーム名', `${user.username}のルーム`),
    mode: input.mode, private: !!input.private, timeSeconds: input.timeSeconds || 300,
    status: 'waiting', version: 1, playerIds: [user.id], game: null, clocks: null,
    ratingResult: null, messages: [], createdAt: now, updatedAt: now };
  state.rooms[room.id] = room;
  state.queue = state.queue.filter(entry => entry.userId !== user.id);
  if (room.mode === 'bot') {
    room.bot = { id: `bot:${room.id}`, username: 'ALGO BOT', rating: 1500, bot: true, games: 0 };
    room.playerIds.push(room.bot.id);
    startRoom(state, room, now);
  }
  return room;
}
function sweep(state, now) {
  for (const [hash, session] of Object.entries(state.sessions)) if (session.expiresAt <= now) delete state.sessions[hash];
  for (const [key, limit] of Object.entries(state.limits)) if (limit.resetAt <= now) delete state.limits[key];
  state.queue = state.queue.filter(entry => state.users[entry.userId] && now - state.users[entry.userId].lastSeen < ONLINE_WINDOW && !activeRoom(state, entry.userId));
  for (const room of Object.values(state.rooms)) {
    tickRoom(state, room, now);
    if (room.status === 'waiting' && now - room.updatedAt > 30 * MINUTE) delete state.rooms[room.id];
  }
  const finished = Object.values(state.rooms).filter(room => room.status === 'finished').sort((a, b) => b.completedAt - a.completedAt);
  for (const room of finished.slice(20)) delete state.rooms[room.id];
  for (const [id, user] of Object.entries(state.users)) {
    if (!user.registered && !user.ratedGames && now - user.lastSeen > TOKEN_LIFETIME
      && !Object.values(state.sessions).some(session => session.userId === id)
      && !Object.values(state.rooms).some(room => room.playerIds.includes(id))) delete state.users[id];
  }
}

/** Web-standard Request -> Response API. Store commits use compare-and-swap. */
export function createApi(store, { now = () => Date.now(), clientKey = request => request.headers.get('cf-connecting-ip') || request.headers.get('x-arena-ip') || 'anonymous' } = {}) {
  return async function handleRequest(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = request.method;
      if (method === 'GET' && path === '/api/health') return json({ ok: true, service: 'algo-arena-api' });
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      // Session tokens are secrets; untrusted origins cannot use the authenticated API.
      const origin = request.headers.get('origin');
      if (mutation && origin && origin !== url.origin) fail(403, 'ORIGIN_DENIED', 'このサイトから操作してください。');
      const input = mutation ? await readInput(request) : {};
      const rawToken = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const tokenHash = rawToken ? await digest(rawToken) : null;
      const guestRequest = path === '/api/auth/guest' && method === 'POST';
      const registerRequest = path === '/api/auth/register' && method === 'POST';
      const loginRequest = path === '/api/auth/login' && method === 'POST';
      const accountRequest = registerRequest || loginRequest;
      const newToken = guestRequest || accountRequest ? token() : null;
      const newHash = newToken ? await digest(newToken) : null;
      const ipHash = guestRequest || accountRequest ? await digest(String(clientKey(request)).slice(0, 200)) : null;
      let passwordRecord;
      let verified;
      if (accountRequest) {
        cleanString(input.username, 24, 'ユーザー名');
        if (typeof input.password !== 'string' || [...input.password].length < 10 || [...input.password].length > 128) fail(400, 'INVALID_PASSWORD', 'パスワードは10〜128文字で入力してください。');
        // Commit the IP limit before running the relatively expensive password KDF.
        let limited = false;
        for (let attempt = 0; attempt < 24; attempt++) {
          const { version, state } = await store.load();
          rateLimit(state, `account:${ipHash}`, now(), 10);
          if (await store.commit(version, state)) { limited = true; break; }
        }
        if (!limited) fail(503, 'BUSY', 'ただいま混み合っています。');
        if (registerRequest) passwordRecord = await hashPassword(input.password);
      }
      for (let attempt = 0; attempt < 24; attempt++) {
        const { version, state } = await store.load();
        const time = now();
        sweep(state, time);
        let status = 200;
        let result;
        try {
        if (guestRequest) {
          rateLimit(state, `guest:${ipHash}`, time, 30);
          const user = newUser(state, cleanString(input.username, 24, 'ユーザー名', `ゲスト${token().slice(0, 6)}`), time);
          issueSession(state, user, newHash, time);
          result = { token: newToken, user: publicUser(user) };
          status = 201;
        } else if (accountRequest) {
          const name = cleanString(input.username, 24, 'ユーザー名');
          let user;
          if (registerRequest) {
            const session = tokenHash && state.sessions[tokenHash];
            const existing = session && state.users[session.userId];
            if (existing?.registered) fail(409, 'ALREADY_REGISTERED', 'このアカウントは登録済みです。');
            availableUsername(state, name, existing?.id);
            user = existing || newUser(state, name, time);
            user.username = name;
            user.registered = true;
            user.passwordRecord = passwordRecord;
            if (tokenHash) delete state.sessions[tokenHash];
            status = 201;
          } else {
            user = Object.values(state.users).find(candidate => candidate.registered && usernameKey(candidate.username) === usernameKey(name));
            if (!user) fail(401, 'INVALID_CREDENTIALS', 'ユーザー名またはパスワードを確認してください。');
            if (verified?.hash !== user.passwordRecord.hash) verified = { hash: user.passwordRecord.hash, valid: await verifyPassword(input.password, user.passwordRecord) };
            if (!verified.valid) fail(401, 'INVALID_CREDENTIALS', 'ユーザー名またはパスワードを確認してください。');
          }
          user.lastSeen = time;
          issueSession(state, user, newHash, time);
          result = { token: newToken, user: publicUser(user) };
        } else {
          const session = tokenHash && state.sessions[tokenHash];
          const user = session && state.users[session.userId];
          if (!user || session.expiresAt <= time) {
            if (path === '/api/lobby' && method === 'GET') result = lobbyView(state, time);
            else fail(401, 'AUTH_REQUIRED', 'ゲストログインしてください。');
          } else {
          user.lastSeen = time;
          session.expiresAt = time + TOKEN_LIFETIME;
          if (mutation) rateLimit(state, `user:${user.id}`, time);
          const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(?:\/(join|leave|action|chat))?$/);
          if (path === '/api/me' && method === 'GET') {
            result = { user: publicUser(user), activeRoomId: activeRoom(state, user.id)?.id || null,
              queued: state.queue.some(entry => entry.userId === user.id) };
          } else if (path === '/api/auth/logout' && method === 'POST') {
            delete state.sessions[tokenHash];
            state.queue = state.queue.filter(entry => entry.userId !== user.id);
            result = { ok: true };
          } else if (path === '/api/profile' && method === 'POST') {
            user.username = availableUsername(state, cleanString(input.username, 24, 'ユーザー名'), user.id);
            result = { user: publicUser(user) };
          } else if (path === '/api/lobby' && method === 'GET') {
            result = lobbyView(state, time);
          } else if (path === '/api/history' && method === 'GET') {
            result = { games: state.history.filter(game => game.userId === user.id).slice(-50).reverse().map(({ userId, ...game }) => game) };
          } else if (path === '/api/rooms' && method === 'POST') {
            if (activeRoom(state, user.id)) fail(409, 'ALREADY_IN_ROOM', '参加中のルームがあります。');
            const room = makeRoom(state, user, input, time);
            result = { room: roomView(state, room, user.id) };
            status = 201;
          } else if (path === '/api/queue' && method === 'POST') {
            if (input.mode !== 'rated') fail(400, 'INVALID_MODE', 'レート対戦を指定してください。');
            const active = activeRoom(state, user.id);
            if (active) {
              if (active.mode === 'rated' && active.status === 'playing') result = { queued: false, roomId: active.id };
              else fail(409, 'ALREADY_IN_ROOM', '参加中のルームがあります。');
            } else {
              const candidates = state.queue.filter(entry => entry.userId !== user.id).sort((a, b) =>
                Math.abs(state.users[a.userId].rating - user.rating) - Math.abs(state.users[b.userId].rating - user.rating) || a.createdAt - b.createdAt);
              if (candidates.length) {
                const opponent = state.users[candidates[0].userId];
                const room = makeRoom(state, opponent, { mode: 'rated', name: 'レート対戦', timeSeconds: 300 }, time);
                room.playerIds.push(user.id);
                startRoom(state, room, time);
                result = { queued: false, roomId: room.id };
              } else {
                if (!state.queue.some(entry => entry.userId === user.id)) state.queue.push({ userId: user.id, createdAt: time });
                result = { queued: true, roomId: null };
              }
            }
          } else if (path === '/api/queue' && method === 'DELETE') {
            state.queue = state.queue.filter(entry => entry.userId !== user.id);
            result = { queued: false };
          } else if (roomMatch) {
            const room = Object.hasOwn(state.rooms, roomMatch[1]) ? state.rooms[roomMatch[1]] : null;
            if (!room) fail(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
            const operation = roomMatch[2];
            if (!operation && method === 'GET') result = { room: roomView(state, room, user.id) };
            else if (operation === 'join' && method === 'POST') {
              if (room.playerIds.includes(user.id)) result = { room: roomView(state, room, user.id) };
              else {
                if (room.status !== 'waiting' || room.playerIds.length !== 1) fail(409, 'ROOM_FULL', 'このルームには参加できません。');
                if (activeRoom(state, user.id)) fail(409, 'ALREADY_IN_ROOM', '参加中のルームがあります。');
                room.playerIds.push(user.id);
                startRoom(state, room, time);
                result = { room: roomView(state, room, user.id) };
              }
            } else {
              if (!room.playerIds.includes(user.id)) fail(403, 'PARTICIPANTS_ONLY', 'このルームの参加者だけが操作できます。');
              if (operation === 'leave' && method === 'POST') {
                if (room.status !== 'waiting') fail(409, 'GAME_STARTED', '対戦開始後は投了してください。');
                delete state.rooms[room.id];
                result = { ok: true };
              } else if (operation === 'action' && method === 'POST') {
                if (input.version !== undefined && (!Number.isInteger(input.version) || input.version !== room.version)) fail(409, 'STALE_VERSION', '盤面が更新されました。最新の盤面で操作してください。');
                if (room.status !== 'playing') fail(409, 'GAME_NOT_PLAYING', '現在は対戦中ではありません。');
                const nextGame = structuredClone(room.game);
                applyMove(nextGame, user.id, input);
                room.game = nextGame;
                if (['attack', 'stay'].includes(input.type)) room.clocks.remaining[user.id] += room.clocks.incrementSeconds * 1000;
                room.version++;
                room.updatedAt = time;
                room.clocks.lastTickAt = time;
                room.clocks.runningPlayerId = room.game.status === 'playing' ? currentId(room.game) : null;
                if (room.game.status === 'finished') finalize(state, room, time);
                else settleBots(state, room, time);
                result = { room: roomView(state, room, user.id) };
              } else if (operation === 'chat' && method === 'GET') result = { messages: room.messages };
              else if (operation === 'chat' && method === 'POST') {
                rateLimit(state, `chat:${user.id}`, time, 15);
                const message = { id: uuid(), userId: user.id, username: user.username,
                  text: cleanString(input.text, 100, 'メッセージ'), createdAt: time };
                room.messages.push(message);
                room.messages = room.messages.slice(-100);
                result = { message };
                status = 201;
              } else fail(404, 'NOT_FOUND', 'APIが見つかりません。');
            }
          } else fail(404, 'NOT_FOUND', 'APIが見つかりません。');
          }
        }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          result = { error: error.message, code: error.code };
          status = error.status;
        }
        if (await store.commit(version, state)) return json(result, status);
      }
      fail(503, 'BUSY', 'ただいま混み合っています。もう一度お試しください。');
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      console.error('Arena API error:', error);
      return json({ error: 'サーバーでエラーが発生しました。', code: 'INTERNAL_ERROR' }, 500);
    }
  };
}

export const createApiHandler = createApi;
