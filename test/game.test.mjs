import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apply, createRoom, publicView, standings, cleanName, totalLotValue,
  MAX_PLAYERS, REVEAL_MS, PLAYER_COLORS,
} from '../src/game.js';
import {
  ALPHABET, BROKERS, brokerIndexFor, makeRoomCode, normalizeCode, topics,
} from '../src/protocol.js';

// Deterministic generator so deck order is reproducible.
function seeded(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const T0 = 1_000_000;

function must(result) {
  assert.equal(result.error, null, `unexpected error ${result.error}`);
  return result.state;
}

function room(names = ['Ana', 'Ben'], settings = {}) {
  let s = createRoom({ room: 'ABCD', hostId: 'h', hostName: names[0], now: T0 });
  names.slice(1).forEach((name, i) => {
    s = must(apply(s, { type: 'join', pid: `p${i + 1}`, name }, { now: T0 }));
  });
  if (Object.keys(settings).length) s = must(apply(s, { type: 'settings', by: 'h', ...settings }, { now: T0 }));
  return s;
}

function started(names, settings, seed = 1) {
  return must(apply(room(names, settings), { type: 'start', by: 'h' }, { now: T0, rng: seeded(seed) }));
}

const ids = (s) => s.players.map((p) => p.id);

test('join assigns distinct colors, dedupes names and caps the room at 8', () => {
  let s = room(['Ana', 'ana', 'Ana']);
  assert.deepEqual(s.players.map((p) => p.name), ['Ana', 'ana 2', 'Ana 3']);
  assert.equal(new Set(s.players.map((p) => p.color)).size, 3);
  for (let i = s.players.length; i < MAX_PLAYERS; i++) {
    s = must(apply(s, { type: 'join', pid: `x${i}`, name: `P${i}` }));
  }
  assert.equal(s.players.length, MAX_PLAYERS);
  assert.deepEqual(s.players.map((p) => p.color), PLAYER_COLORS);
  assert.equal(apply(s, { type: 'join', pid: 'late', name: 'Late' }).error, 'full');
});

test('rejoining with the same id keeps one seat and blank names are rejected', () => {
  let s = room(['Ana', 'Ben']);
  s = must(apply(s, { type: 'join', pid: 'p1', name: 'Benny' }));
  assert.equal(s.players.length, 2);
  assert.equal(s.players[1].name, 'Benny');
  assert.equal(apply(s, { type: 'join', pid: 'p9', name: '  \u0007 ' }).error, 'bad-name');
  assert.equal(cleanName('  a\u0000b   c  '), 'ab c');
  assert.equal(cleanName('x'.repeat(40)).length, 16);
});

test('only the host may change settings or start, and start needs two players', () => {
  const solo = room(['Ana']);
  assert.equal(apply(solo, { type: 'start', by: 'h' }).error, 'need-players');
  const s = room(['Ana', 'Ben']);
  assert.equal(apply(s, { type: 'start', by: 'p1' }).error, 'not-host');
  assert.equal(apply(s, { type: 'settings', by: 'p1', handSize: 7 }).error, 'not-host');
  assert.equal(apply(s, { type: 'settings', by: 'h', handSize: 9 }).error, 'bad-settings');
  assert.equal(apply(s, { type: 'settings', by: 'h', timer: 15 }).error, 'bad-settings');
  const t = must(apply(s, { type: 'settings', by: 'h', handSize: 13, timer: 0 }));
  assert.deepEqual(t.settings, { handSize: 13, timer: 0 });
});

test('start deals every player 1..N and flips the first lot from a shuffled deck', () => {
  const s = started(['Ana', 'Ben', 'Cy'], { handSize: 7, timer: 20 });
  assert.equal(s.phase, 'bidding');
  assert.equal(s.round, 1);
  for (const p of s.players) assert.deepEqual(p.hand, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...s.deck, s.prize].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(s.deadline, T0 + 20_000);
  assert.equal(apply(room(['Ana', 'Ben']), { type: 'join', pid: 'z', name: 'Z' }).error, null);
  assert.equal(apply(s, { type: 'join', pid: 'z', name: 'Z' }).error, 'in-progress');
});

test('a bid must be a card still in hand, and can be changed until everyone is in', () => {
  let s = started(['Ana', 'Ben', 'Cy'], { handSize: 7 });
  assert.equal(apply(s, { type: 'bid', pid: 'h', card: 8 }).error, 'bad-card');
  assert.equal(apply(s, { type: 'bid', pid: 'h', card: '3' }).error, 'bad-card');
  assert.equal(apply(s, { type: 'bid', pid: 'ghost', card: 3 }).error, 'not-in-room');
  s = must(apply(s, { type: 'bid', pid: 'h', card: 3 }));
  assert.equal(apply(s, { type: 'bid', pid: 'h', card: 3 }).error, 'unchanged');
  s = must(apply(s, { type: 'bid', pid: 'h', card: 6 }));
  s = must(apply(s, { type: 'bid', pid: 'p1', card: 2 }));
  assert.equal(s.phase, 'bidding');
  s = must(apply(s, { type: 'bid', pid: 'p2', card: 5 }, { now: T0 + 100 }));
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(s.reveal.bids, { h: 6, p1: 2, p2: 5 });
  assert.equal(s.reveal.winnerId, 'h');
  assert.equal(s.revealUntil, T0 + 100 + REVEAL_MS);
  assert.deepEqual(s.players[0].hand, [1, 2, 3, 4, 5, 7]);
  assert.deepEqual(s.players[1].hand, [1, 3, 4, 5, 6, 7]);
});

test('the single highest card wins the lot and any rolled-over pot', () => {
  let s = started(['Ana', 'Ben', 'Cy'], { handSize: 7 }, 3);
  const firstPrize = s.prize;
  s = must(apply(s, { type: 'bid', pid: 'h', card: 7 }));
  s = must(apply(s, { type: 'bid', pid: 'p1', card: 7 }));
  s = must(apply(s, { type: 'bid', pid: 'p2', card: 1 }));
  assert.equal(s.reveal.result, 'rolled');
  assert.equal(s.reveal.winnerId, null);
  assert.deepEqual(s.pot, [firstPrize]);
  assert.equal(s.players.every((p) => p.score === 0), true);

  assert.equal(apply(s, { type: 'advance' }, { now: s.revealUntil - 1 }).error, 'not-due');
  s = must(apply(s, { type: 'advance' }, { now: s.revealUntil }));
  const secondPrize = s.prize;
  s = must(apply(s, { type: 'bid', pid: 'h', card: 2 }));
  s = must(apply(s, { type: 'bid', pid: 'p1', card: 3 }));
  s = must(apply(s, { type: 'bid', pid: 'p2', card: 6 }));
  assert.equal(s.reveal.result, 'won');
  assert.equal(s.reveal.winnerId, 'p2');
  assert.equal(s.reveal.value, firstPrize + secondPrize);
  assert.equal(s.players[2].score, firstPrize + secondPrize);
  assert.deepEqual(s.players[2].lots.sort(), [firstPrize, secondPrize].sort());
  assert.deepEqual(s.pot, []);
});

test('the timer plays the lowest card left for anyone who has not bid', () => {
  let s = started(['Ana', 'Ben', 'Cy'], { handSize: 7, timer: 20 });
  s = must(apply(s, { type: 'bid', pid: 'p1', card: 4 }));
  assert.equal(apply(s, { type: 'timeout' }, { now: s.deadline - 1 }).error, 'not-due');
  s = must(apply(s, { type: 'timeout' }, { now: s.deadline }));
  assert.deepEqual(s.reveal.bids, { h: 1, p1: 4, p2: 1 });
  assert.equal(s.reveal.winnerId, 'p1');

  const untimed = started(['Ana', 'Ben'], { handSize: 7, timer: 0 });
  assert.equal(untimed.deadline, null);
  assert.equal(apply(untimed, { type: 'timeout' }, { now: T0 + 1e9 }).error, 'not-due');
});

test('a tie on the last round burns the stake instead of rolling it', () => {
  let s = started(['Ana', 'Ben'], { handSize: 7 }, 5);
  let now = T0;
  // Mirror every bid so every round ties.
  for (let r = 1; r <= 7; r++) {
    const card = s.players[0].hand[0];
    s = must(apply(s, { type: 'bid', pid: 'h', card }, { now }));
    s = must(apply(s, { type: 'bid', pid: 'p1', card }, { now }));
    assert.equal(s.reveal.result, r < 7 ? 'rolled' : 'burned');
    now = s.revealUntil;
    s = must(apply(s, { type: 'advance' }, { now }));
  }
  assert.equal(s.phase, 'over');
  assert.equal(s.endReason, 'complete');
  assert.equal(s.players[0].score + s.players[1].score, 0);
  assert.equal(s.burned.reduce((a, b) => a + b, 0), totalLotValue(7));
  const ranks = standings(s.players);
  assert.deepEqual(ranks.map((p) => p.place), [1, 1]);
});

test('a full random game conserves every lot point and ends after N rounds', () => {
  for (const [names, handSize, seed] of [[['A', 'B'], 7, 11], [['A', 'B', 'C', 'D', 'E'], 10, 12], [['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 13, 13]]) {
    const rng = seeded(seed);
    let s = started(names, { handSize }, seed);
    let now = T0;
    let rounds = 0;
    while (s.phase !== 'over') {
      assert.equal(s.phase, 'bidding');
      rounds += 1;
      for (const p of s.players) {
        const card = p.hand[Math.floor(rng() * p.hand.length)];
        s = must(apply(s, { type: 'bid', pid: p.id, card }, { now }));
      }
      now = s.revealUntil;
      s = must(apply(s, { type: 'advance' }, { now }));
    }
    assert.equal(rounds, handSize);
    assert.equal(s.history.length, handSize);
    assert.ok(s.players.every((p) => p.hand.length === 0));
    const scored = s.players.reduce((a, p) => a + p.score, 0);
    const burned = s.burned.reduce((a, b) => a + b, 0);
    assert.equal(scored + burned, totalLotValue(handSize));
    for (const p of s.players) assert.equal(p.lots.reduce((a, b) => a + b, 0), p.score);
  }
});

test('leaving mid-game resolves the round if everyone left has bid, and ends it below two players', () => {
  let s = started(['Ana', 'Ben', 'Cy'], { handSize: 7 });
  s = must(apply(s, { type: 'bid', pid: 'h', card: 5 }));
  s = must(apply(s, { type: 'bid', pid: 'p1', card: 4 }));
  s = must(apply(s, { type: 'leave', pid: 'p2' }));
  assert.deepEqual(ids(s), ['h', 'p1']);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.reveal.winnerId, 'h');
  assert.equal(apply(s, { type: 'leave', pid: 'h' }).error, 'host-cannot-leave');
  assert.equal(apply(s, { type: 'kick', by: 'p1', target: 'h' }).error, 'not-host');
  s = must(apply(s, { type: 'kick', by: 'h', target: 'p1' }));
  assert.equal(s.phase, 'over');
  assert.equal(s.endReason, 'not-enough-players');
});

test('rematch returns everyone to the lobby with scores cleared', () => {
  let s = started(['Ana', 'Ben'], { handSize: 7 }, 9);
  let now = T0;
  while (s.phase !== 'over') {
    s = must(apply(s, { type: 'bid', pid: 'h', card: s.players[0].hand.at(-1) }, { now }));
    s = must(apply(s, { type: 'bid', pid: 'p1', card: s.players[1].hand[0] }, { now }));
    now = s.revealUntil;
    s = must(apply(s, { type: 'advance' }, { now }));
  }
  assert.equal(apply(s, { type: 'rematch', by: 'p1' }).error, 'not-host');
  s = must(apply(s, { type: 'rematch', by: 'h' }));
  assert.equal(s.phase, 'lobby');
  assert.ok(s.players.every((p) => p.score === 0 && p.hand.length === 0 && p.lots.length === 0));
  assert.deepEqual(s.history, []);
  assert.equal(apply(s, { type: 'join', pid: 'new', name: 'Newbie' }).error, null);
});

test('the public view hides the deck order and live bids but shows who has played', () => {
  let s = started(['Ana', 'Ben', 'Cy'], { handSize: 10 }, 21);
  s = must(apply(s, { type: 'bid', pid: 'p1', card: 9 }));
  const view = publicView(s, T0);
  const text = JSON.stringify(view);
  assert.equal('deck' in view, false);
  assert.equal('bids' in view, false);
  assert.deepEqual(view.lotsLeft, s.deck.slice().sort((a, b) => a - b));
  assert.deepEqual(view.players.map((p) => p.submitted), [false, true, false]);
  assert.equal(text.includes('"bids"'), false, 'no bids map before the reveal');
  // Positive control: once revealed, the bids are part of the view.
  s = must(apply(s, { type: 'bid', pid: 'h', card: 1 }));
  s = must(apply(s, { type: 'bid', pid: 'p2', card: 2 }));
  assert.equal(JSON.stringify(publicView(s, T0)).includes('"bids"'), true);
});

test('presence flags change only for seated players', () => {
  let s = room(['Ana', 'Ben']);
  s = must(apply(s, { type: 'presence', pid: 'p1', connected: false }));
  assert.equal(s.players[1].connected, false);
  assert.equal(apply(s, { type: 'presence', pid: 'p1', connected: false }).error, 'unchanged');
  assert.equal(apply(s, { type: 'presence', pid: 'zz', connected: true }).error, 'not-in-room');
});

test('apply never mutates its input state', () => {
  const s = started(['Ana', 'Ben'], { handSize: 7 });
  const before = JSON.stringify(s);
  apply(s, { type: 'bid', pid: 'h', card: 3 });
  apply(s, { type: 'leave', pid: 'p1' });
  assert.equal(JSON.stringify(s), before);
});

test('room codes route to their broker and reject ambiguous letters', () => {
  assert.equal(ALPHABET.length, 24);
  assert.equal(ALPHABET.includes('I') || ALPHABET.includes('O'), false);
  const rng = seeded(4);
  for (let b = 0; b < BROKERS.length; b++) {
    for (let k = 0; k < 50; k++) {
      const code = makeRoomCode(b, rng);
      assert.equal(normalizeCode(code), code);
      assert.equal(brokerIndexFor(code), b);
    }
  }
  assert.equal(normalizeCode(' kq-xz '), 'KQXZ');
  assert.equal(normalizeCode('KOXZ'), null);
  assert.equal(normalizeCode('KQX'), null);
  const t = topics('KQXZ');
  assert.equal(t.presenceId(t.presence('abc')), 'abc');
  assert.equal(t.presenceId(t.state), null);
});
