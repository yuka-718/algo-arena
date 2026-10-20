import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, attack, stay, resign, viewGame, chooseBotMove, GameError,
} from '../shared/engine.js';

const gameFor = (seed = 'test') => createGame(['alice', 'bob'], { seed, startingPlayer: 'alice' });
const currentId = game => game.players[game.currentPlayerIndex].id;
const opponent = game => game.players[1 - game.currentPlayerIndex];
const hiddenTarget = game => opponent(game).cards.find(card => !card.revealed);
const allCards = game => [...game.players.flatMap(player => player.cards),
  ...game.deck, ...(game.drawnCard ? [game.drawnCard] : [])];
const rank = card => card.number * 2 + (card.color === 'white' ? 1 : 0);

function assertConserved(game) {
  const cards = allCards(game);
  assert.equal(cards.length, 24);
  assert.equal(new Set(cards.map(card => card.id)).size, 24);
  assert.equal(new Set(cards.map(card => `${card.color}:${card.number}`)).size, 24);
  for (const player of game.players) {
    const ranks = player.cards.map(rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  }
}

function assertRejectedWithoutMutation(game, callback, code) {
  const before = JSON.stringify(game);
  assert.throws(callback, error => error instanceof GameError && error.code === code);
  assert.equal(JSON.stringify(game), before);
}

function miss(game, exposureCardId) {
  const target = hiddenTarget(game);
  return attack(game, currentId(game), target.id, (target.number + 1) % 12, exposureCardId);
}

function exhaustDeck(game) {
  // There are 16 post-deal cards. Deliberate misses preserve initial hidden rows.
  for (let turn = 0; turn < 16; turn += 1) {
    assert.ok(game.drawnCard);
    miss(game);
    assertConserved(game);
    assert.equal(game.status, 'playing');
  }
  assert.equal(game.deck.length, 0);
  assert.equal(game.drawnCard, null);
}

test('deal uses the complete unique 24-card set; rows follow number/color ordering', () => {
  for (let seed = 0; seed < 30; seed += 1) {
    const game = gameFor(seed);
    assertConserved(game);
    assert.deepEqual(game.players.map(player => player.cards.length), [4, 4]);
    assert.equal(game.deck.length, 15);
    assert.ok(game.drawnCard);
    assert.equal(game.canStay, false);
    assert.equal(game.players.every(player => player.cards.every(card => !card.revealed)), true);
    assert.equal(currentId(game), 'alice');
  }
  assert.deepEqual(gameFor('same'), gameFor('same'));
  assert.equal(currentId(createGame(['alice', 'bob'], { startingPlayer: 1 })), 'bob');
});

test('invalid players and starter are rejected', () => {
  for (const ids of [[], ['alice'], ['a', 'a'], ['a', 'b', 'c'], ['', 'b'], [1, 2]]) {
    assert.throws(() => createGame(ids), { code: 'INVALID_PLAYERS' });
  }
  assert.throws(() => createGame(['a', 'b'], { startingPlayer: 'stranger' }), { code: 'INVALID_STARTER' });
});

test('client projections hide all opponent numbers and deck contents with independent objects', () => {
  const game = gameFor();
  const alice = viewGame(game, 'alice');
  const bob = viewGame(game, 'bob');
  const spectator = viewGame(game, null);
  assert.throws(() => viewGame(game, 'stranger'), { code: 'NOT_A_PLAYER' });
  assert.equal(Object.hasOwn(alice, 'deck'), false);
  assert.equal(Object.hasOwn(alice, 'seed'), false);
  assert.equal(alice.deckCount, 15);
  assert.ok(alice.players[0].cards.every(card => Number.isInteger(card.number)));
  assert.ok(alice.players[1].cards.every(card => card.number === null));
  assert.ok(bob.players[0].cards.every(card => card.number === null));
  assert.equal(alice.drawnCard.number, game.drawnCard.number);
  assert.equal(bob.drawnCard.number, null);
  assert.equal(spectator.yourPlayerId, null);
  assert.ok(spectator.players.flatMap(player => player.cards).every(card => card.number === null));
  assert.equal(spectator.drawnCard.number, null);

  alice.players[0].cards[0].number = 999;
  alice.history[0].actorId = 'evil';
  alice.lastEvent.actorId = 'evil';
  assert.notEqual(game.players[0].cards[0].number, 999);
  assert.equal(game.history[0].actorId, 'alice');
  assert.equal(game.lastEvent.actorId, 'alice');
});

test('turn, target, guess and stay validation are atomic', () => {
  const game = gameFor();
  const target = hiddenTarget(game);
  assertRejectedWithoutMutation(game, () => stay(game, 'alice'), 'ATTACK_REQUIRED');
  assertRejectedWithoutMutation(game, () => attack(game, 'bob', target.id, 0), 'NOT_YOUR_TURN');
  assertRejectedWithoutMutation(game, () => attack(game, 'stranger', target.id, 0), 'NOT_A_PLAYER');
  assertRejectedWithoutMutation(game, () => attack(game, 'alice', game.players[0].cards[0].id, 0), 'INVALID_TARGET');
  assertRejectedWithoutMutation(game, () => attack(game, 'alice', game.drawnCard.id, 0), 'INVALID_TARGET');
  for (const guess of [-1, 12, 2.5, '2', NaN, undefined]) {
    assertRejectedWithoutMutation(game, () => attack(game, 'alice', target.id, guess), 'INVALID_GUESS');
  }
  attack(game, 'alice', target.id, target.number);
  assertRejectedWithoutMutation(game, () => attack(game, 'alice', target.id, target.number), 'CARD_REVEALED');
  assertConserved(game);
});

test('miss exposes and inserts only the drawn card, then automatically draws for the next player', () => {
  const game = gameFor();
  const held = { ...game.drawnCard };
  const target = { ...hiddenTarget(game) };
  const event = miss(game);
  assert.equal(event.type, 'attack');
  assert.equal(event.success, false);
  assert.equal(event.turnComplete, true);
  assert.equal(event.exposedCard.id, held.id);
  assert.equal(event.exposedCard.number, held.number);
  assert.equal(game.players[0].cards.find(card => card.id === held.id).revealed, true);
  assert.equal(game.players[1].cards.find(card => card.id === target.id).revealed, false);
  assert.equal(currentId(game), 'bob');
  assert.equal(game.turnNumber, 2);
  assert.equal(game.deck.length, 14);
  assert.equal(game.canStay, false);
  const seenByBob = viewGame(game, 'bob');
  assert.equal(seenByBob.players[0].cards.find(card => card.id === held.id).number, held.number);
  assert.ok(seenByBob.players[0].cards.filter(card => card.id !== held.id).every(card => card.number === null));
  event.exposedCard.number = 777;
  assert.equal(game.lastEvent.exposedCard.number, held.number);
  assertConserved(game);
});

test('correct attacks reuse the held card, permit continuation, and stay inserts it concealed', () => {
  const game = gameFor();
  const held = { ...game.drawnCard };
  const startingDeckCount = game.deck.length;
  for (let i = 0; i < 2; i += 1) {
    const target = hiddenTarget(game);
    const event = attack(game, 'alice', target.id, target.number);
    assert.equal(event.success, true);
    assert.equal(event.exposedCard, null);
    assert.equal(game.currentPlayerIndex, 0);
    assert.equal(game.drawnCard.id, held.id);
    assert.equal(game.deck.length, startingDeckCount);
    assert.equal(viewGame(game, 'alice').canStay, true);
    assert.equal(viewGame(game, 'bob').canStay, false);
  }
  stay(game, 'alice');
  assert.equal(currentId(game), 'bob');
  const inserted = game.players[0].cards.find(card => card.id === held.id);
  assert.equal(inserted.revealed, false);
  assert.equal(viewGame(game, 'bob').players[0].cards.find(card => card.id === held.id).number, null);
  assert.equal(game.players[0].cards.length, 5);
  assert.equal(game.deck.length, startingDeckCount - 1);
  assertRejectedWithoutMutation(game, () => stay(game, 'bob'), 'ATTACK_REQUIRED');
  assertConserved(game);
});

test('a miss after a correct guess still exposes the same drawn card', () => {
  const game = gameFor();
  const heldId = game.drawnCard.id;
  const target = hiddenTarget(game);
  attack(game, 'alice', target.id, target.number);
  miss(game);
  assert.equal(game.players[0].cards.find(card => card.id === heldId).revealed, true);
  assert.equal(currentId(game), 'bob');
  assert.equal(game.canStay, false);
  assertConserved(game);
});

test('revealing the final opponent card ends immediately without drawing another card', () => {
  const game = gameFor();
  const heldId = game.drawnCard.id;
  const remainingDeck = game.deck.length;
  for (const target of [...game.players[1].cards]) attack(game, 'alice', target.id, target.number);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'alice');
  assert.equal(game.resultReason, 'all-revealed');
  assert.equal(game.deck.length, remainingDeck);
  assert.equal(game.drawnCard, null);
  assert.equal(game.players[0].cards.find(card => card.id === heldId).revealed, false);
  assert.equal(viewGame(game, 'alice').currentPlayerId, null);
  assert.equal(game.lastEvent.nextPlayerId, null);
  assertRejectedWithoutMutation(game, () => stay(game, 'alice'), 'GAME_FINISHED');
  assertRejectedWithoutMutation(game, () => resign(game, 'bob'), 'GAME_FINISHED');
  assertConserved(game);
});

