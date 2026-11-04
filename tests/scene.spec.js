const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Expose internals only in this isolated test page; keep the production API unchanged.
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>\s*(\(function \(root\)[\s\S]*?)<\/script>/)[1];
const scene = script.slice(0, script.indexOf('\n(function(){')).replace(
  'root.Scene = {',
  'root.Scene = { test: { bakedSprite, bunnyEarArt, chickBodyArt, cache: CACHE, getState: () => [NOSQ, BODY_SHADOW_SCALE] },'
);

test.beforeEach(async ({ page }) => {
  await page.addScriptTag({ content: scene });
});

test('baked sprite rounding preserves the logical coordinate scale', async ({ page }) => {
  const scales = await page.evaluate(() => {
    return [0.5, 0.625, 0.875, 1, 1.375, 2].map(scale => {
      Scene.setSpriteScale(scale);
      const density = scale * 0.5;
      const sp = Scene.test.bakedSprite('rounding', { x: -31, y: -17, w: 63, h: 85 }, 0.5, ctx => ctx.fillRect(-20, 0, 10, 10));
      return [sp.c.width / sp.w, sp.c.height / sp.h, density];
    });
  });
  for (const [x, y, density] of scales) {
    expect(x).toBeCloseTo(density, 10);
    expect(y).toBeCloseTo(density, 10);
  }
});

test('baked shadows scale with device density and restore rendering state on failure', async ({ page }) => {
  const result = await page.evaluate(() => {
    const observed = [];
    const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'shadowBlur');
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur', {
      configurable: true,
      get: descriptor.get,
      set(value) { if (value > 0) observed.push(value); descriptor.set.call(this, value); }
    });
    Scene.setSpriteScale(0.5);
    Scene.test.bakedSprite('shadow-chick', { x: -200, y: -200, w: 400, h: 400 }, 0.5, ctx => Scene.test.chickBodyArt(ctx, false));
    Scene.test.bakedSprite('shadow-ear', { x: -200, y: -200, w: 400, h: 400 }, 0.5, ctx => Scene.test.bunnyEarArt(ctx, [0, 0, 0, -100, 44]));
    const before = Scene.test.getState();
    try {
      Scene.test.bakedSprite('throws', { x: 0, y: 0, w: 10, h: 10 }, 1, () => { throw new Error('painter failure'); });
    } catch (_) {}
    const after = Scene.test.getState();
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur', descriptor);
    return { observed, before, after };
  });
  expect(result.observed).toEqual([6, 6]); // 12px authored at stage density 1, now density 0.5.
  expect(result.before).toEqual([false, 1]);
  expect(result.after).toEqual(result.before);
});

test('all sampled animation paint stays inside tightly fitted crop bounds', async ({ page }) => {
  const result = await page.evaluate(() => {
    const b = Scene.animationBounds, scale = 0.25, pad = 80;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((b.x1 - b.x0 + pad * 2) * scale);
    canvas.height = Math.ceil((b.y1 - b.y0 + pad * 2) * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    Scene.setSpriteScale(0.5);
    ctx.setTransform(scale, 0, 0, scale, (-b.x0 + pad) * scale, (-b.y0 + pad) * scale);
    // Accumulate alpha over a full 201-frame character cycle. This also covers
    // the independent 118-frame shooting-star cycle; sample both half-frames.
    for (let f = 0; f <= 201; f += 0.5) Scene.draw(ctx, f / Scene.FPS);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let outside = 0, minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    const margin = pad * scale;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] > 0) {
        if (x < margin || y < margin || x >= canvas.width - margin || y >= canvas.height - margin) outside++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return {
      outside,
      slack: [
        minX / scale - pad,
        minY / scale - pad,
        (canvas.width - 1 - maxX) / scale - pad,
        (canvas.height - 1 - maxY) / scale - pad
      ]
    };
  });
  expect(result.outside).toBe(0);
  for (const side of result.slack) expect(side).toBeLessThanOrEqual(16);
});

test('cached character and prop sprites keep a transparent 1px border across densities', async ({ page }) => {
  const clipped = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = Scene.W;
    canvas.height = Scene.H;
    const ctx = canvas.getContext('2d');
    const bad = [];
    // Exercise every 1/8-density bucket, not only the endpoints: outward
    // rounding and engine-specific stroke AA can expose intermediate edges.
    for (let bucket = 4; bucket <= 16; bucket++) {
      const scale = bucket / 8;
      Scene.setSpriteScale(scale);
      for (let f = 0; f < 201; f += 5) Scene.draw(ctx, f / Scene.FPS);
      for (const [key, entry] of Object.entries(Scene.test.cache)) {
        const { width, height } = entry.c;
        const { data } = entry.c.getContext('2d').getImageData(0, 0, width, height);
        let edgeAlpha = 0;
        for (let x = 0; x < width; x++) {
          edgeAlpha = Math.max(edgeAlpha, data[x * 4 + 3], data[((height - 1) * width + x) * 4 + 3]);
        }
        for (let y = 0; y < height; y++) {
          edgeAlpha = Math.max(edgeAlpha, data[y * width * 4 + 3], data[(y * width + width - 1) * 4 + 3]);
        }
        if (edgeAlpha > 0) bad.push({ scale, key, edgeAlpha });
      }
    }
    return bad;
  });
  expect(clipped).toEqual([]);
});

