const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>\s*(\(function \(root\)[\s\S]*?)<\/script>/)[1];
const runtime = script.slice(script.indexOf('\n(function(){'));

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.setContent('<canvas id="bg"></canvas><canvas id="c"></canvas><div class="hero-signature"></div>');
  await page.evaluate(() => {
    const state = window.stageTest = {
      now: 0, hidden: false, draws: [], statics: 0, encodes: 0, measures: 0,
      frames: new Map(), nextId: 0
    };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden });
    Object.defineProperty(performance, 'now', { configurable: true, value: () => state.now });
    Object.defineProperty(document.querySelector('.hero-signature'), 'offsetHeight', {
      configurable: true, get: () => { state.measures++; return 100; }
    });
    const listeners = new Set();
    const motion = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
    window.matchMedia = query => query.includes('prefers-reduced-motion') ? motion : {
      matches: true, addEventListener() {}, removeEventListener() {}
    };
    window.requestAnimationFrame = fn => { const id = ++state.nextId; state.frames.set(id, fn); return id; };
    window.cancelAnimationFrame = id => state.frames.delete(id);
    HTMLCanvasElement.prototype.toBlob = function (cb) { state.encodes++; cb(null); };
    window.Scene = {
      W: 1872, H: 1044, view: {}, animationBounds: { x0: -186, y0: -60, x1: 2086, y1: 814 },
      setSpriteScale() {}, draw: (_, time) => state.draws.push(time), drawStatic: () => state.statics++
    };
    state.tick = now => {
      state.now = now;
      const callbacks = [...state.frames.values()];
      state.frames.clear();
      callbacks.forEach(fn => fn(now));
    };
    state.visibility = hidden => { state.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    state.motion = value => { motion.matches = value; listeners.forEach(fn => fn()); };
    state.resize = width => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      dispatchEvent(new Event('resize'));
    };
    state.counts = () => ({ draws: state.draws.length, statics: state.statics, encodes: state.encodes, measures: state.measures });
  });
  await page.addScriptTag({ content: runtime });
});

test('hidden resize and motion changes do no canvas work and coalesce on return', async ({ page }) => {
  const before = await page.evaluate(() => {
    stageTest.tick(100);
    stageTest.resize(900); // Also cancel a timer scheduled before visibility changes.
    stageTest.visibility(true);
    const before = stageTest.counts();
    stageTest.resize(800);
    stageTest.resize(700);
    stageTest.motion(true);
    return before;
  });
  await page.clock.runFor(500);
  expect(await page.evaluate(() => stageTest.counts())).toEqual(before);
  expect(await page.evaluate(() => stageTest.frames.size)).toBe(0);
  const resumed = await page.evaluate(() => {
    stageTest.visibility(false);
    return { counts: stageTest.counts(), width: document.getElementById('bg').width, frames: stageTest.frames.size, time: stageTest.draws.at(-1) };
  });
  expect(resumed.counts.draws).toBe(before.draws + 1);
  expect(resumed.counts.statics).toBe(before.statics + 1);
  expect(resumed.counts.encodes).toBe(before.encodes + 1);
  expect(resumed.width).toBe(700);
  expect(resumed.frames).toBe(0);
  expect(resumed.time).toBe(0);
});

test('a hidden motion change is repainted once even without a geometry change', async ({ page }) => {
  const result = await page.evaluate(() => {
    stageTest.tick(250);
    stageTest.visibility(true);
    const before = stageTest.counts();
    stageTest.motion(true);
    const hidden = stageTest.counts();
    stageTest.visibility(false);
    const visible = stageTest.counts();
    stageTest.visibility(false); // Duplicate lifecycle delivery must be a no-op.
    return { before, hidden, visible, duplicate: stageTest.counts(), time: stageTest.draws.at(-1) };
  });
  expect(result.hidden).toEqual(result.before);
  expect(result.visible.draws).toBe(result.before.draws + 1);
  expect(result.visible.statics).toBe(result.before.statics);
  expect(result.duplicate).toEqual(result.visible);
  expect(result.time).toBe(0);
});

test('pagehide defers media changes and resize work until pageshow', async ({ page }) => {
  const before = await page.evaluate(() => {
    stageTest.tick(100);
    dispatchEvent(new Event('pagehide'));
    const before = stageTest.counts();
    stageTest.resize(820);
    stageTest.motion(true);
    return before;
  });
  await page.clock.runFor(500);
  expect(await page.evaluate(() => stageTest.counts())).toEqual(before);
  const result = await page.evaluate(() => {
    dispatchEvent(new Event('pageshow'));
    const shown = stageTest.counts();
    dispatchEvent(new Event('pageshow'));
    return { shown, duplicate: stageTest.counts(), frames: stageTest.frames.size };
  });
  expect(result.shown.draws).toBe(before.draws + 1);
  expect(result.shown.statics).toBe(before.statics + 1);
  expect(result.duplicate).toEqual(result.shown);
  expect(result.frames).toBe(0);
});

test('resume excludes hidden time and does not immediately repaint a fitted frame', async ({ page }) => {
  const result = await page.evaluate(() => {
    stageTest.tick(1000);
    stageTest.visibility(true);
    stageTest.now = 11000;
    stageTest.resize(850);
    stageTest.visibility(false);
    const fitted = stageTest.draws.at(-1), count = stageTest.draws.length;
    stageTest.tick(11001);
    const early = stageTest.draws.length;
    stageTest.tick(11020);
    return { fitted, count, early, next: stageTest.draws.at(-1), frames: stageTest.frames.size };
  });
  expect(result.fitted).toBeCloseTo(1, 8);
  expect(result.early).toBe(result.count);
  expect(result.next).toBeCloseTo(1.02, 8);
  expect(result.frames).toBe(1);
});

test('high-refresh displays keep a single loop capped near 60 paints per second', async ({ page }) => {
  const result = await page.evaluate(() => {
    const before = stageTest.draws.length;
    for (let frame = 1; frame <= 240; frame++) stageTest.tick(frame * 1000 / 240);
    return { paints: stageTest.draws.length - before, frames: stageTest.frames.size };
  });
  expect(result.paints).toBeGreaterThanOrEqual(59);
  expect(result.paints).toBeLessThanOrEqual(61);
  expect(result.frames).toBe(1);
});

test('unchanged resize events do not repaint or encode another snapshot', async ({ page }) => {
  const before = await page.evaluate(() => {
    stageTest.motion(true);
    const before = stageTest.counts();
    for (let i = 0; i < 10; i++) dispatchEvent(new Event('resize'));
    return before;
  });
  await page.clock.runFor(121);
  const after = await page.evaluate(() => stageTest.counts());
  expect(after.draws).toBe(before.draws);
  expect(after.statics).toBe(before.statics);
  expect(after.encodes).toBe(before.encodes);
  expect(after.measures).toBe(before.measures + 1);
});
