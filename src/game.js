// Going Once rules engine.
//
// Pure functions over a plain-object state. Only the host's browser runs them;
// everyone else receives publicView(), which leaves out the order of the lot
// deck and the cards played in the current round.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const HAND_SIZES = [7, 10, 13];
export const TIMER_OPTIONS = [0, 20, 40];
export const DEFAULT_SETTINGS = { handSize: 10, timer: 20 };
export const REVEAL_MS = 5500;
export const NAME_MAX = 16;
export const PLAYER_COLORS = [
  '#ff7a59', '#4fc3f7', '#a5d66b', '#ffd54f',
  '#ce93d8', '#4db6ac', '#f48fb1', '#bcaaa4',
];

const sum = (values) => values.reduce((a, b) => a + b, 0);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

export function cleanName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

function uniqueName(players, name, selfId) {
  const taken = new Set(players.filter((p) => p.id !== selfId).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function shuffle(values, rng) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function newPlayer(id, name, color) {
  return { id, name, color, score: 0, hand: [], lots: [], connected: true };
}

export function createRoom({ room, hostId, hostName, now }) {
  const name = cleanName(hostName) || 'Host';
  return {
    v: 1,
    room,
    hostId,
    epoch: now,
    phase: 'lobby',
    settings: { ...DEFAULT_SETTINGS },
    players: [newPlayer(hostId, name, PLAYER_COLORS[0])],
    deck: [],
    round: 0,
    prize: null,
    pot: [],
    bids: {},
    deadline: null,
    revealUntil: null,
    reveal: null,
    history: [],
    burned: [],
    endReason: null,
  };
}

function startRound(s, now) {
  s.round += 1;
  s.prize = s.deck.pop();
  s.bids = {};
  s.reveal = null;
  s.revealUntil = null;
  s.deadline = s.settings.timer ? now + s.settings.timer * 1000 : null;
  s.phase = 'bidding';
}

function finish(s, reason) {
  s.phase = 'over';
  s.endReason = reason;
  s.deadline = null;
  s.revealUntil = null;
  s.bids = {};
  if (s.pot.length) {
    s.burned.push(...s.pot);
    s.pot = [];
  }
  if (s.prize != null && reason !== 'complete') {
    s.burned.push(s.prize);
    s.prize = null;
  }
}

function resolve(s, now) {
  const bids = {};
  for (const p of s.players) bids[p.id] = s.bids[p.id];
  const highest = Math.max(...Object.values(bids));
  const top = s.players.filter((p) => bids[p.id] === highest);

  for (const p of s.players) p.hand = p.hand.filter((c) => c !== bids[p.id]);

  const stake = [...s.pot, s.prize];
  const value = sum(stake);
  const lastRound = s.deck.length === 0;
  let result;
  let winnerId = null;

  if (top.length === 1) {
    const winner = top[0];
    winnerId = winner.id;
    winner.lots.push(...stake);
    winner.score += value;
    s.pot = [];
    result = 'won';
  } else if (lastRound) {
    s.burned.push(...stake);
    s.pot = [];
    result = 'burned';
  } else {
    s.pot.push(s.prize);
    result = 'rolled';
  }

  s.reveal = { round: s.round, prize: s.prize, stake, value, bids, highest, winnerId, result };
  s.history.push(s.reveal);
  s.prize = null;
  s.bids = {};
  s.deadline = null;
  s.phase = 'reveal';
  s.revealUntil = now + REVEAL_MS;
}

function allIn(s) {
  return s.players.every((p) => s.bids[p.id] != null);
}

function removePlayer(s, pid, now) {
  const idx = s.players.findIndex((p) => p.id === pid);
  if (idx === -1) return false;
  s.players.splice(idx, 1);
  delete s.bids[pid];
  if (s.phase === 'bidding' || s.phase === 'reveal') {
    if (s.players.length < MIN_PLAYERS) finish(s, 'not-enough-players');
    else if (s.phase === 'bidding' && allIn(s)) resolve(s, now);
  }
  return true;
}

const fail = (state, error) => ({ state, error, changed: false });
const ok = (state) => ({ state, error: null, changed: true });

// Applies one action. Returns { state, error, changed } and never mutates the input.
export function apply(state, action, { now = Date.now(), rng = Math.random } = {}) {
  if (!action || typeof action.type !== 'string') return fail(state, 'bad-action');
  const s = structuredClone(state);
  const isHost = action.by === s.hostId;
  const player = s.players.find((p) => p.id === action.pid);

  switch (action.type) {
    case 'join': {
      const name = cleanName(action.name);
      if (typeof action.pid !== 'string' || !action.pid) return fail(state, 'bad-action');
      if (!name) return fail(state, 'bad-name');
      if (player) {
        player.connected = true;
        if (s.phase === 'lobby') player.name = uniqueName(s.players, name, player.id);
        return ok(s);
      }
      if (s.phase !== 'lobby') return fail(state, 'in-progress');
      if (s.players.length >= MAX_PLAYERS) return fail(state, 'full');
      const used = new Set(s.players.map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
      s.players.push(newPlayer(action.pid, uniqueName(s.players, name, null), color));
      return ok(s);
    }

    case 'leave': {
      if (action.pid === s.hostId) return fail(state, 'host-cannot-leave');
      return removePlayer(s, action.pid, now) ? ok(s) : fail(state, 'not-in-room');
    }

    case 'kick': {
      if (!isHost) return fail(state, 'not-host');
      if (action.target === s.hostId) return fail(state, 'bad-action');
      return removePlayer(s, action.target, now) ? ok(s) : fail(state, 'not-in-room');
    }

    case 'settings': {
      if (!isHost) return fail(state, 'not-host');
      if (s.phase !== 'lobby') return fail(state, 'in-progress');
      const next = { ...s.settings };
      if (action.handSize !== undefined) {
        if (!HAND_SIZES.includes(action.handSize)) return fail(state, 'bad-settings');
        next.handSize = action.handSize;
      }
      if (action.timer !== undefined) {
        if (!TIMER_OPTIONS.includes(action.timer)) return fail(state, 'bad-settings');
        next.timer = action.timer;
      }
      s.settings = next;
      return ok(s);
    }

    case 'start': {
      if (!isHost) return fail(state, 'not-host');
      if (s.phase !== 'lobby') return fail(state, 'in-progress');
      if (s.players.length < MIN_PLAYERS) return fail(state, 'need-players');
      const n = s.settings.handSize;
      for (const p of s.players) {
        p.hand = range(n);
        p.lots = [];
        p.score = 0;
      }
      s.deck = shuffle(range(n), rng);
      s.round = 0;
      s.pot = [];
      s.burned = [];
      s.history = [];
      s.endReason = null;
      startRound(s, now);
      return ok(s);
    }

    case 'bid': {
      if (s.phase !== 'bidding') return fail(state, 'not-bidding');
      if (!player) return fail(state, 'not-in-room');
      if (!Number.isInteger(action.card) || !player.hand.includes(action.card)) return fail(state, 'bad-card');
      if (s.bids[player.id] === action.card) return fail(state, 'unchanged');
      s.bids[player.id] = action.card;
      player.connected = true;
      if (allIn(s)) resolve(s, now);
      return ok(s);
    }

    case 'timeout': {
      if (s.phase !== 'bidding' || s.deadline == null) return fail(state, 'not-due');
      if (now < s.deadline) return fail(state, 'not-due');
      for (const p of s.players) {
        if (s.bids[p.id] == null) s.bids[p.id] = Math.min(...p.hand);
      }
      resolve(s, now);
      return ok(s);
    }

    case 'advance': {
      if (s.phase !== 'reveal') return fail(state, 'not-due');
      if (now < s.revealUntil) return fail(state, 'not-due');
      if (s.deck.length === 0) finish(s, 'complete');
      else startRound(s, now);
      return ok(s);
    }

    case 'rematch': {
      if (!isHost) return fail(state, 'not-host');
      if (s.phase !== 'over') return fail(state, 'not-over');
      for (const p of s.players) {
        p.hand = [];
        p.lots = [];
        p.score = 0;
      }
      Object.assign(s, {
        phase: 'lobby', deck: [], round: 0, prize: null, pot: [], bids: {},
        deadline: null, revealUntil: null, reveal: null, history: [], burned: [], endReason: null,
      });
      return ok(s);
    }

    case 'presence': {
      if (!player) return fail(state, 'not-in-room');
      const connected = Boolean(action.connected);
      if (player.connected === connected) return fail(state, 'unchanged');
      player.connected = connected;
      return ok(s);
    }

    default:
      return fail(state, 'bad-action');
  }
}

// Competition ranking: equal scores share a place.
export function standings(players) {
  const sorted = players.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let place = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) place = i + 1;
    return { ...p, place };
  });
}

export function totalLotValue(handSize) {
  return (handSize * (handSize + 1)) / 2;
}

// What every device is allowed to see.
export function publicView(s, now = Date.now()) {
  return {
    v: s.v,
    room: s.room,
    hostId: s.hostId,
    epoch: s.epoch,
    phase: s.phase,
    settings: { ...s.settings },
    round: s.round,
    totalRounds: s.settings.handSize,
    prize: s.prize,
    pot: s.pot.slice(),
    lotsLeft: s.deck.slice().sort((a, b) => a - b),
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      hand: p.hand.slice(),
      lots: p.lots.slice(),
      connected: p.connected,
      submitted: s.phase === 'bidding' && s.bids[p.id] != null,
    })),
    deadline: s.deadline,
    revealUntil: s.revealUntil,
    reveal: s.reveal,
    history: s.history,
    burned: s.burned.slice(),
    endReason: s.endReason,
    sentAt: now,
  };
}
