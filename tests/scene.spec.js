const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Expose internals only in this isolated test page; keep the production API unchanged.
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>\s*(\(function \(root\)[\s\S]*?)<\/script>/)[1];
const scene = script.slice(0, script.indexOf('\n(function(){')).replace(
  'root.Scene = {',
  'root.Scene = { test: { bakedSprite, bunnyEarArt, chickBodyArt, getState: () => [NOSQ, BODY_SHADOW_SCALE] },'
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

test('all sampled animation paint stays inside the declared crop bounds', async ({ page }) => {
  const outside = await page.evaluate(() => {
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
    let outside = 0;
    const margin = pad * scale;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (x < margin || y < margin || x >= canvas.width - margin || y >= canvas.height - margin) {
        if (data[(y * canvas.width + x) * 4 + 3] > 0) outside++;
      }
    }
    return outside;
  });
  expect(outside).toBe(0);
});
