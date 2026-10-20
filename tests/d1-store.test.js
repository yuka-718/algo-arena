import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { D1Store } from '../worker/d1-store.js';
import { createInitialState } from '../shared/store.js';
import { createGame, attack, viewGame } from '../shared/engine.js';

/**
 * Execute the actual generated SQLite migrations, then expose SQLite's prepared
 * statements through the small D1 surface used by D1Store. SQL and CAS semantics
 * are real; only the asynchronous D1 result envelope is adapted here.
 */
function makeStore(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const migrationDirectory = new URL('../drizzle/', import.meta.url);
  const migrations = readdirSync(migrationDirectory)
    .filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  assert.ok(migrations.length > 0, 'generated migrations must exist');
  for (const file of migrations) sqlite.exec(readFileSync(new URL(file, migrationDirectory), 'utf8'));

  const d1 = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const prepared = bindings => ({
        bind(...values) { return prepared(values); },
        async first() { return statement.get(...bindings) || null; },
        async run() {
          const result = statement.run(...bindings);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      });
      return prepared([]);
    },
  };
  return { store: new D1Store(d1), sqlite };
}

test('generated Drizzle schema supports an initially empty D1 state', async t => {
  const { store, sqlite } = makeStore(t);
  const columns = sqlite.prepare('PRAGMA table_info(arena_state)').all();
  assert.deepEqual(columns.map(column => column.name), ['id', 'version', 'state']);
  assert.equal(columns.find(column => column.name === 'id').pk, 1);
  assert.ok(columns.every(column => column.notnull === 1));
  assert.deepEqual(await store.load(), { version: 0, state: createInitialState() });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM arena_state').get().count, 0);

  const firstLoad = await store.load();
  firstLoad.state.users.transient = { username: 'not committed' };
  assert.deepEqual(await store.load(), { version: 0, state: createInitialState() },
    'loading empty storage must return an independent initial state');
});

test('first commit inserts exactly once and rejects a stale version-zero insert', async t => {
  const { store, sqlite } = makeStore(t);
  const first = await store.load();
  const stale = await store.load();
  first.state.users.winner = { id: 'winner', username: 'first write' };
  stale.state.users.loser = { id: 'loser', username: 'must not overwrite' };

  assert.equal(await store.commit(first.version, first.state), true);
  assert.equal(await store.commit(stale.version, stale.state), false);
  assert.deepEqual(await store.load(), { version: 1, state: first.state });
  const rows = sqlite.prepare('SELECT id, version, state FROM arena_state').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].version, 1);
  assert.deepEqual(JSON.parse(rows[0].state), first.state);
});

test('updates advance the version and compare-and-swap rejects a stale update', async t => {
  const { store } = makeStore(t);
  assert.equal(await store.commit(0, createInitialState()), true);
  const first = await store.load();
  const stale = await store.load();
  first.state.queue.push({ userId: 'alice', createdAt: 1000 });
  stale.state.queue.push({ userId: 'bob', createdAt: 1001 });

  assert.equal(await store.commit(first.version, first.state), true);
  assert.equal(await store.commit(stale.version, stale.state), false);
  assert.deepEqual(await store.load(), { version: 2, state: first.state });

  const next = await store.load();
  next.state.queue.push({ userId: 'bob', createdAt: 1001 });
  assert.equal(await store.commit(next.version, next.state), true);
  assert.deepEqual(await store.load(), { version: 3, state: next.state });
});

