import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../shared/api.js';
import { createMemoryStore } from '../shared/store.js';
import { createFileStore } from '../server/file-store.mjs';

function setup(store = createMemoryStore()) {
  let time = 1_800_000_000_000;
  const api = createApi(store, { now: () => time });
  const request = async (path, method = 'GET', data, token, extra = {}) => {
    const headers = { ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    if (data !== undefined) headers['content-type'] = 'application/json';
    const response = await api(new Request(`http://arena.test/api${path}`, {
      method, headers, ...(data === undefined ? {} : { body: typeof data === 'string' ? data : JSON.stringify(data) }),
    }));
    return { status: response.status, ...await response.json() };
  };
  const guest = async name => {
    const response = await request('/auth/guest', 'POST', { username: name });
    assert.equal(response.status, 201);
    return response;
  };
  const twoPlayer = async (mode = 'rated', isPrivate = false) => {
    const a = await guest('Alice');
    const b = await guest('Bob');
    const created = await request('/rooms', 'POST', { mode, private: isPrivate }, a.token);
    assert.equal(created.status, 201);
    const joined = await request(`/rooms/${created.room.id}/join`, 'POST', {}, b.token);
    assert.equal(joined.status, 200);
    return { a, b, room: joined.room };
  };
  return { store, api, request, guest, twoPlayer, advance: milliseconds => { time += milliseconds; } };
}

test('guest sessions are random, persisted only as hashes, and ratings cannot be supplied by clients', async () => {
  const f = setup();
  const a = await f.guest('Alice');
  assert.match(a.token, /^[a-f0-9]{64}$/);
  assert.equal(a.user.rating, 1500);
  assert.equal(a.user.highestRating, 1500);
  assert.equal((await f.request('/me')).status, 401);
  assert.equal((await f.request('/lobby')).status, 200);
  const saved = await f.store.load();
  assert.ok(!JSON.stringify(saved).includes(a.token));
  const update = await f.request('/profile', 'POST', { username: 'New name', rating: 3000, games: 999 }, a.token);
  assert.equal(update.user.rating, 1500);
  assert.equal(update.user.games, 0);
  assert.equal((await f.request('/lobby', 'GET', undefined, a.token)).leaderboard.length, 0);
});

test('simultaneous joins reserve exactly one seat; participant and spectator snapshots hide secrets', async () => {
  const f = setup();
  const [a, b, c] = await Promise.all(['Alice', 'Bob', 'Cara'].map(f.guest));
  const { room } = await f.request('/rooms', 'POST', { mode: 'rated' }, a.token);
  const attempts = await Promise.all([b, c].map(user => f.request(`/rooms/${room.id}/join`, 'POST', {}, user.token)));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
  const winner = attempts[0].status === 200 ? b : c;
  const spectator = winner === b ? c : b;
  const own = await f.request(`/rooms/${room.id}`, 'GET', undefined, a.token);
  assert.equal(own.room.players.length, 2);
  assert.ok(own.room.game.players.find(p => p.id === a.user.id).cards.every(card => Number.isInteger(card.number)));
  assert.ok(own.room.game.players.find(p => p.id === winner.user.id).cards.every(card => card.number === null));
  assert.equal(own.room.game.deck, undefined);
  const view = await f.request(`/rooms/${room.id}`, 'GET', undefined, spectator.token);
  assert.equal(view.room.spectator, true);
  assert.ok(view.room.game.players.every(p => p.cards.every(card => card.number === null)));
  if (view.room.game.drawnCard) assert.equal(view.room.game.drawnCard.number, null);
  const anonymousView = await f.request(`/rooms/${room.id}`);
  assert.equal(anonymousView.status, 401);
  assert.equal((await f.request(`/rooms/${room.id}/chat`, 'GET', undefined, spectator.token)).status, 403);
  const lobby = await f.request('/lobby', 'GET', undefined, a.token);
  assert.equal(lobby.rooms[0].status, 'playing');
});

test('private rooms cannot be observed or listed; chat stays bounded and participant-only', async () => {
  const f = setup();
  const { a, b, room } = await f.twoPlayer('casual', true);
  const outsider = await f.guest('Outsider');
  assert.equal((await f.request(`/rooms/${room.id}`, 'GET', undefined, outsider.token)).status, 403);
  assert.equal((await f.request(`/rooms/${room.id}`)).status, 401);
  assert.equal((await f.request('/lobby', 'GET', undefined, outsider.token)).rooms.length, 0);
  assert.equal((await f.request(`/rooms/${room.id}/chat`, 'POST', { text: 'x'.repeat(101) }, a.token)).status, 400);
  const sent = await f.request(`/rooms/${room.id}/chat`, 'POST', { text: '<b>hello</b>' }, a.token);
  assert.equal(sent.message.text, '<b>hello</b>');
  const chat = await f.request(`/rooms/${room.id}/chat`, 'GET', undefined, b.token);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].userId, a.user.id);
});