test('empty deck requires an attack; a miss reveals an own hidden card and still alternates', () => {
  const game = gameFor('empty');
  exhaustDeck(game);
  const actor = currentId(game);
  const own = game.players[game.currentPlayerIndex];
  const leftmost = own.cards.find(card => !card.revealed);
  assertRejectedWithoutMutation(game, () => stay(game, actor), 'ATTACK_REQUIRED');
  assertRejectedWithoutMutation(game, () => miss(game, 'nonexistent'), 'INVALID_EXPOSURE');
  const event = miss(game);
  assert.equal(event.exposedCard.id, leftmost.id);
  assert.equal(leftmost.revealed, true);
  assert.notEqual(currentId(game), actor);
  assert.equal(game.deck.length, 0);
  assert.equal(game.drawnCard, null);
  assertConserved(game);
});

test('empty-deck penalty can select an own hidden card and rejects revealed/opponent choices', () => {
  const game = gameFor('choose-penalty');
  exhaustDeck(game);
  const own = game.players[game.currentPlayerIndex];
  const hidden = own.cards.filter(card => !card.revealed);
  const chosen = hidden.at(-1);
  assertRejectedWithoutMutation(game, () => miss(game, own.cards.find(card => card.revealed).id), 'INVALID_EXPOSURE');
  assertRejectedWithoutMutation(game, () => miss(game, hiddenTarget(game).id), 'INVALID_EXPOSURE');
  const event = miss(game, chosen.id);
  assert.equal(event.exposedCard.id, chosen.id);
  assert.equal(chosen.revealed, true);
  assert.equal(hidden[0].revealed, false);
});

