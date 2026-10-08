// End-to-end over a real public broker: one headless host and two remote players
// play a complete game. With --fallback the first broker is unreachable and the
// room must land on the next one.
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { createRoom, standings, totalLotValue } from '../src/game.js';
import { BROKERS, brokerIndexFor, randomId } from '../src/protocol.js';
import { HostSession, connectAsHost, peekRetained } from '../src/host.js';
import { ClientSession, connectAsPlayer, JoinError } from '../src/client.js';
import { openLink } from '../src/net.js';

const fallback = process.argv.includes('--fallback');
const brokers = fallback ? ['wss://127.0.0.1:9/mqtt', ...BROKERS] : BROKERS;
const HAND = fallback ? 7 : 7;
const connect = mqtt.connect;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

function until(check, ms, what) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const leaks = [];
function watchForLeaks(label, view) {
  if (view.phase === 'bidding' && ('bids' in view || 'deck' in view)) leaks.push(label);
}

async function main() {
  const { link: hostLink, room, brokerIndex } = await connectAsHost(connect, {
    brokers,
    timeoutMs: fallback ? 3000 : 6000,
    onAttempt: ({ broker, room: r }) => log('host trying', broker, 'room', r),
  });
  log('host connected', hostLink.url, 'room', room);
  assert.equal(brokers[brokerIndexFor(room, brokers.length)], hostLink.url, 'room code routes to the host broker');
  if (fallback) assert.equal(brokerIndex, 1, 'skipped the unreachable broker');

  const hostId = randomId();
  const host = new HostSession({ link: hostLink, state: createRoom({ room, hostId, hostName: 'Hostbot', now: Date.now() }) });
  let hostView = null;
  host.onState((v) => {
    hostView = v;
    watchForLeaks('host', v);
  });
  await host.start();
  host.act({ type: 'settings', handSize: HAND, timer: 20 });

  // A code nobody is hosting is reported as not found.
  const ghostCode = room[0] + (room.slice(1) === 'ZZZ' ? 'YYY' : 'ZZZ');
  const ghostLink = await connectAsPlayer(connect, ghostCode, 'ghost', { brokers });
  const ghost = new ClientSession({ link: ghostLink, room: ghostCode, pid: 'ghost', name: 'Ghost' });
  await assert.rejects(ghost.start(), (e) => e instanceof JoinError && ['not-found', 'host-offline', 'host-closed'].includes(e.code));
  ghostLink.abort();
  log('unknown room rejected');

  const players = [];
  for (const name of ['Ava', 'Bo']) {
    const pid = randomId();
    const link = await connectAsPlayer(connect, room, pid, { brokers });
    const c = new ClientSession({ link, room, pid, name });
    c.on('state', (v) => watchForLeaks(name, v));
    await c.start();
    players.push(c);
    log(name, 'joined');
  }
  await until(() => hostView?.players.length === 3, 8000, 'three seated players');

  // A remote message pretending to be the host must not start the game.
  await players[0].send({ type: 'start', pid: hostId, by: hostId });
  await players[0].link.publish(host.t.intents, { type: 'start', pid: hostId, by: hostId });
  await wait(1500);
  assert.equal(hostView.phase, 'lobby', 'spoofed start ignored');

  assert.equal(host.act({ type: 'start' }), null);
  log('game started');

  // Bots: everyone plays a random card once per round, a little after it opens.
  const played = new Map();
  const botPlay = (id, view, send) => {
    if (view.phase !== 'bidding') return;
    const me = view.players.find((p) => p.id === id);
    if (!me || me.submitted || played.get(id) === view.round) return;
    played.set(id, view.round);
    const card = me.hand[Math.floor(Math.random() * me.hand.length)];
    setTimeout(() => send(card), 150 + Math.random() * 500);
  };
  host.onState((v) => botPlay(hostId, v, (card) => host.act({ type: 'bid', card })));
  for (const c of players) c.on('state', (v) => botPlay(c.pid, v, (card) => c.send({ type: 'bid', card })));
  botPlay(hostId, hostView, (card) => host.act({ type: 'bid', card }));
  for (const c of players) botPlay(c.pid, c.view, (card) => c.send({ type: 'bid', card }));

  await until(() => hostView.phase === 'over', (HAND * 9 + 20) * 1000, 'game over on host');
  await until(() => players.every((c) => c.view?.phase === 'over' && c.view.seq === hostView.seq), 8000, 'players to see the final state');

  const summary = (v) => standings(v.players).map((p) => `${p.place}:${p.id}:${p.score}`).join(',');
  const hostSummary = summary(hostView);
  for (const c of players) assert.equal(summary(c.view), hostSummary, 'identical standings everywhere');
  const scored = hostView.players.reduce((a, p) => a + p.score, 0);
  const burned = hostView.burned.reduce((a, b) => a + b, 0);
  assert.equal(scored + burned, totalLotValue(HAND), 'every lot point is accounted for');
  assert.equal(hostView.history.length, HAND);
  assert.equal(hostView.endReason, 'complete');
  assert.deepEqual(leaks, [], 'no bids or deck order visible during bidding');
  log('final standings', hostSummary, 'burned', burned);

  // Closing the room tells players and clears the retained state.
  const closedSeen = Promise.all(players.map((c) => new Promise((r) => c.on('host', (s) => s === 'closed' && r()))));
  await host.close();
  await Promise.race([closedSeen, wait(5000).then(() => { throw new Error('players never saw the room close'); })]);
  const probe = await openLink(connect, brokers[brokerIndex], { clientId: `go_probe_${randomId(6)}` });
  const leftover = await peekRetained(probe, host.t.state, 1500);
  assert.ok(!leftover, 'retained state cleared');
  await probe.close();
  for (const c of players) await c.link.close();

  console.log(fallback ? 'E2E FALLBACK PASS' : 'E2E BROKER PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('E2E FAILED:', err?.stack || err);
  process.exit(1);
});
