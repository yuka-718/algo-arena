/**
 * Two-player number deduction engine. Authoritative state stays on the server.
 * Never send a game object to a client: send viewGame(game, authenticatedId).
 *
 * Base rules: https://www.sansu-olympic.gr.jp/algo/how/2play/2play.htm
 * Sorting: https://www.sansu-olympic.gr.jp/algo/how/howto.htm
 * One game is one round. No point chips or jokers are used.
 * Site convention when the deck is empty: attacks are still mandatory and a
 * miss exposes a chosen hidden card, defaulting to the leftmost hidden card.
 */

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new GameError(code, message); };
const rank = card => card.number * 2 + (card.color === 'white' ? 1 : 0);
const sortCards = cards => cards.sort((a, b) => rank(a) - rank(b));
const clone = value => JSON.parse(JSON.stringify(value));

function randomSource(seed) {
  if (seed === undefined) {
    return () => {
      if (globalThis.crypto?.getRandomValues) {
        const value = new Uint32Array(1);
        globalThis.crypto.getRandomValues(value);
        return value[0] / 4294967296;
      }
      return Math.random();
    };
  }
  // A deterministic fixture seed is deliberately never included in client views.
  let value = 2166136261;
  for (const char of String(seed)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playerIndex(game, actorId) {
  return game.players.findIndex(player => player.id === actorId);
}

function requirePlayer(game, actorId) {
  const index = playerIndex(game, actorId);
  if (index < 0) fail('NOT_A_PLAYER', 'この対局の参加者ではありません。');
  return index;
}

function requireTurn(game, actorId) {
  const index = requirePlayer(game, actorId);
  if (game.status !== 'playing') fail('GAME_FINISHED', '対局は終了しています。');
  if (index !== game.currentPlayerIndex) fail('NOT_YOUR_TURN', '相手の手番です。');
  return index;
}

function beginTurn(game) {
  game.canStay = false;
  game.drawnCard = game.deck.length ? game.deck.shift() : null;
}

function placeDrawnCard(game, revealed) {
  if (!game.drawnCard) return null;
  const card = game.drawnCard;
  card.revealed = revealed;
  game.players[game.currentPlayerIndex].cards.push(card);
  sortCards(game.players[game.currentPlayerIndex].cards);
  game.drawnCard = null;
  return card;
}

function nextTurn(game) {
  game.currentPlayerIndex = 1 - game.currentPlayerIndex;
  game.turnNumber += 1;
  beginTurn(game);
}

function finish(game, winnerId, reason) {
  placeDrawnCard(game, false);
  game.status = 'finished';
  game.winnerId = winnerId;
  game.resultReason = reason;
  game.canStay = false;
}

function record(game, event) {
  const publicEvent = {
    ...event,
    winnerId: game.winnerId,
    nextPlayerId: game.status === 'playing'
      ? game.players[game.currentPlayerIndex].id : null,
  };
  game.history.push(publicEvent);
  game.lastEvent = publicEvent;
  // Returned data cannot be used by a caller to mutate the stored history.
  return clone(publicEvent);
}

/** Create serializable state. The first player immediately holds the first draw. */
export function createGame(playerIds, options = {}) {
  if (!Array.isArray(playerIds) || playerIds.length !== 2
    || playerIds.some(id => typeof id !== 'string' || !id.trim())
    || playerIds[0] === playerIds[1]) {
    fail('INVALID_PLAYERS', '異なる 2 人のプレイヤーが必要です。');
  }
  const random = randomSource(options.seed);
  const cards = ['black', 'white'].flatMap(color =>
    Array.from({ length: 12 }, (_, number) => ({ color, number, revealed: false })));
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  // IDs are assigned AFTER shuffling. An ID never encodes a card's value/color.
  cards.forEach((card, index) => { card.id = `card-${index}`; });
  let startingPlayerIndex;
  if (options.startingPlayer === undefined) startingPlayerIndex = Math.floor(random() * 2);
  else if (options.startingPlayer === 0 || options.startingPlayer === 1) {
    startingPlayerIndex = options.startingPlayer;
  } else {
    startingPlayerIndex = playerIds.indexOf(options.startingPlayer);
    if (startingPlayerIndex < 0) fail('INVALID_STARTER', '先手が正しくありません。');
  }
  const players = playerIds.map(id => ({ id, cards: [] }));
  for (let round = 0; round < 4; round += 1) {
    for (const player of players) player.cards.push(cards.shift());
  }
  players.forEach(player => sortCards(player.cards));
  const game = {
    version: 1,
    status: 'playing',
    players,
    deck: cards,
    currentPlayerIndex: startingPlayerIndex,
    drawnCard: null,
    canStay: false,
    turnNumber: 1,
    winnerId: null,
    resultReason: null,
    history: [],
    lastEvent: null,
  };
  beginTurn(game);
  record(game, { type: 'start', actorId: players[startingPlayerIndex].id, turnNumber: 1 });
  return game;
}

/**
 * Guess one unrevealed opponent card. A successful attack may be followed by
 * another attack or stay(). A miss ends the turn. All validation is atomic.
 * exposureCardId is an optional own hidden-card choice used only without a draw.
 */
export function attack(game, actorId, targetCardId, guess, exposureCardId) {
  const index = requireTurn(game, actorId);
  if (!Number.isInteger(guess) || guess < 0 || guess > 11) {
    fail('INVALID_GUESS', '数字は 0〜11 の整数で指定してください。');
  }
  const opponent = game.players[1 - index];
  const target = opponent.cards.find(card => card.id === targetCardId);
  if (!target) fail('INVALID_TARGET', '相手のカードを選んでください。');
  if (target.revealed) fail('CARD_REVEALED', 'すでに公開されたカードです。');

  let penaltyCard = null;
  if (!game.drawnCard) {
    penaltyCard = exposureCardId === undefined
      ? game.players[index].cards.find(card => !card.revealed)
      : game.players[index].cards.find(card => card.id === exposureCardId && !card.revealed);
    if (!penaltyCard) fail('INVALID_EXPOSURE', '公開する自分の伏せ札を選んでください。');
  }

  const turnNumber = game.turnNumber;
  const success = target.number === guess;
  let exposedCard = null;
  if (success) {
    target.revealed = true;
    game.canStay = true;
    if (opponent.cards.every(card => card.revealed)) finish(game, actorId, 'all-revealed');
  } else {
    if (game.drawnCard) exposedCard = placeDrawnCard(game, true);
    else {
      penaltyCard.revealed = true;
      exposedCard = penaltyCard;
    }
    if (game.players[index].cards.every(card => card.revealed)) {
      finish(game, opponent.id, 'all-revealed');
    } else nextTurn(game);
  }
  return record(game, {
    type: 'attack', actorId, targetCardId, guess, success, turnNumber,
    exposedCard: exposedCard ? { ...exposedCard } : null,
    turnComplete: !success || game.status === 'finished',
  });
}

/** Stay is legal only after a correct guess during this turn. */
export function stay(game, actorId) {
  requireTurn(game, actorId);
  if (!game.canStay) fail('ATTACK_REQUIRED', 'まず 1 回アタックしてください。');
  const turnNumber = game.turnNumber;
  placeDrawnCard(game, false);
  nextTurn(game);
  return record(game, { type: 'stay', actorId, turnNumber });
}

/** Either participant may resign at any point in an active game. */
export function resign(game, actorId) {
  const index = requirePlayer(game, actorId);
  if (game.status !== 'playing') fail('GAME_FINISHED', '対局は終了しています。');
  const turnNumber = game.turnNumber;
  finish(game, game.players[1 - index].id, 'resigned');
  return record(game, { type: 'resign', actorId, turnNumber });
}

/**
 * Safe snapshot for a participant, or a spectator when actorId is null/absent.
 * The deck, RNG state and every concealed opponent number are always excluded,
 * including after resignation. The returned object shares no mutable state.
 */
export function viewGame(game, actorId = null) {
  const ownIndex = actorId === null ? -1 : requirePlayer(game, actorId);
  const showCard = (card, isOwn) => ({
    id: card.id, color: card.color,
    number: isOwn || card.revealed ? card.number : null,
    revealed: card.revealed,
  });
  return {
    version: game.version,
    status: game.status,
    players: game.players.map((player, index) => ({
      id: player.id,
      cards: player.cards.map(card => showCard(card, index === ownIndex)),
    })),
    yourPlayerId: ownIndex < 0 ? null : game.players[ownIndex].id,
    currentPlayerIndex: game.status === 'playing' ? game.currentPlayerIndex : null,
    currentPlayerId: game.status === 'playing' ? game.players[game.currentPlayerIndex].id : null,
    drawnCard: game.drawnCard
      ? showCard(game.drawnCard, ownIndex === game.currentPlayerIndex) : null,
    deckCount: game.deck.length,
    canStay: game.status === 'playing' && game.canStay && ownIndex === game.currentPlayerIndex,
    turnNumber: game.turnNumber,
    winnerId: game.winnerId,
    resultReason: game.resultReason,
    history: clone(game.history),
    lastEvent: clone(game.lastEvent),
  };
}

/**
 * Compute compatible sorted opponent rows from the bot's safe view only.
 * Forward/backward counts give each guess a probability without reading hidden
 * numbers or the deck. Prior public wrong guesses are also excluded.
 */
function findBestGuess(snapshot) {
  const ownIndex = snapshot.players.findIndex(player => player.id === snapshot.yourPlayerId);
  const own = snapshot.players[ownIndex];
  const opponent = snapshot.players[1 - ownIndex];
  const unavailable = new Set(own.cards.map(rank));
  if (snapshot.drawnCard) unavailable.add(rank(snapshot.drawnCard));
  const misses = new Map();
  for (const event of snapshot.history) {
    if (event.type !== 'attack' || event.success) continue;
    if (!misses.has(event.targetCardId)) misses.set(event.targetCardId, new Set());
    misses.get(event.targetCardId).add(event.guess);
  }
  const choices = opponent.cards.map(card => {
    if (card.revealed) return [rank(card)];
    return Array.from({ length: 12 }, (_, number) => ({ color: card.color, number }))
      .filter(candidate => !unavailable.has(rank(candidate))
        && !misses.get(card.id)?.has(candidate.number))
      .map(rank);
  });
  const n = choices.length;
  const forward = choices.map(() => new Map());
  const backward = choices.map(() => new Map());
  for (let i = 0; i < n; i += 1) {
    for (const value of choices[i]) {
      forward[i].set(value, i === 0 ? 1 : [...forward[i - 1]]
        .reduce((total, [previous, count]) => total + (previous < value ? count : 0), 0));
    }
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    for (const value of choices[i]) {
      backward[i].set(value, i === n - 1 ? 1 : [...backward[i + 1]]
        .reduce((total, [next, count]) => total + (next > value ? count : 0), 0));
    }
  }
  const total = [...forward[n - 1].values()].reduce((sum, count) => sum + count, 0);
  let best = null;
  for (let i = 0; i < n; i += 1) {
    if (opponent.cards[i].revealed) continue;
    for (const value of choices[i]) {
      const probability = total ? forward[i].get(value) * backward[i].get(value) / total : 0;
      if (!best || probability > best.probability) {
        best = { type: 'attack', targetCardId: opponent.cards[i].id,
          guess: Math.floor(value / 2), probability };
      }
    }
  }
  return best;
}

/** Return {type:'attack',targetCardId,guess} or {type:'stay'}, without mutations. */
export function chooseBotMove(game, actorId) {
  requireTurn(game, actorId);
  // Knowledge boundary: the rest of the policy sees only this projection.
  const snapshot = viewGame(game, actorId);
  const best = findBestGuess(snapshot);
  if (!best) fail('NO_LEGAL_MOVE', 'アタックできるカードがありません。');
  if (snapshot.canStay && best.probability < 0.6) return { type: 'stay' };
  return { type: 'attack', targetCardId: best.targetCardId, guess: best.guess };
}
