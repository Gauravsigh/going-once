// Room codes, broker routing and topic names shared by host and players.

// Public MQTT brokers that accept browser WebSocket connections without an account.
// The host uses the first one it can reach; the room code's first letter records
// which one, so a joiner needs nothing but the code.
export const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

// 24 letters: no I or O, so codes survive being read aloud or typed on a phone.
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
export const NAMESPACE = 'goingonce/v1';

export function normalizeCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

export function brokerIndexFor(code, brokerCount = BROKERS.length) {
  return ALPHABET.indexOf(code[0]) % brokerCount;
}

export function makeRoomCode(brokerIndex, rng = Math.random, brokerCount = BROKERS.length) {
  const firsts = [...ALPHABET].filter((_, i) => i % brokerCount === brokerIndex);
  let code = firsts[Math.floor(rng() * firsts.length)];
  while (code.length < CODE_LENGTH) code += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return code;
}

export function topics(room) {
  const base = `${NAMESPACE}/${room}`;
  return {
    state: `${base}/state`,
    intents: `${base}/in`,
    host: `${base}/host`,
    presenceAll: `${base}/p/+`,
    presence: (pid) => `${base}/p/${pid}`,
    reply: (pid) => `${base}/r/${pid}`,
    presenceId: (topic) => (topic.startsWith(`${base}/p/`) ? topic.slice(base.length + 3) : null),
  };
}

export function randomId(length = 16) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

export function secureRandom() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

export const ERROR_TEXT = {
  'not-found': 'No room with that code. Check the letters with your host.',
  'host-offline': 'That room’s host is offline right now.',
  'host-closed': 'The host closed that room.',
  'in-progress': 'That game has already started. Ask the host to start a new one.',
  full: 'That room is full (8 players max).',
  'bad-name': 'Pick a name with at least one letter.',
  'bad-code': 'Room codes are 4 letters.',
  'no-broker': 'Couldn’t reach any game server. Check your connection and try again.',
  'join-timeout': 'The host didn’t answer. Try again in a moment.',
};