test('simultaneous correct guesses with the same version apply once and clock increment is authoritative', async () => {
  const f = setup();
  const { a, b, room } = await f.twoPlayer();
  const state = (await f.store.load()).state;
  const game = state.rooms[room.id].game;
  const actor = game.players[game.currentPlayerIndex].id === a.user.id ? a : b;
  const target = game.players[1 - game.currentPlayerIndex].cards[0];
  f.advance(2000);
  const action = { type: 'attack', targetCardId: target.id, guess: target.number, version: room.version };
  const results = await Promise.all([1, 2].map(() => f.request(`/rooms/${room.id}/action`, 'POST', action, actor.token)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(results.find(r => r.status === 409).code, 'STALE_VERSION');
  const next = results.find(r => r.status === 200).room;
  assert.equal(next.clocks.incrementSeconds, 5);
  assert.equal(next.clocks.remaining[actor.user.id], 303000);
  assert.equal(next.game.history.filter(event => event.type === 'attack').length, 1);
  const other = actor === a ? b : a;
  assert.equal((await f.request(`/rooms/${room.id}/action`, 'POST', { type: 'stay' }, other.token)).status, 400);
});

test('rated results finalize exactly once under simultaneous resignations and preserve a zero-sum Elo pool', async () => {
  const f = setup();
  const { a, b, room } = await f.twoPlayer();
  const responses = await Promise.all([a, b].map(user => f.request(`/rooms/${room.id}/action`, 'POST', { type: 'resign' }, user.token)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  for (let i = 0; i < 3; i++) await f.request(`/rooms/${room.id}`, 'GET', undefined, a.token);
  const saved = (await f.store.load()).state;
  assert.equal(saved.users[a.user.id].rating + saved.users[b.user.id].rating, 3000);
  assert.equal(saved.users[a.user.id].ratedGames, 1);
  assert.equal(saved.users[b.user.id].ratedGames, 1);
  assert.deepEqual([saved.users[a.user.id].rating, saved.users[b.user.id].rating].sort(), [1480, 1520]);
  assert.equal(saved.history.length, 2);
  assert.equal((await f.request('/history', 'GET', undefined, a.token)).games.length, 1);
  const leaderboard = (await f.request('/lobby', 'GET', undefined, a.token)).leaderboard;
  assert.equal(leaderboard.length, 2);
  assert.equal(leaderboard[0].highestRating, 1520);
});

test('concurrent ranked queue requests pair two humans once and reconnect to the same room', async () => {
  const f = setup();
  const a = await f.guest('Alice');
  const b = await f.guest('Bob');
  const results = await Promise.all([a, b].map(user => f.request('/queue', 'POST', { mode: 'rated' }, user.token)));
  assert.equal(results.filter(r => r.queued).length, 1);
  const meA = await f.request('/me', 'GET', undefined, a.token);
  const meB = await f.request('/me', 'GET', undefined, b.token);
  assert.ok(meA.activeRoomId);
  assert.equal(meA.activeRoomId, meB.activeRoomId);
  assert.equal(meA.queued, false);
  const retry = await f.request('/queue', 'POST', { mode: 'rated' }, a.token);
  assert.equal(retry.roomId, meA.activeRoomId);
  assert.equal(Object.keys((await f.store.load()).state.rooms).length, 1);
});

test('a timeout is persisted even when the triggering late move is rejected', async () => {
  const f = setup();
  const { a, b, room } = await f.twoPlayer();
  const actor = room.game.currentPlayerId === a.user.id ? a : b;
  f.advance(300001);
  const late = await f.request(`/rooms/${room.id}/action`, 'POST', { type: 'stay' }, actor.token);
  assert.equal(late.status, 409);
  const saved = (await f.store.load()).state;
  assert.equal(saved.rooms[room.id].status, 'finished');
  assert.equal(saved.rooms[room.id].game.resultReason, 'timeout');
  assert.notEqual(saved.rooms[room.id].game.winnerId, actor.user.id);
  assert.equal(saved.history.length, 2);
});

test('casual and bot games never alter rating or the rated leaderboard', async () => {
  const f = setup();
  const { a, room } = await f.twoPlayer('casual');
  await f.request(`/rooms/${room.id}/action`, 'POST', { type: 'resign' }, a.token);
  const bot = await f.request('/rooms', 'POST', { mode: 'bot', timeSeconds: 600 }, a.token);
  assert.equal(bot.status, 201);
  assert.equal(bot.room.clocks.incrementSeconds, 10);
  await f.request(`/rooms/${bot.room.id}/action`, 'POST', { type: 'resign' }, a.token);
  const me = await f.request('/me', 'GET', undefined, a.token);
  assert.equal(me.user.rating, 1500);
  assert.equal(me.user.games, 2);
  assert.equal(me.user.ratedGames, 0);
  assert.equal((await f.request('/lobby', 'GET', undefined, a.token)).leaderboard.length, 0);
});

test('mutation size/origin validation and rate limits include invalid actions', async () => {
  const f = setup();
  const a = await f.guest('Alice');
  assert.equal((await f.request('/profile', 'POST', { username: 'x'.repeat(17000) }, a.token)).status, 413);
  assert.equal((await f.request('/profile', 'POST', '{broken', a.token)).status, 400);
  assert.equal((await f.request('/profile', 'POST', { username: 'Mallory' }, a.token, { origin: 'https://evil.test' })).status, 403);
  for (let i = 0; i < 120; i++) assert.equal((await f.request('/profile', 'POST', { username: '' }, a.token)).status, 400);
  assert.equal((await f.request('/profile', 'POST', { username: 'Blocked' }, a.token)).status, 429);
  f.advance(60001);
  assert.equal((await f.request('/profile', 'POST', { username: 'Allowed' }, a.token)).status, 200);
});

test('file store survives reconstruction, preserves sessions and matches, and CAS rejects stale writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'algo-api-'));
  try {
    const path = join(directory, 'arena.json');
    const f = setup(await createFileStore(path));
    const { a, room } = await f.twoPlayer();
    await f.request(`/rooms/${room.id}/action`, 'POST', { type: 'resign' }, a.token);
    const restoredStore = await createFileStore(path);
    const restored = setup(restoredStore);
    const me = await restored.request('/me', 'GET', undefined, a.token);
    assert.equal(me.status, 200);
    assert.equal(me.user.games, 1);
    assert.equal((await restored.request('/history', 'GET', undefined, a.token)).games.length, 1);
    const saved = await restoredStore.load();
    const commits = await Promise.all([1, 2].map(() => restoredStore.commit(saved.version, saved.state)));
    assert.deepEqual(commits, [true, false]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, saved.version + 1);
    assert.ok(!(await readFile(path, 'utf8')).includes(a.token));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('register upgrades a guest while preserving rating and identity; login reconnects from a second device', async () => {
  const f = setup();
  const { a, room } = await f.twoPlayer();
  await f.request(`/rooms/${room.id}/action`, 'POST', { type: 'resign' }, a.token);
  const before = (await f.request('/me', 'GET', undefined, a.token)).user;
  const waiting = await f.request('/rooms', 'POST', { mode: 'casual' }, a.token);
  const registered = await f.request('/auth/register', 'POST', { username: 'SavedAlice', password: 'correct horse 123' }, a.token);
  assert.equal(registered.status, 201);
  assert.equal(registered.user.id, a.user.id);
  assert.equal(registered.user.rating, before.rating);
  assert.equal(registered.user.ratedGames, 1);
  assert.equal(registered.user.guest, false);
  assert.equal(registered.user.registered, true);
  assert.equal((await f.request('/me', 'GET', undefined, a.token)).status, 401);
  const login = await f.request('/auth/login', 'POST', { username: 'sAVEDaLICE', password: 'correct horse 123' });
  assert.equal(login.status, 200);
  assert.notEqual(login.token, registered.token);
  assert.equal(login.user.id, a.user.id);
  assert.equal((await f.request('/me', 'GET', undefined, login.token)).activeRoomId, waiting.room.id);
  assert.equal((await f.request('/history', 'GET', undefined, login.token)).games.length, 1);
  assert.equal((await f.request('/auth/login', 'POST', { username: 'SavedAlice', password: 'incorrect password' })).status, 401);
  assert.equal((await f.request('/auth/guest', 'POST', { username: 'savedalice' })).status, 409);
  assert.equal((await f.request('/auth/register', 'POST', { username: 'SAVEDALICE', password: 'another password 123' })).status, 409);
  assert.equal((await f.request('/profile', 'POST', { username: 'savedalice' }, (await f.guest('Charlie')).token)).status, 409);
  const snapshot = JSON.stringify(await f.store.load());
  assert.ok(!snapshot.includes('correct horse 123'));
  assert.ok(!JSON.stringify(login.user).includes('password'));
});

test('five-session retention always preserves the newly returned token even with identical issuance timestamps', async () => {
  const f = setup();
  const registered = await f.request('/auth/register', 'POST', { username: 'SeveralDevices', password: 'multiple devices 123' });
  assert.equal(registered.status, 201);
  let latest;
  for (let device = 0; device < 6; device++) {
    latest = await f.request('/auth/login', 'POST', { username: 'severaldevices', password: 'multiple devices 123' });
    assert.equal(latest.status, 200);
    assert.equal((await f.request('/me', 'GET', undefined, latest.token)).status, 200);
  }
  const saved = (await f.store.load()).state;
  assert.equal(Object.values(saved.sessions).filter(session => session.userId === registered.user.id).length, 5);
  assert.equal((await f.request('/me', 'GET', undefined, registered.token)).status, 401);
});

test('account authentication survives file-store restart and invalid attempts are IP rate limited', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'algo-account-'));
  try {
    const path = join(directory, 'arena.json');
    const f = setup(await createFileStore(path));
    const registered = await f.request('/auth/register', 'POST', { username: 'Persistent', password: 'long password 123' });
    assert.equal(registered.status, 201);
    const restored = setup(await createFileStore(path));
    const login = await restored.request('/auth/login', 'POST', { username: 'persistent', password: 'long password 123' });
    assert.equal(login.status, 200);
    assert.equal(login.user.id, registered.user.id);
    for (let i = 0; i < 8; i++) assert.equal((await restored.request('/auth/login', 'POST', { username: 'missing', password: 'wrong password 123' })).status, 401);
    assert.equal((await restored.request('/auth/login', 'POST', { username: 'persistent', password: 'long password 123' })).status, 429);
    restored.advance(60001);
    assert.equal((await restored.request('/auth/login', 'POST', { username: 'persistent', password: 'long password 123' })).status, 200);
    assert.ok(!(await readFile(path, 'utf8')).includes('long password 123'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
