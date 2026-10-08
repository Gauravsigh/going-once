// A player's connection to a room hosted on someone else's device.

import { topics, BROKERS, brokerIndexFor, randomId } from './protocol.js';
import { openLink } from './net.js';

const HOST_STATUS_WAIT_MS = 4500;
const JOIN_WAIT_MS = 9000;
const JOIN_RETRY_MS = 3000;

export class JoinError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class ClientSession {
  constructor({ link, room, pid, name, conn = link.conn }) {
    this.link = link;
    this.conn = conn ?? '';
    this.room = room;
    this.pid = pid;
    this.name = name;
    this.t = topics(room);
    this.view = null;
    this.hostStatus = null;
    this.clockOffset = 0; // host clock minus local clock, learned from live messages
    this.listeners = { state: new Set(), host: new Set(), error: new Set(), kicked: new Set(), link: new Set() };
    this.closed = false;
  }

  on(event, fn) {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  emit(event, value) {
    for (const fn of this.listeners[event]) fn(value);
  }

  async start() {
    this.link.onMessage((topic, text, packet) => this.receive(topic, text, packet));
    this.link.onStatus((status) => {
      this.emit('link', status);
      if (status === 'online' && !this.closed) this.announce();
    });
    const hostSeen = new Promise((resolve) => {
      const off = this.on('host', () => {
        off();
        resolve();
      });
    });
    await this.link.subscribe([this.t.state, this.t.host, this.t.reply(this.pid)]);
    await Promise.race([hostSeen, delay(HOST_STATUS_WAIT_MS)]);
    if (this.hostStatus !== 'online') {
      const code = this.hostStatus === 'closed' ? 'host-closed' : this.hostStatus === 'offline' ? 'host-offline' : 'not-found';
      throw new JoinError(code);
    }
    await this.join();
  }

  join() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(retry);
        clearTimeout(giveUp);
        offState();
        offError();
      };
      const offState = this.on('state', (view) => {
        if (view.players.some((p) => p.id === this.pid)) {
          cleanup();
          resolve();
        }
      });
      const offError = this.on('error', (err) => {
        if (err.action !== 'join') return;
        cleanup();
        reject(new JoinError(err.code));
      });
      const retry = setTimeout(() => this.announce(), JOIN_RETRY_MS);
      const giveUp = setTimeout(() => {
        cleanup();
        reject(new JoinError('join-timeout'));
      }, JOIN_WAIT_MS);
      this.announce();
    });
  }

  announce() {
    this.link.publish(this.t.presence(this.pid), `1:${this.conn}`);
    return this.send({ type: 'join', name: this.name });
  }

  receive(topic, text, packet) {
    if (topic === this.t.host) {
      this.hostStatus = text || null;
      this.emit('host', this.hostStatus);
      if (text === 'online' && this.view && !this.closed) this.announce();
      return;
    }
    if (topic === this.t.reply(this.pid)) {
      const msg = parse(text);
      if (msg?.type === 'error') this.emit('error', msg);
      if (msg?.type === 'kicked') this.emit('kicked', msg);
      return;
    }
    if (topic === this.t.state) {
      const view = parse(text);
      if (!view || typeof view.seq !== 'number' || !Array.isArray(view.players)) return;
      if (this.view && view.epoch === this.view.epoch && view.hs === this.view.hs && view.seq <= this.view.seq) return;
      if (!packet?.retain && typeof view.sentAt === 'number') this.clockOffset = view.sentAt - Date.now();
      this.view = view;
      this.emit('state', view);
    }
  }

  send(intent) {
    return this.link.publish(this.t.intents, { ...intent, pid: this.pid, conn: this.conn });
  }

  // Host time to local time, for countdowns.
  toLocal(hostTime) {
    return hostTime - this.clockOffset;
  }

  async leave() {
    this.closed = true;
    await this.send({ type: 'leave' });
    await this.link.publish(this.t.presence(this.pid), `0:${this.conn}`);
    await this.link.close();
  }
}

export async function connectAsPlayer(connect, room, pid, { brokers = BROKERS, timeoutMs = 8000 } = {}) {
  const t = topics(room);
  const conn = randomId(8);
  try {
    const link = await openLink(connect, brokers[brokerIndexFor(room, brokers.length)], {
      clientId: `go_p_${randomId(10)}`,
      will: { topic: t.presence(pid), payload: `0:${conn}`, qos: 1, retain: false },
      timeoutMs,
    });
    link.conn = conn;
    return link;
  } catch {
    throw new JoinError('no-broker');
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