test('JSON persistence preserves complete rooms and server-only cards without sharing snapshots', async t => {
  const { store, sqlite } = makeStore(t);
  const state = createInitialState();
  state.users.alice = { id: 'alice', username: '日本語 "quoted" \' name', rating: 1500, games: 0 };
  state.users.bob = { id: 'bob', username: 'Bob', rating: 1500, games: 0 };
  state.sessions['test-session-hash'] = { userId: 'alice', expiresAt: 999999 };
  state.limits['user:alice'] = { count: 2, resetAt: 60000 };
  const game = createGame(['alice', 'bob'], { seed: 'd1-round-trip', startingPlayer: 'alice' });
  const target = game.players[1].cards[0];
  attack(game, 'alice', target.id, (target.number + 1) % 12);
  state.rooms['room-1'] = {
    id: 'room-1', name: '推理ルーム\n保存の確認', mode: 'rated', private: false,
    status: 'playing', version: 3, playerIds: ['alice', 'bob'], game,
    clocks: { remaining: { alice: 301000, bob: 300000 }, runningPlayerId: 'bob',
      lastTickAt: 1200, incrementSeconds: 5 },
    ratingResult: null, completedAt: null,
    messages: [{ id: 'message-1', userId: 'alice', text: 'よろしく！', createdAt: 1000 }],
    createdAt: 1000, updatedAt: 1200,
  };
  state.history.push({ id: 'history-1', userId: 'alice', roomId: 'previous-room',
    result: 'win', ratingDelta: 20, createdAt: 900 });

  assert.equal(await store.commit(0, state), true);
  const loaded = await store.load();
  assert.deepEqual(loaded, { version: 1, state });
  const persisted = JSON.parse(sqlite.prepare('SELECT state FROM arena_state WHERE id = 1').get().state);
  assert.deepEqual(persisted.rooms['room-1'].game, game);
  assert.ok(persisted.rooms['room-1'].game.deck.length > 0);
  assert.ok(persisted.rooms['room-1'].game.deck.every(card => Number.isInteger(card.number)),
    'authoritative hidden deck must survive persistence');
  assert.ok(persisted.rooms['room-1'].game.players[1].cards.every(card => Number.isInteger(card.number)),
    'authoritative opponent values must survive persistence');

  const aliceView = viewGame(loaded.state.rooms['room-1'].game, 'alice');
  assert.ok(aliceView.players[1].cards.every(card => card.number === null));
  assert.equal(aliceView.drawnCard.number, null);
  assert.equal(Object.hasOwn(aliceView, 'deck'), false);
  const spectator = viewGame(loaded.state.rooms['room-1'].game, null);
  assert.ok(spectator.players.flatMap(player => player.cards)
    .filter(card => !card.revealed).every(card => card.number === null));

  // A loaded snapshot and a caller-owned object may both be changed freely;
  // neither modification is persisted without a successful commit.
  loaded.state.rooms['room-1'].game.players[0].cards[0].number = 999;
  loaded.state.users.alice.username = 'changed after load';
  state.rooms['room-1'].messages.length = 0;
  const reloaded = await store.load();
  assert.equal(reloaded.state.users.alice.username, '日本語 "quoted" \' name');
  assert.notEqual(reloaded.state.rooms['room-1'].game.players[0].cards[0].number, 999);
  assert.equal(reloaded.state.rooms['room-1'].messages.length, 1);
});

test('large compressed state preserves hidden cards and concurrent commits still use CAS', async t => {
  const { store, sqlite } = makeStore(t);
  const state = createInitialState();
  state.users.alice = { id: 'alice', username: 'Alice', rating: 1500 };
  state.users.bob = { id: 'bob', username: 'Bob', rating: 1500 };
  state.rooms['large-room'] = {
    id: 'large-room', name: '長期保存ルーム', status: 'playing', playerIds: ['alice', 'bob'],
    game: createGame(['alice', 'bob'], { seed: 'compressed-hidden-state', startingPlayer: 'alice' }),
    clocks: { remaining: { alice: 300000, bob: 300000 }, runningPlayerId: 'alice', lastTickAt: 1200 },
  };
  state.history = Array.from({ length: 2200 }, (_, index) => ({
    id: `history-${index}`, roomId: `past-room-${index}`, userId: index % 2 ? 'alice' : 'bob',
    opponent: { id: 'past-player', username: '過去の対戦相手', rating: 1500, guest: true },
    result: 'win', mode: 'rated', ratingDelta: 20, ratingBefore: 1480, ratingAfter: 1500,
    reason: 'all-revealed', createdAt: 1000 + index,
  }));
  const uncompressedBytes = Buffer.byteLength(JSON.stringify(state));
  assert.ok(uncompressedBytes > 128 * 1024, 'fixture must exceed the compression threshold');

  assert.equal(await store.commit(0, state), true);
  const raw = sqlite.prepare('SELECT state FROM arena_state WHERE id = 1').get().state;
  assert.ok(raw.startsWith('gzip:'), 'large persisted states must use the compressed format');
  assert.ok(Buffer.byteLength(raw) < uncompressedBytes / 2,
    'repetitive history should be substantially smaller even after base64 encoding');
  const loaded = await store.load();
  assert.deepEqual(loaded, { version: 1, state });
  const persistedGame = loaded.state.rooms['large-room'].game;
  assert.deepEqual(persistedGame, state.rooms['large-room'].game);
  assert.ok(persistedGame.deck.every(card => Number.isInteger(card.number)));
  assert.ok(persistedGame.players.flatMap(player => player.cards).every(card => Number.isInteger(card.number)));
  const spectator = viewGame(persistedGame, null);
  assert.ok(spectator.players.flatMap(player => player.cards).every(card => card.number === null));
  assert.equal(spectator.drawnCard.number, null);

  const first = await store.load();
  const second = await store.load();
  first.state.rooms['large-room'].name = 'concurrent first';
  second.state.rooms['large-room'].name = 'concurrent second';
  const results = await Promise.all([
    store.commit(first.version, first.state),
    store.commit(second.version, second.state),
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'only one same-version writer may win');
  const winner = results[0] ? first : second;
  assert.deepEqual(await store.load(), { version: 2, state: winner.state });
  assert.equal(await store.commit(0, state), false, 'stale initial insert may not replace compressed state');
  assert.deepEqual(await store.load(), { version: 2, state: winner.state });
});
