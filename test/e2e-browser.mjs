// Two isolated Chrome profiles (a laptop and a phone) play a full game through the UI.
// Uses the installed Google Chrome through playwright-core; nothing is downloaded.
//   node test/e2e-browser.mjs            local static server
//   node test/e2e-browser.mjs --live     the deployed site (BASE_URL to override)
//   SHOTS=1 node test/e2e-browser.mjs    also saves screenshots to test/artifacts/
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

const live = process.argv.includes('--live');
const shots = process.env.SHOTS === '1';
const shotDir = fileURLToPath(new URL('./artifacts/', import.meta.url));
const HAND = 7;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

let server = null;
let base;
if (live) {
  base = process.env.BASE_URL || 'https://gauravsigh.github.io/going-once/';
} else {
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}/`;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];
const layoutFailures = [];

async function newPlayer(label, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on('pageerror', (err) => problems.push(`${label} pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`${label} console: ${msg.text()}`);
  });
  page.setDefaultTimeout(20000);
  return page;
}

// Every visible element must sit inside the viewport horizontally.
async function checkLayout(page, label, screen) {
  const result = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.closest('dialog:not([open]), template, svg')) continue;
      if (el.closest('.toast')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 || r.left < -1) offenders.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 8) };
  });
  if (result.offenders.length || result.scrollWidth > result.vw + 1) {
    layoutFailures.push(`${label}/${screen}: vw=${result.vw} scrollWidth=${result.scrollWidth} ${result.offenders.join(', ')}`);
  }
}

async function checkTapTargets(page, label) {
  const small = await page.$$eval('.hand .card', (cards) =>
    cards.map((c) => c.getBoundingClientRect()).filter((r) => r.width < 40 || r.height < 40).map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`));
  if (small.length) layoutFailures.push(`${label}: hand cards smaller than 40px: ${small.join(', ')}`);
}

async function shot(page, name) {
  if (!shots) return;
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}${name}.png` });
}

const text = (page, sel) => page.locator(sel).first().innerText();

