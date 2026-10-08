// Thin wrapper over an MQTT client. The connect function is injected so the
// browser can pass the vendored bundle and Node tests can pass the npm package.

const decoder = new TextDecoder();

export class Link {
  constructor(client, url) {
    this.client = client;
    this.url = url;
    this.messageHandlers = new Set();
    this.statusHandlers = new Set();
    this.online = true;
    client.on('message', (topic, payload, packet) => {
      const text = decoder.decode(payload);
      for (const fn of this.messageHandlers) fn(topic, text, packet);
    });
    const setStatus = (online) => {
      if (this.online === online) return;
      this.online = online;
      for (const fn of this.statusHandlers) fn(online ? 'online' : 'offline');
    };
    client.on('connect', () => setStatus(true));
    client.on('offline', () => setStatus(false));
    client.on('close', () => setStatus(false));
  }

  onMessage(fn) {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  // Fires 'online' after every reconnect, so callers can re-announce themselves.
  onStatus(fn) {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
  }

  subscribe(topicList) {
    return new Promise((resolve, reject) => {
      this.client.subscribe(topicList, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  publish(topic, payload, { retain = false, qos = 1 } = {}) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Promise((resolve) => {
      // Offline publishes are queued by the client and flushed on reconnect.
      this.client.publish(topic, body, { qos, retain }, () => resolve());
    });
  }

  close() {
    return new Promise((resolve) => this.client.end(false, {}, () => resolve()));
  }

  // Drops the socket without a DISCONNECT packet, which makes the broker send the will.
  abort() {
    this.client.end(true);
  }
}

export function openLink(connect, url, { clientId, will, timeoutMs = 7000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = connect(url, {
      clientId,
      clean: true,
      keepalive: 20,
      reconnectPeriod: 2000,
      connectTimeout: timeoutMs,
      protocolVersion: 4,
      resubscribe: true,
      will,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end(true);
      reject(new Error(`timeout connecting to ${url}`));
    }, timeoutMs);
    client.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(new Link(client, url));
    });
    client.on('error', () => {
      // Reconnects are automatic; the timeout above decides the first attempt.
    });
  });
}