test('prewarm bakes every sprite the loop can ask for, at every density', async ({ page }) => {
  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = Scene.W;
    canvas.height = Scene.H;
    const ctx = canvas.getContext('2d');
    const keys = () => Object.keys(Scene.test.cache);
    const out = [];
    for (const scale of [0.5, 1, 2]) {
      Scene.setSpriteScale(scale);
      let slices = 1;
      while (Scene.prewarm(0.001) && slices < 500) slices++;
      const warmed = keys();
      // two full cycles, frame by frame: every blink window and the excited stretch included
      for (let f = 0; f < 402; f++) Scene.draw(ctx, f / Scene.FPS);
      out.push({ scale, slices, late: keys().filter(k => !warmed.includes(k)), more: Scene.prewarm(Infinity) });
    }
    return out;
  });
  for (const r of result) {
    expect(r.slices, 'baking is spread over several calls').toBeGreaterThan(5);
    expect(r.late, 'sprites first baked during the animation at scale ' + r.scale).toEqual([]);
    expect(r.more).toBe(false);
  }
});

test('prewarm restarts after a density change and keeps frame state intact', async ({ page }) => {
  const result = await page.evaluate(() => {
    const keys = () => Object.keys(Scene.test.cache);
    Scene.setSpriteScale(1);
    Scene.prewarm(Infinity);
    const first = keys().length;
    Scene.setSpriteScale(1.5);
    const dropped = keys().length < first;
    const pending = Scene.prewarm(0.001);
    Scene.prewarm(Infinity);
    return { first, dropped, pending, again: keys().length, state: Scene.test.getState() };
  });
  expect(result.dropped).toBe(true);
  expect(result.pending).toBe(true);
  expect(result.again).toBeGreaterThanOrEqual(result.first);
  expect(result.state).toEqual([false, 1]);
});

test('density changes release evicted canvas backing stores immediately', async ({ page }) => {
  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = Scene.W; canvas.height = Scene.H;
    const ctx = canvas.getContext('2d');
    Scene.setSpriteScale(2);
    for (let f = 0; f < 201; f += 5) Scene.draw(ctx, f / Scene.FPS);
    const previous = Object.values(Scene.test.cache).map(entry => entry.c);
    const before = previous.reduce((sum, c) => sum + c.width * c.height, 0);
    Scene.setSpriteScale(0.5);
    return { before, retained: previous.reduce((sum, c) => sum + c.width * c.height, 0), keys: Object.keys(Scene.test.cache) };
  });
  expect(result.before).toBeGreaterThan(0);
  expect(result.retained).toBe(0);
  expect(result.keys).toEqual([]);
});

test('body sprites at their density cap survive higher-density changes', async ({ page }) => {
  const result = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    Scene.setSpriteScale(1);
    Scene.draw(ctx, 0);
    const bodies = Object.entries(Scene.test.cache).filter(([key]) => key.startsWith('body:'));
    const props = Object.entries(Scene.test.cache).filter(([key]) => !key.startsWith('body:'));
    Scene.setSpriteScale(2);
    Scene.draw(ctx, 0);
    return {
      count: bodies.length,
      reused: bodies.every(([key, entry]) => Scene.test.cache[key] === entry && entry.c.width > 0 && entry.c.height > 0),
      released: props.every(([, entry]) => entry.c.width === 0 && entry.c.height === 0)
    };
  });
  expect(result.count).toBe(6);
  expect(result.reused).toBe(true);
  expect(result.released).toBe(true);
});

test('same density buckets and invalid scales preserve warm sprites', async ({ page }) => {
  const stable = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    Scene.setSpriteScale(0.61);
    Scene.draw(ctx, 0);
    const previous = Object.entries(Scene.test.cache);
    for (const scale of [0.62, NaN, Infinity, -Infinity]) Scene.setSpriteScale(scale);
    return previous.length > 0 && previous.every(([key, entry]) => Scene.test.cache[key] === entry && entry.c.width > 0 && entry.c.height > 0);
  });
  expect(stable).toBe(true);
});

test('released sprites rebuild with identical pixels when returning to a density', async ({ page }) => {
  const changed = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = Scene.W; canvas.height = Scene.H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    Scene.setSpriteScale(0.5);
    Scene.draw(ctx, 1.5);
    const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    Scene.setSpriteScale(2);
    Scene.draw(ctx, 1.5);
    Scene.setSpriteScale(0.5);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    Scene.draw(ctx, 1.5);
    const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) count++;
    return count;
  });
  expect(changed).toBe(0);
});