try {
  const laptop = await newPlayer('laptop', { viewport: { width: 1280, height: 860 } });
  const phone = await newPlayer('phone', {
    viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });

  // Host opens a room.
  await laptop.goto(base);
  await laptop.getByText('Highest card wins.').first().waitFor();
  await shot(laptop, 'home-laptop');
  await laptop.fill('#name-input', 'Priya');
  await laptop.click('[data-action="create"]');
  const code = (await text(laptop, '[data-testid="room-code"]')).trim();
  assert.match(code, /^[A-HJ-NP-Z]{4}$/);
  log('room', code);
  await laptop.click('button[data-name="handSize"][data-value="7"]');
  await laptop.locator('button[data-name="handSize"][data-value="7"][aria-pressed="true"]').waitFor();

  // Phone joins by typing the code, like a friend in another city would.
  await phone.goto(base);
  await checkLayout(phone, 'phone', 'home');
  await shot(phone, 'home-phone');
  await phone.fill('#name-input', 'Marco');
  await phone.fill('#code-input', code.toLowerCase());
  await phone.click('[data-action="join"]');
  assert.equal((await text(phone, '[data-testid="room-code"]')).trim(), code);
  await phone.getByText('Ties roll over.').first().waitFor();
  await phone.locator('button[data-name="handSize"][data-value="7"][aria-pressed="true"]').waitFor();
  assert.equal(await phone.locator('[data-action="start"]').count(), 0, 'only the host gets a start button');
  await laptop.locator('.part-lobby-players .player').nth(1).waitFor();
  assert.match(await text(laptop, '.part-lobby-players'), /Marco/);
  await checkLayout(phone, 'phone', 'lobby');

  // A duplicated tab carries the same sessionStorage; it must offer a fresh join instead of stealing the seat.
  const savedSeat = await phone.evaluate(() => sessionStorage.getItem('go:session'));
  assert.ok(savedSeat, 'phone saved its seat');
  const dup = await phone.context().newPage();
  await dup.addInitScript((value) => sessionStorage.setItem('go:session', value), savedSeat);
  await dup.goto(`${base}?room=${code}`);
  await dup.locator('#entry-form').waitFor();
  assert.equal(await dup.inputValue('#code-input'), code);
  await dup.close();
  assert.equal(await laptop.locator('.part-lobby-players .player').count(), 2, 'duplicate tab did not add or move a seat');
  await shot(laptop, 'lobby-laptop');
  await shot(phone, 'lobby-phone');
  log('joined');

  // A bad code is refused with a readable error in a third, separate profile.
  const stranger = await newPlayer('stranger', { viewport: { width: 375, height: 700 } });
  await stranger.goto(base);
  await stranger.fill('#name-input', 'Zed');
  await stranger.fill('#code-input', code[0] + (code.slice(1) === 'ZZZ' ? 'YYY' : 'ZZZ'));
  await stranger.click('[data-action="join"]');
  await stranger.locator('.form-error', { hasText: /No room|offline|closed/ }).waitFor({ timeout: 15000 });
  await stranger.context().close();
  log('bad code refused');

  await laptop.click('[data-action="start"]');

  const played = { laptop: [], phone: [] };
  for (let round = 1; round <= HAND; round++) {
    for (const page of [laptop, phone]) {
      await page.locator('[data-part="status"]', { hasText: `Round ${round} of ${HAND}` }).waitFor();
      await page.locator('.hand-wrap.active').waitFor();
    }
    // Reloading mid-game must drop you back into your seat (a phone that slept, a host who hit refresh).
    if (round === 3 || round === 4) {
      const page = round === 3 ? phone : laptop;
      const handOf = (pg) => pg.$$eval('.hand-wrap.active .card', (cs) => cs.map((c) => c.dataset.card).join(','));
      const before = await handOf(page);
      await page.reload();
      await page.locator('[data-part="status"]', { hasText: `Round ${round} of ${HAND}` }).waitFor();
      await page.locator('.hand-wrap.active').waitFor();
      assert.equal(await handOf(page), before, 'same hand after reload');
      // Nobody may stay marked offline once the reloaded tab is back.
      for (const pg of [laptop, phone]) await pg.locator('.part-table .tag.away').waitFor({ state: 'detached', timeout: 15000 });
      if (round === 4) {
        // The phone must see the host come back, then everyone shows as connected again.
        await phone.locator('#banner').waitFor({ state: 'hidden' });
        await laptop.locator('.part-table .tag.away').waitFor({ state: 'detached', timeout: 15000 });
      }
      log(`${round === 3 ? 'phone' : 'host'} reloaded and resumed in round ${round}`);
    }
    const worth = [await text(laptop, '[data-testid="worth"]'), await text(phone, '[data-testid="worth"]')];
    assert.equal(worth[0], worth[1], 'both devices show the same stake');

    const laptopCards = (await laptop.$$eval('.hand-wrap.active .card', (cs) => cs.map((c) => Number(c.dataset.card))));
    const phoneCards = (await phone.$$eval('.hand-wrap.active .card', (cs) => cs.map((c) => Number(c.dataset.card))));
    // Round 1 forces a tie so the rollover path runs; later rounds use fixed but different strategies.
    const a = round === 1 ? 7 : laptopCards[laptopCards.length - 1];
    const b = round === 1 ? 7 : phoneCards[(round * 3) % phoneCards.length];

    if (round === 2) {
      // Switching a bid before the reveal must be allowed.
      const first = phoneCards.find((c) => c !== b);
      await phone.click(`.card[data-card="${first}"]`);
      await phone.locator('[data-testid="hand-hint"]', { hasText: `You bid ${first}.` }).waitFor();
      await laptop.locator('.status.done').first().waitFor();
      await checkTapTargets(phone, 'phone');
      await checkLayout(phone, 'phone', 'bidding');
      await shot(phone, 'bidding-phone');
      await shot(laptop, 'bidding-laptop');
    }
    await phone.click(`.card[data-card="${b}"]`);
    await laptop.click(`.card[data-card="${a}"]`);
    played.laptop.push(a);
    played.phone.push(b);

    const headlines = [];
    for (const page of [laptop, phone]) {
      await page.locator('[data-testid="headline"]').waitFor();
      headlines.push(await text(page, '[data-testid="headline"]'));
    }
    assert.equal(headlines[0], headlines[1], 'both devices announce the same result');
    if (round === 1) assert.match(headlines[0], /Tie at 7/);
    if (round === 2) {
      await checkLayout(phone, 'phone', 'reveal');
      if (shots) await laptop.waitForTimeout(1700); // let the flip and stamp finish
      await shot(laptop, 'reveal-laptop');
      await shot(phone, 'reveal-phone');
    }
    log(`round ${round}: laptop ${a} vs phone ${b} -> ${headlines[0]}`);
  }

  for (const page of [laptop, phone]) await page.locator('[data-testid="winner"]').waitFor({ timeout: 15000 });
  const winners = [await text(laptop, '[data-testid="winner"]'), await text(phone, '[data-testid="winner"]')];
  const tables = [await text(laptop, '.standings'), await text(phone, '.standings')];
  assert.equal(winners[0], winners[1], 'same winner on both screens');
  assert.equal(tables[0], tables[1], 'same standings on both screens');
  assert.deepEqual(played.laptop.slice().sort(), [1, 2, 3, 4, 5, 6, 7]);
  await checkLayout(phone, 'phone', 'over');
  await shot(laptop, 'over-laptop');
  await shot(phone, 'over-phone');
  log('winner:', winners[0]);

  // Rematch brings both back to the lobby; then the phone leaves.
  await laptop.click('[data-action="rematch"]');
  for (const page of [laptop, phone]) await page.locator('[data-testid="room-code"]').waitFor();
  await phone.click('#leave-btn');
  await phone.click('[data-action="confirm-yes"]');
  await phone.locator('#entry-form').waitFor();
  await laptop.locator('.count', { hasText: '1/8' }).waitFor();
  await laptop.click('#leave-btn');
  await laptop.click('[data-action="confirm-yes"]');
  await laptop.locator('#entry-form').waitFor();
  log('rematch, leave and close all work');

  const realProblems = problems.filter((p) => !/favicon/.test(p));
  assert.deepEqual(realProblems, [], 'no page errors');
  if (layoutFailures.length) {
    console.error('layout problems:\n' + layoutFailures.join('\n'));
  } else {
    console.log('MOBILE LAYOUT PASS');
  }
  assert.deepEqual(layoutFailures, []);
  console.log(`E2E BROWSER PASS (${live ? 'live' : 'local'}: ${base})`);
} catch (err) {
  console.error('E2E BROWSER FAILED:', err?.stack || err);
  if (problems.length) console.error('page problems:\n' + problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.close();
}
