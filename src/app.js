// Going Once UI: screens, session lifecycle and small touches (sound, haptics).

import mqtt from '../vendor/mqtt.esm.js';
import { HostSession, connectAsHost, reconnectAsHost } from './host.js';
import { ClientSession, connectAsPlayer, JoinError } from './client.js';
import { createRoom, standings, HAND_SIZES, TIMER_OPTIONS, MIN_PLAYERS, MAX_PLAYERS, NAME_MAX, REVEAL_MS, cleanName } from './game.js';
import { BROKERS, normalizeCode, randomId, ERROR_TEXT } from './protocol.js';

const connect = mqtt.connect;
const $ = (sel) => document.querySelector(sel);
const $app = $('#app');

// sessionStorage is per tab, so two tabs in one browser act as two players.
const store = {
  get(area, key) {
    try {
      return JSON.parse(globalThis[area].getItem(key));
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      globalThis[area].setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: the game still works, it just can't resume */
    }
  },
  del(area, key) {
    try {
      globalThis[area].removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const ui = {
  screen: 'home', // home | connecting | room
  busy: '',
  error: '',
  name: store.get('localStorage', 'go:name') || '',
  code: '',
  myBid: null,
  animatedReveal: null,
  sound: store.get('localStorage', 'go:sound') !== false,
  linkOnline: true,
  hostStatus: 'online',
  attempt: 0,
};
let session = null; // { role, pid, room, host?, client? }
let view = null;

const HAND_LABELS = { 7: 'Quick', 10: 'Classic', 13: 'Long' };
const sum = (values) => values.reduce((a, b) => a + b, 0);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- sound and haptics ---------- */

let audio = null;
function tone(freq, duration, { type = 'sine', gain = 0.06, at = 0 } = {}) {
  if (!ui.sound) return;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime + at;
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(audio.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  } catch {
    /* audio blocked or unsupported */
  }
}
const sounds = {
  tap: () => tone(740, 0.06, { type: 'triangle', gain: 0.05 }),
  knock: () => {
    tone(150, 0.09, { type: 'square', gain: 0.07 });
    tone(150, 0.09, { type: 'square', gain: 0.07, at: 0.16 });
  },
  sold: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', gain: 0.05, at: i * 0.11 })),
};
const buzz = (ms) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
};

/* ---------- helpers ---------- */

const me = () => view?.players.find((p) => p.id === session?.pid) ?? null;
const isHost = () => session?.role === 'host';
const hostPlayer = () => view?.players.find((p) => p.id === view.hostId);
const toLocal = (t) => (session?.client ? session.client.toLocal(t) : t);
const inviteUrl = (room) => `${location.origin}${location.pathname}?room=${room}`;

function playerName(id) {
  return view?.players.find((p) => p.id === id)?.name ?? 'Someone';
}

function toast(text, ms = 3200) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

function setUrlRoom(room) {
  const url = new URL(location.href);
  if (room) url.searchParams.set('room', room);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

/* ---------- keyed rendering: only changed parts touch the DOM ---------- */

function patch(parts) {
  const keep = new Set(parts.map(([key]) => key));
  for (const el of [...$app.children]) if (!keep.has(el.dataset.part)) el.remove();
  let prev = null;
  for (const [key, html, cls = ''] of parts) {
    let el = $app.querySelector(`:scope > [data-part="${key}"]`);
    if (!el) {
      el = document.createElement('section');
      el.dataset.part = key;
    }
    if (el._html !== html) {
      el.innerHTML = html;
      el._html = html;
    }
    el.className = `part part-${key} ${cls}`.trim();
    const target = prev ? prev.nextElementSibling : $app.firstElementChild;
    if (target !== el) $app.insertBefore(el, target);
    prev = el;
  }
  tickTimers();
}

function render() {
  renderChrome();
  if (ui.screen === 'home') return patch(homeParts());
  if (ui.screen === 'connecting') return patch(connectingParts());
  if (!view) return patch(connectingParts());
  const screens = { lobby: lobbyParts, bidding: biddingParts, reveal: revealParts, over: overParts };
  patch(screens[view.phase]());
}

function renderChrome() {
  const inRoom = ui.screen === 'room' && session;
  const chip = $('#room-chip');
  chip.hidden = !inRoom;
  if (inRoom) chip.textContent = `Room ${session.room}`;
  $('#leave-btn').hidden = !inRoom;
  const soundBtn = $('#sound-btn');
  soundBtn.setAttribute('aria-pressed', String(ui.sound));
  soundBtn.setAttribute('aria-label', ui.sound ? 'Sound on' : 'Sound off');
  soundBtn.classList.toggle('muted', !ui.sound);

  const banner = $('#banner');
  let text = '';
  if (inRoom && !ui.linkOnline) text = 'Connection lost. Reconnecting…';
  else if (inRoom && !isHost() && ui.hostStatus === 'offline') text = `${hostPlayer()?.name ?? 'The host'} lost connection. Waiting for them to come back…`;
  banner.hidden = !text;
  banner.textContent = text;
}

const rulesHTML = () => $('#rules-template').innerHTML;

/* ---------- screens ---------- */

function homeParts() {
  return [
    ['hero', `
      <p class="eyebrow">A sealed-bid card game · 2–${MAX_PLAYERS} players · own devices</p>
      <h1 class="title">Going <em>Once</em></h1>
      <p class="lede">Everyone holds the same cards. Each round one lot goes up for auction, and you bid by secretly playing a card. Highest card takes the lot, but every card you play is gone for good.</p>`],
    ['entry', `
      <form class="panel entry" id="entry-form" novalidate>
        <label class="field">
          <span>Your name</span>
          <input id="name-input" name="name" maxlength="${NAME_MAX}" autocomplete="nickname" placeholder="e.g. Priya" value="${esc(ui.name)}" required>
        </label>
        <button type="button" class="btn primary big" data-action="create">Host a new room</button>
        <div class="divider"><span>or join a friend’s room</span></div>
        <div class="join-row">
          <label class="sr-only" for="code-input">Room code</label>
          <input id="code-input" name="code" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" value="${esc(ui.code)}">
          <button type="submit" class="btn" data-action="join">Join</button>
        </div>
        <p class="form-error" role="alert">${esc(ui.error)}</p>
      </form>`],
    ['how', `
      <div class="panel rules-panel">
        <h2>How to play</h2>
        ${rulesHTML()}
      </div>`],
  ];
}

function connectingParts() {
  return [['connecting', `
    <div class="connecting">
      <div class="spinner" aria-hidden="true"></div>
      <p>${esc(ui.busy || 'Connecting…')}</p>
      <button type="button" class="btn ghost small" data-action="cancel">Cancel</button>
    </div>`]];
}

function playerRow(p, { showHand = false, showStatus = false } = {}) {
  const you = p.id === session.pid;
  const host = p.id === view.hostId;
  const canKick = isHost() && !host && (view.phase === 'lobby' || !p.connected);
  let status = '';
  if (showStatus) status = p.submitted ? '<span class="status done">card down</span>' : '<span class="status thinking">thinking…</span>';
  const hand = showHand
    ? `<div class="mini-hand" aria-label="${esc(p.name)} has ${p.hand.length} cards left">${p.hand.map((c) => `<span>${c}</span>`).join('')}</div>`
    : '';
  return `
    <li class="player ${you ? 'you' : ''} ${p.connected ? '' : 'away'}" data-player="${esc(p.id)}">
      <span class="avatar" style="--c:${esc(p.color)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
      <div class="who">
        <span class="name">${esc(p.name)}</span>
        <span class="tags">${host ? '<span class="tag">host</span>' : ''}${you ? '<span class="tag you">you</span>' : ''}${p.connected ? '' : '<span class="tag away">offline</span>'}${status}</span>
        ${hand}
      </div>
      ${view.phase === 'lobby' ? '' : `<span class="score" aria-label="${p.score} points">${p.score}</span>`}
      ${canKick ? `<button type="button" class="kick" data-action="kick" data-target="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>` : ''}
    </li>`;
}

function lobbyParts() {
  const host = isHost();
  const count = view.players.length;
  const settings = view.settings;
  const seg = (name, options, current, label) => `
    <div class="setting">
      <span class="setting-label">${label}</span>
      <div class="segmented" role="group" aria-label="${label}">
        ${options.map((o) => `<button type="button" data-action="setting" data-name="${name}" data-value="${o.value}" aria-pressed="${o.value === current}" ${host ? '' : 'disabled'}>${o.text}</button>`).join('')}
      </div>
    </div>`;
  const startHint = count < MIN_PLAYERS ? `Waiting for at least ${MIN_PLAYERS} players. Share the code.` : `${count} players ready.`;
  return [
    ['lobby-code', `
      <div class="panel code-panel">
        <p class="eyebrow">Room code</p>
        <p class="room-code" data-testid="room-code">${esc(view.room)}</p>
        <p class="muted">Friends open the game on their own phone or laptop and enter this code, or use the invite link.</p>
        <div class="code-actions">
          <button type="button" class="btn" data-action="copy-link">Copy invite link</button>
          ${navigator.share ? '<button type="button" class="btn ghost" data-action="share">Share…</button>' : ''}
        </div>
      </div>`],
    ['lobby-players', `
      <div class="panel">
        <h2>Players <span class="count">${count}/${MAX_PLAYERS}</span></h2>
        <ul class="players">${view.players.map((p) => playerRow(p)).join('')}</ul>
      </div>`],
    ['lobby-settings', `
      <div class="panel">
        <h2>Game settings</h2>
        ${seg('handSize', HAND_SIZES.map((n) => ({ value: n, text: `${n} · ${HAND_LABELS[n]}` })), settings.handSize, 'Cards per hand')}
        ${seg('timer', TIMER_OPTIONS.map((t) => ({ value: t, text: t ? `${t}s` : 'Off' })), settings.timer, 'Turn timer')}
        ${host ? '' : `<p class="muted">Only ${esc(hostPlayer()?.name ?? 'the host')} can change these.</p>`}
      </div>`],
    ['lobby-start', host
      ? `<div class="start-row"><button type="button" class="btn primary big" data-action="start" ${count < MIN_PLAYERS ? 'disabled' : ''}>Start the auction</button><p class="muted">${startHint}</p></div>`
      : `<div class="start-row"><p class="waiting"><span class="dot-pulse" aria-hidden="true"></span> Waiting for ${esc(hostPlayer()?.name ?? 'the host')} to start…</p></div>`],
    ['lobby-rules', `<div class="panel rules-panel"><h2>How to play</h2>${rulesHTML()}</div>`],
  ];
}

function statusBar(label, deadline, total, kind) {
  if (!deadline) return `<div class="statusbar"><span>${label}</span></div>`;
  const local = toLocal(deadline);
  const left = Math.max(0, local - Date.now());
  return `
    <div class="statusbar ${kind}">
      <span>${label}</span>
      <span class="clock" data-deadline="${local}" data-format="${kind}">${Math.ceil(left / 1000)}s</span>
      <div class="bar"><div class="fill" data-deadline-bar="${local}" data-total="${total}" style="width:${Math.min(100, (left / total) * 100)}%"></div></div>
    </div>`;
}

function lotCard(value, extraClass = '') {
  return `<div class="lot ${extraClass}" aria-label="Lot worth ${value}"><span class="lot-label">LOT</span><span class="lot-value">${value}</span><span class="lot-corner">${value}</span></div>`;
}

function auctionPart() {
  const potValue = sum(view.pot);
  const worth = potValue + view.prize;
  return `
    <div class="auction">
      <div class="lot-stack">
        ${view.pot.map((v, i) => `<div class="lot ghost-lot" style="--i:${i}" aria-hidden="true"><span class="lot-value">${v}</span></div>`).join('')}
        ${lotCard(view.prize, 'current')}
      </div>
      <div class="auction-info">
        <p class="eyebrow">Up for auction</p>
        <p class="worth"><span data-testid="worth">${worth}</span> point${worth === 1 ? '' : 's'}</p>
        ${view.pot.length ? `<p class="rollover">Includes rolled-over ${view.pot.map((v) => `<b>${v}</b>`).join(' + ')}</p>` : ''}
        <p class="lots-left">${view.lotsLeft.length ? `Still to come: ${view.lotsLeft.map((v) => `<span>${v}</span>`).join('')}` : 'This is the last lot.'}</p>
      </div>
    </div>`;
}

function tablePart(showStatus) {
  const ordered = view.players.slice().sort((a, b) => b.score - a.score || view.players.indexOf(a) - view.players.indexOf(b));
  return `
    <div class="panel table">
      <h2>The table</h2>
      <ul class="players">${ordered.map((p) => playerRow(p, { showHand: true, showStatus })).join('')}</ul>
    </div>`;
}

function handPart(active) {
  const mine = me();
  if (!mine) return '';
  const chosen = active ? ui.myBid?.card ?? null : null;
  let hint;
  if (!active) hint = 'Your hand';
  else if (chosen != null) hint = `You bid <b>${chosen}</b>. Tap another card to switch until everyone is in.`;
  else if (mine.submitted) hint = 'Your card is down. Tap another to switch.';
  else hint = 'Tap a card to bid it.';
  return `
    <div class="hand-wrap ${active ? 'active' : ''}">
      <p class="hand-hint" data-testid="hand-hint">${hint}</p>
      <div class="hand" role="group" aria-label="Your hand">
        ${mine.hand.map((c) => `<button type="button" class="card ${c === chosen ? 'chosen' : ''}" data-action="bid" data-card="${c}" ${active ? '' : 'disabled'} aria-pressed="${c === chosen}" aria-label="Bid ${c}">${c}</button>`).join('')}
      </div>
    </div>`;
}

function biddingParts() {
  const total = view.settings.timer * 1000;
  const waitingOn = view.players.filter((p) => !p.submitted).length;
  return [
    ['status', statusBar(`Round ${view.round} of ${view.totalRounds} · ${waitingOn ? `waiting on ${waitingOn}` : 'flipping…'}`, view.deadline, total, 'timer')],
    ['auction', auctionPart()],
    ['hand', handPart(true), 'sticky-hand'],
    ['table', tablePart(true)],
  ];
}

function revealParts() {
  const r = view.reveal;
  const key = `${view.epoch}:${view.hs}:${r.round}:${view.history.length}`;
  const animate = ui.animatedReveal !== key;
  ui.animatedReveal = key;
  let headline;
  if (r.result === 'won') headline = `<b>${esc(playerName(r.winnerId))}</b> takes ${r.value} point${r.value === 1 ? '' : 's'} with a ${r.highest}!`;
  else if (r.result === 'rolled') headline = `Tie at ${r.highest}. Nobody wins, so the lot rolls over.`;
  else headline = `Tie at ${r.highest} on the final lot. Nobody gets it.`;
  const order = view.players.slice().sort((a, b) => (r.bids[b.id] ?? 0) - (r.bids[a.id] ?? 0));
  const isLast = view.lotsLeft.length === 0;
  return [
    ['status', statusBar(`Round ${r.round} of ${view.totalRounds} · ${isLast ? 'final results in' : 'next lot in'}`, view.revealUntil, REVEAL_MS, 'next')],
    ['reveal', `
      <div class="reveal ${animate ? 'animate' : ''} result-${r.result}">
        <div class="reveal-lot">${lotCard(r.value, r.result === 'won' ? 'sold' : r.result === 'rolled' ? 'rolled' : 'burned')}</div>
        <p class="headline" data-testid="headline">${headline}</p>
        <ul class="bids">
          ${order.map((p, i) => {
            const card = r.bids[p.id];
            const top = card === r.highest;
            const cls = top ? (r.result === 'won' ? 'top' : 'tied') : '';
            return `<li class="bid ${cls}" style="--i:${i}">
              <div class="flip"><div class="face back"></div><div class="face front">${card ?? '–'}</div></div>
              <span class="bid-name" style="--c:${esc(p.color)}">${p.id === session.pid ? 'You' : esc(p.name)}</span>
            </li>`;
          }).join('')}
        </ul>
      </div>`],
    ['table', tablePart(false)],
    ['hand', handPart(false)],
  ];
}

function overParts() {
  const ranks = standings(view.players);
  const winners = ranks.filter((p) => p.place === 1);
  const youWon = winners.some((p) => p.id === session.pid);
  const early = view.endReason === 'not-enough-players';
  const title = early
    ? 'Auction closed early'
    : winners.length > 1
      ? `Shared win: ${winners.map((p) => esc(p.name)).join(' &amp; ')}`
      : `${esc(winners[0]?.name ?? '')} wins!`;
  const burned = sum(view.burned);
  return [
    ['final', `
      <div class="panel final ${youWon && !early ? 'you-won' : ''}">
        <p class="eyebrow">${early ? 'Not enough players left to continue' : 'Sold! Final standings'}</p>
        <h1 class="final-title" data-testid="winner">${title}</h1>
        ${youWon && !early ? '<p class="cheer">That’s you. Well bid.</p>' : ''}
        <ol class="standings">
          ${ranks.map((p) => `
            <li class="${p.place === 1 ? 'first' : ''} ${p.id === session.pid ? 'you' : ''}">
              <span class="place">${p.place}</span>
              <span class="avatar" style="--c:${esc(p.color)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
              <span class="name">${esc(p.name)}</span>
              <span class="lots">${p.lots.slice().sort((a, b) => b - a).map((v) => `<i>${v}</i>`).join('')}</span>
              <span class="score">${p.score}</span>
            </li>`).join('')}
        </ol>
        ${burned ? `<p class="muted">${burned} point${burned === 1 ? '' : 's'} went unclaimed on tied lots.</p>` : ''}
      </div>`],
    ['over-actions', `
      <div class="start-row">
        ${isHost() ? '<button type="button" class="btn primary big" data-action="rematch">Play again</button>' : `<p class="waiting">Waiting for ${esc(hostPlayer()?.name ?? 'the host')} to start a rematch…</p>`}
        <button type="button" class="btn ghost" data-action="leave">Leave room</button>
      </div>`],
    ['history', historyPart()],
  ];
}

function historyPart() {
  if (!view.history.length) return '';
  return `
    <details class="panel history">
      <summary>Round by round</summary>
      <table>
        <thead><tr><th>Round</th><th>Lot</th><th>Stake</th><th>Top card</th><th>Result</th></tr></thead>
        <tbody>
          ${view.history.map((h) => `<tr><td>${h.round}</td><td>${h.prize}</td><td>${h.value}</td><td>${h.highest}</td><td>${h.result === 'won' ? esc(playerName(h.winnerId)) : h.result === 'rolled' ? 'Tie, rolled over' : 'Tie, unclaimed'}</td></tr>`).join('')}
        </tbody>
      </table>
    </details>`;
}

/* ---------- countdowns ---------- */

function tickTimers() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-deadline]')) {
    const left = Math.max(0, Number(el.dataset.deadline) - now);
    el.textContent = `${Math.ceil(left / 1000)}s`;
    el.classList.toggle('urgent', el.dataset.format === 'timer' && left < 5000);
  }
  for (const el of document.querySelectorAll('[data-deadline-bar]')) {
    const left = Math.max(0, Number(el.dataset.deadlineBar) - now);
    el.style.width = `${Math.min(100, (left / Number(el.dataset.total)) * 100)}%`;
  }
}
setInterval(tickTimers, 200);

/* ---------- session lifecycle ---------- */

function onView(next) {
  const prev = view;
  view = next;
  if (session?.role === 'player' && !next.players.some((p) => p.id === session.pid)) {
    endSession(next.phase === 'lobby' ? 'You left the room.' : 'You are no longer in this game.');
    return;
  }
  if (next.phase !== 'bidding' || (prev && (prev.round !== next.round || prev.phase !== 'bidding'))) ui.myBid = null;
  if (prev && prev.phase !== next.phase) {
    if (next.phase === 'reveal') {
      sounds.knock();
      buzz(30);
    }
    if (next.phase === 'over') sounds.sold();
    if (next.phase === 'bidding' && prev.phase === 'lobby') toast('The auction has started. Good luck!');
  }
  ui.screen = 'room';
  render();
}

function saveSession() {
  store.set('sessionStorage', 'go:session', { role: session.role, room: session.room, pid: session.pid, name: ui.name });
}

function teardown() {
  session?.client?.link.abort?.();
  session = null;
  view = null;
  ui.myBid = null;
  ui.hostStatus = 'online';
  ui.linkOnline = true;
  store.del('sessionStorage', 'go:session');
}

function endSession(message) {
  const room = session?.room;
  if (room) store.del('sessionStorage', `go:host:${room}`);
  teardown();
  setUrlRoom(null);
  ui.screen = 'home';
  ui.code = '';
  render();
  if (message) toast(message, 4000);
}

function wireLink(link) {
  link.onStatus((status) => {
    ui.linkOnline = status === 'online';
    renderChrome();
  });
}

async function startHosting(resumeRoom = null) {
  const attempt = ++ui.attempt;
  ui.screen = 'connecting';
  ui.busy = resumeRoom ? `Reopening room ${resumeRoom}…` : 'Opening a room…';
  ui.error = '';
  render();
  try {
    let link;
    let state;
    let seq = 0;
    if (resumeRoom) {
      const saved = store.get('sessionStorage', `go:host:${resumeRoom}`);
      if (!saved?.state) throw Object.assign(new Error('nothing to resume'), { code: 'not-found' });
      link = await reconnectAsHost(connect, resumeRoom);
      state = saved.state;
      seq = saved.seq ?? 0;
      // Players re-announce themselves when they see the host come back.
      for (const p of state.players) if (p.id !== state.hostId) p.connected = false;
    } else {
      const opened = await connectAsHost(connect, {
        onAttempt: ({ broker }) => {
          if (attempt === ui.attempt && broker !== BROKERS[0]) {
            ui.busy = 'First server busy, trying another…';
            render();
          }
        },
      });
      link = opened.link;
      state = createRoom({ room: opened.room, hostId: randomId(), hostName: ui.name, now: Date.now() });
    }
    if (attempt !== ui.attempt) return link.abort();
    const host = new HostSession({
      link,
      state,
      seq,
      persist: (s, n) => store.set('sessionStorage', `go:host:${s.room}`, { state: s, seq: n }),
    });
    session = { role: 'host', pid: state.hostId, room: state.room, host };
    saveSession();
    setUrlRoom(state.room);
    wireLink(link);
    host.onState(onView);
    await host.start();
    onView(host.view);
  } catch (err) {
    if (attempt !== ui.attempt) return;
    teardown();
    ui.screen = 'home';
    ui.error = ERROR_TEXT[err.code] ?? ERROR_TEXT['no-broker'];
    render();
  }
}

async function startJoining(room, pid = randomId()) {
  const attempt = ++ui.attempt;
  ui.screen = 'connecting';
  ui.busy = `Looking for room ${room}…`;
  ui.error = '';
  render();
  let link;
  try {
    link = await connectAsPlayer(connect, room, pid);
    if (attempt !== ui.attempt) return link.abort();
    const client = new ClientSession({ link, room, pid, name: ui.name });
    session = { role: 'player', pid, room, client };
    let joined = false;
    client.on('state', (v) => {
      if (joined && session?.client === client) onView(v);
    });
    client.on('host', (status) => {
      if (session?.client !== client) return;
      if (status === 'closed') return endSession(`${hostPlayer()?.name ?? 'The host'} closed the room.`);
      ui.hostStatus = status;
      if (view) renderChrome();
    });
    client.on('kicked', () => session?.client === client && endSession('The host removed you from the room.'));
    client.on('error', (e) => {
      if (e.action === 'bid' && session?.client === client) toast('That bid didn’t count. Try again.');
    });
    wireLink(link);
    await client.start();
    if (attempt !== ui.attempt) return link.abort();
    joined = true;
    saveSession();
    setUrlRoom(room);
    onView(client.view);
  } catch (err) {
    if (attempt !== ui.attempt) return;
    link?.abort();
    teardown();
    ui.screen = 'home';
    ui.code = room;
    ui.error = (err instanceof JoinError && ERROR_TEXT[err.code]) || ERROR_TEXT['join-timeout'];
    render();
  }
}

async function leaveRoom() {
  const current = session;
  if (!current) return;
  if (current.role === 'host') await current.host.close().catch(() => {});
  else await current.client.leave().catch(() => {});
  store.del('sessionStorage', `go:host:${current.room}`);
  endSession(current.role === 'host' ? 'Room closed.' : 'You left the room.');
}

/* ---------- input ---------- */

function readEntry() {
  const name = cleanName($('#name-input')?.value);
  ui.name = name;
  ui.code = ($('#code-input')?.value ?? '').toUpperCase();
  if (name) store.set('localStorage', 'go:name', name);
  return name;
}

function requireName() {
  const name = readEntry();
  if (!name) {
    ui.error = ERROR_TEXT['bad-name'];
    render();
    $('#name-input')?.focus();
    return false;
  }
  return true;
}

function confirmLeave() {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = isHost() ? 'Close this room?' : 'Leave this game?';
  $('#confirm-text').textContent = isHost()
    ? 'You are the host. Leaving ends the game for everyone in the room.'
    : view?.phase === 'lobby'
      ? 'You can rejoin with the same code while the host is still in the lobby.'
      : 'Your seat and points will be removed from this game.';
  dialog.showModal();
}

const actions = {
  create() {
    if (requireName()) startHosting();
  },
  join() {
    if (!requireName()) return;
    const room = normalizeCode(ui.code);
    if (!room) {
      ui.error = ERROR_TEXT['bad-code'];
      render();
      $('#code-input')?.focus();
      return;
    }
    startJoining(room);
  },
  cancel() {
    ui.attempt++;
    teardown();
    ui.screen = 'home';
    render();
  },
  rules() {
    $('#rules-dialog').showModal();
  },
  'close-dialog'(el) {
    el.closest('dialog')?.close();
  },
  'confirm-yes'(el) {
    el.closest('dialog')?.close();
    leaveRoom();
  },
  leave() {
    if (view?.phase === 'over' && !isHost()) return leaveRoom();
    confirmLeave();
  },
  sound() {
    ui.sound = !ui.sound;
    store.set('localStorage', 'go:sound', ui.sound);
    renderChrome();
    sounds.tap();
  },
  setting(el) {
    if (!isHost()) return;
    session.host.act({ type: 'settings', [el.dataset.name]: Number(el.dataset.value) });
  },
  start() {
    if (!isHost()) return;
    const err = session.host.act({ type: 'start' });
    if (err === 'need-players') toast(`You need at least ${MIN_PLAYERS} players.`);
  },
  rematch() {
    if (isHost()) session.host.act({ type: 'rematch' });
  },
  kick(el) {
    if (isHost()) session.host.act({ type: 'kick', target: el.dataset.target });
  },
  bid(el) {
    if (view?.phase !== 'bidding') return;
    const card = Number(el.dataset.card);
    if (ui.myBid?.card === card) return;
    ui.myBid = { card };
    sounds.tap();
    buzz(12);
    if (isHost()) session.host.act({ type: 'bid', card });
    else session.client.send({ type: 'bid', card });
    render();
  },
  async 'copy-link'() {
    const url = inviteUrl(session.room);
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied. Send it to your friends.');
    } catch {
      toast(url, 6000);
    }
  },
  async share() {
    try {
      await navigator.share({ title: 'Going Once', text: `Join my Going Once room: ${session.room}`, url: inviteUrl(session.room) });
    } catch {
      /* share sheet dismissed */
    }
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  event.preventDefault();
  fn(el);
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'entry-form') return;
  event.preventDefault();
  readEntry();
  if (ui.code) actions.join();
  else actions.create();
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'code-input') {
    const el = event.target;
    const pos = el.selectionStart;
    el.value = el.value.toUpperCase().replace(/[^A-Z]/g, '');
    el.setSelectionRange(pos, pos);
  }
  if (ui.error && (event.target.id === 'code-input' || event.target.id === 'name-input')) {
    ui.error = '';
    const err = $('.form-error');
    if (err) err.textContent = '';
  }
});

/* ---------- boot ---------- */

for (const el of document.querySelectorAll('[data-rules]')) el.innerHTML = rulesHTML();

// "Duplicate tab" copies sessionStorage. The copy must not take over the original tab's seat.
const tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('going-once-tabs') : null;
tabs?.addEventListener('message', (event) => {
  if (event.data?.type === 'who' && session?.pid && event.data.pid === session.pid) tabs.postMessage({ type: 'mine', pid: session.pid });
});

function seatTakenElsewhere(pid) {
  if (!tabs) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (taken) => {
      tabs.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(taken);
    };
    const onMessage = (event) => {
      if (event.data?.type === 'mine' && event.data.pid === pid) finish(true);
    };
    tabs.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish(false), 300);
    tabs.postMessage({ type: 'who', pid });
  });
}

async function boot() {
  const urlRoom = normalizeCode(new URL(location.href).searchParams.get('room'));
  let saved = store.get('sessionStorage', 'go:session');
  if (saved?.pid && (await seatTakenElsewhere(saved.pid))) {
    store.del('sessionStorage', 'go:session');
    if (saved.room) store.del('sessionStorage', `go:host:${saved.room}`);
    saved = null;
  }
  if (saved?.room && saved.pid && (!urlRoom || urlRoom === saved.room)) {
    ui.name = saved.name || ui.name;
    if (saved.role === 'host') return startHosting(saved.room);
    return startJoining(saved.room, saved.pid);
  }
  ui.code = urlRoom ?? '';
  render();
  if (urlRoom) $(ui.name ? '#code-input' : '#name-input')?.focus();
}

boot();