test('correct empty-deck attacks can continue or stay, without adding phantom cards', () => {
  const game = gameFor('empty-success');
  exhaustDeck(game);
  const actor = currentId(game);
  const target = hiddenTarget(game);
  const sizes = game.players.map(player => player.cards.length);
  attack(game, actor, target.id, target.number);
  assert.equal(game.canStay, true);
  assert.equal(currentId(game), actor);
  assert.equal(game.drawnCard, null);
  stay(game, actor);
  assert.deepEqual(game.players.map(player => player.cards.length), sizes);
  assert.notEqual(currentId(game), actor);
  assertConserved(game);
});

test('empty-deck misses eventually lose when the last own card is revealed', () => {
  const game = gameFor('empty-finish');
  exhaustDeck(game);
  let loser;
  let count = 0;
  while (game.status === 'playing') {
    loser = currentId(game);
    miss(game);
    count += 1;
    assertConserved(game);
    assert.ok(count <= 8, 'the no-deck rule must make progress');
  }
  assert.equal(game.resultReason, 'all-revealed');
  assert.notEqual(game.winnerId, loser);
  assert.equal(game.players.find(player => player.id === loser).cards.every(card => card.revealed), true);
});

test('non-current player can resign; hidden numbers and deck stay concealed afterward', () => {
  const game = gameFor();
  const deckCount = game.deck.length;
  assertRejectedWithoutMutation(game, () => resign(game, 'stranger'), 'NOT_A_PLAYER');
  resign(game, 'bob');
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'alice');
  assert.equal(game.resultReason, 'resigned');
  assert.equal(game.deck.length, deckCount);
  assert.ok(viewGame(game, 'alice').players[1].cards.every(card => card.number === null));
  assert.equal(Object.hasOwn(viewGame(game, 'alice'), 'deck'), false);
  assertConserved(game);
});

