// The host's browser is the referee: it owns the full game state, applies every
// action through the rules engine and publishes the public view to the room.

import { apply, publicView } from './game.js';
import { topics, BROKERS, brokerIndexFor, makeRoomCode, randomId, secureRandom } from './protocol.js';
import { openLink } from './net.js';

// Only these may arrive over the network. Host-only actions (start, kick,
// settings, rematch) come from the host's own UI, never from a message.
const REMOTE_ACTIONS = new Set(['join', 'leave', 'bid']);

export class HostSession {
  constructor({ link, state, seq = 0, now = () => Date.now(), rng = secureRandom, persist = () => {} }) {
    this.link = link;
    this.state = state;
    this.seq = seq;
    this.now = now;
    this.rng = rng;
    this.persist = persist;
    this.t = topics(state.room);
    this.timer = null;
    this.listeners = new Set();
    this.closed = false;
    this.connections = new Map(); // pid -> id of that player's newest connection
    this.hs = randomId(8); // changes on every host start so players accept a restarted sequence
  }

  get pid() {
    return this.state.hostId;
  }

  get view() {
    return { ...publicView(this.state, this.now()), seq: this.seq, hs: this.hs };
  }

  onState(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start() {
    this.link.onMessage((topic, text) => this.receive(topic, text));
    this.link.onStatus((status) => {
      if (status === 'online' && !this.closed) this.announce();
    });
    await this.link.subscribe([this.t.intents, this.t.presenceAll]);
    await this.announce();
    this.schedule();
  }

  async announce() {
    await this.link.publish(this.t.host, 'online', { retain: true });
    await this.publish();
  }

  receive(topic, text) {
    if (this.closed) return;
    const pid = this.t.presenceId(topic);
    if (pid) {
      if (pid === this.pid) return;
      // Payload is "1:<connection>" or "0:<connection>". A goodbye from an older
      // connection (say, the tab before a reload) must not mark a player offline.
      const [flag, conn = ''] = text.split(':');
      if (flag === '1') {
        this.connections.set(pid, conn);
        this.run({ type: 'presence', pid, connected: true });
      } else if (flag === '0') {
        const current = this.connections.get(pid);
        if (current && conn && current !== conn) return;
        this.run({ type: 'presence', pid, connected: false });
      }
      return;
    }
    if (topic !== this.t.intents) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || !REMOTE_ACTIONS.has(msg.type) || typeof msg.pid !== 'string' || msg.pid === this.pid) return;
    if (msg.pid.length > 40) return;
    if (typeof msg.conn === 'string' && msg.conn) this.connections.set(msg.pid, msg.conn.slice(0, 40));
    const action = { type: msg.type, pid: msg.pid };
    if (msg.type === 'join') action.name = String(msg.name ?? '').slice(0, 64);
    if (msg.type === 'bid') action.card = msg.card;
    this.run(action);
  }

  // Actions from the host's own screen.
  act(action) {
    const full = { ...action, pid: this.pid, by: this.pid };
    if (action.type === 'kick') full.target = action.target;
    return this.run(full);
  }

  run(action) {
    const { state, error, changed } = apply(this.state, action, { now: this.now(), rng: this.rng });
    if (error) {
      if (REMOTE_ACTIONS.has(action.type) && action.pid !== this.pid && error !== 'unchanged') {
        this.link.publish(this.t.reply(action.pid), { type: 'error', code: error, action: action.type });
      }
      return error;
    }
    if (changed) {
      this.state = state;
      if (action.type === 'kick') {
        this.link.publish(this.t.reply(action.target), { type: 'kicked' });
      }
      this.publish();
      this.schedule();
    }
    return null;
  }

  publish() {
    this.seq += 1;
    const view = { ...publicView(this.state, this.now()), seq: this.seq, hs: this.hs };
    this.persist(this.state, this.seq);
    for (const fn of this.listeners) fn(view);
    return this.link.publish(this.t.state, view, { retain: true });
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    const s = this.state;
    let due = null;
    let type = null;
    if (s.phase === 'bidding' && s.deadline != null) [due, type] = [s.deadline, 'timeout'];
    if (s.phase === 'reveal') [due, type] = [s.revealUntil, 'advance'];
    if (!type) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const err = this.run({ type });
      if (err === 'not-due') this.schedule();
    }, Math.max(0, due - this.now()) + 30);
  }

  // Ends the room for everyone and clears its retained messages from the broker.
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.link.publish(this.t.host, 'closed', { retain: true });
    await this.link.publish(this.t.state, '', { retain: true });
    await this.link.close();
  }
}

// Connects to the first reachable broker and claims a free room code on it.
export async function connectAsHost(connect, { brokers = BROKERS, rng = secureRandom, timeoutMs = 6000, onAttempt = () => {} } = {}) {
  for (let i = 0; i < brokers.length; i++) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const room = makeRoomCode(i, rng, brokers.length);
      const t = topics(room);
      onAttempt({ broker: brokers[i], room });
      let link;
      try {
        link = await openLink(connect, brokers[i], {
          clientId: `go_h_${randomId(10)}`,
          will: { topic: t.host, payload: 'offline', qos: 1, retain: true },
          timeoutMs,
        });
      } catch {
        break; // broker unreachable: try the next one
      }
      const existing = await peekRetained(link, t.host, 900);
      if (existing === 'online') {
        await link.close();
        continue; // code in use: draw another
      }
      return { link, room, brokerIndex: i };
    }
  }
  throw Object.assign(new Error('no broker reachable'), { code: 'no-broker' });
}

export async function reconnectAsHost(connect, room, { brokers = BROKERS, timeoutMs = 8000 } = {}) {
  const t = topics(room);
  return openLink(connect, brokers[brokerIndexFor(room, brokers.length)], {
    clientId: `go_h_${randomId(10)}`,
    will: { topic: t.host, payload: 'offline', qos: 1, retain: true },
    timeoutMs,
  });
}

// Subscribes briefly to read a retained message, if there is one.
export async function peekRetained(link, topic, waitMs) {
  let value = null;
  let off;
  const got = new Promise((resolve) => {
    off = link.onMessage((t, text) => {
      if (t === topic) {
        value = text;
        resolve();
      }
    });
  });
  await link.subscribe([topic]);
  await Promise.race([got, new Promise((r) => setTimeout(r, waitMs))]);
  off();
  await new Promise((resolve) => link.client.unsubscribe(topic, () => resolve()));
  return value;
}