test('bot action is independent of concealed opponent numbers and deck order', () => {
  const game = gameFor('bot-knowledge');
  const original = JSON.stringify(game);
  const expected = chooseBotMove(game, 'alice');
  assert.equal(JSON.stringify(game), original, 'choosing must not mutate state');
  const alternative = JSON.parse(original);
  // Poison private values with throwing getters. The bot must use only the
  // unchanged public projection, including after deck order changes.
  const ownView = viewGame(game, 'alice');
  alternative.deck.reverse();
  for (const card of alternative.players[1].cards) {
    Object.defineProperty(card, 'number', {
      get() { throw new Error('bot read a hidden opponent number'); }, enumerable: true,
    });
  }
  for (const card of alternative.deck) {
    Object.defineProperty(card, 'number', {
      get() { throw new Error('bot read the deck'); }, enumerable: true,
    });
  }
  assert.deepEqual(viewGame(alternative, 'alice'), ownView);
  assert.deepEqual(chooseBotMove(alternative, 'alice'), expected);
  assert.equal(expected.type, 'attack');
  assert.ok(game.players[1].cards.some(card => card.id === expected.targetCardId && !card.revealed));
  assert.ok(Number.isInteger(expected.guess) && expected.guess >= 0 && expected.guess <= 11);
});

test('bots complete full legal games with serialized state round-trips', () => {
  for (let seed = 0; seed < 25; seed += 1) {
    let game = gameFor(`bot-match-${seed}`);
    let actions = 0;
    while (game.status === 'playing') {
      const actor = currentId(game);
      const move = chooseBotMove(game, actor);
      if (move.type === 'stay') stay(game, actor);
      else {
        const target = opponent(game).cards.find(card => card.id === move.targetCardId);
        assert.ok(target && !target.revealed);
        const knownOwn = [...game.players[game.currentPlayerIndex].cards,
          ...(game.drawnCard ? [game.drawnCard] : [])];
        assert.ok(!knownOwn.some(card => card.color === target.color && card.number === move.guess),
          'the bot must exclude its own known cards');
        assert.ok(!game.history.some(event => event.type === 'attack' && !event.success
          && event.targetCardId === move.targetCardId && event.guess === move.guess),
        'the bot must remember public failed guesses');
        attack(game, actor, move.targetCardId, move.guess);
      }
      assertConserved(game);
      game = JSON.parse(JSON.stringify(game));
      actions += 1;
      assert.ok(actions < 160, `seed ${seed} did not terminate`);
    }
    assert.ok(['alice', 'bob'].includes(game.winnerId));
  }
});
