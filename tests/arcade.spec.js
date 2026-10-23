const { test, expect } = require('@playwright/test');

async function enter(page) {
  await page.goto('/');
  await expect(page.locator('#loadingOverlay')).toBeEnabled();
  await page.locator('#loadingOverlay').click();
  await expect(page.locator('#loadingOverlay')).toHaveCount(0);
}

async function deferPlayback(page) {
  await page.addInitScript(() => {
    window.playAttempts = [];
    HTMLMediaElement.prototype.play = function () {
      return new Promise((resolve, reject) => playAttempts.push({ resolve, reject }));
    };
  });
}

test('without JavaScript the catalog and navigation remain usable', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8000/');
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  await expect(page.locator('[inert]')).toHaveCount(0);
  // 13 cards: 11 Material You + 2 classic remakes, as the nav, filter buttons and
  // group headings declare. Without JavaScript nothing is hidden, so all of them show.
  await expect(page.locator('.game-card:visible')).toHaveCount(13);
  await expect(page.locator('.filters')).toBeHidden();
  await expect(page.locator('#musicToggle')).toBeHidden();
  await page.locator('.button-primary').click();
  await expect(page).toHaveURL(/#games$/);
  await context.close();
});

test('filtering keeps counts, groups and accessible button states consistent', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await enter(page);

  // The catalog size is declared four times in the markup (nav, filter buttons, group
  // headings, hero copy). Read those back and assert the filter agrees with them, so a
  // catalog edit cannot leave the declared counts disagreeing with what is shown.
  const declared = await page.evaluate(() => {
    const digits = node => Number(String(node.textContent).replace(/\D/g, ''));
    const buttons = [...document.querySelectorAll('[data-filter]')];
    return {
      total: digits(document.querySelector('.site-nav .nav-count')),
      perFilter: Object.fromEntries(buttons.map(b => [b.dataset.filter, digits(b.querySelector('.filter-count'))])),
      perGroup: [...document.querySelectorAll('.game-group')].map(g => ({
        kind: g.dataset.group,
        declared: digits(g.querySelector('.group-count')),
        cards: g.querySelectorAll('.game-card').length,
      })),
    };
  });
  expect(declared.total).toBe(13); // 11 Material You + 2 classic remakes.
  expect(declared.perFilter.all).toBe(declared.total);
  expect(declared.perFilter.material + declared.perFilter.classic).toBe(declared.total);
  for (const group of declared.perGroup) {
    expect(group.cards).toBe(group.declared);
    expect(group.cards).toBe(declared.perFilter[group.kind]);
  }

  for (const filter of ['classic', 'material', 'all']) {
    const count = declared.perFilter[filter];
    const groups = filter === 'all' ? declared.perGroup.length : 1;
    await page.locator(`[data-filter="${filter}"]`).click();
    await expect(page.locator('.game-card:visible')).toHaveCount(count);
    await expect(page.locator('.game-group:visible')).toHaveCount(groups);
    await expect(page.locator('[data-filter][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#filterStatus')).toContainText(`${count} 款游戏`);
  }
  expect(errors).toEqual([]);
});

test('failed assets do not block entering the page', async ({ page }) => {
  await page.route('**/assets/**', route => route.abort());
  await enter(page);
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
});

test('a stalled resource is bounded by the loading watchdog', async ({ page }) => {
  await page.clock.install();
  // An image blocks both decode() and window.load. Audio alone can be aborted by
  // audio.load(), which would accidentally exercise the error fallback instead.
  await page.route('**/assets/penguin.png', () => {});
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#loadingOverlay')).toBeDisabled();
  await page.clock.fastForward(10001);
  await expect(page.locator('#loadingOverlay')).toBeEnabled();
  await page.locator('#loadingOverlay').click();
  await page.clock.fastForward(401);
  await expect(page.locator('body')).not.toHaveClass(/is-loading/);
});

test('an older playback rejection must not mute a newer request', async ({ page }) => {
  await deferPlayback(page);
  await enter(page);
  const button = page.locator('#musicToggle');
  await button.click(); // mute while the initial request is pending
  await button.click(); // new play request
  await expect.poll(() => page.evaluate(() => playAttempts.length)).toBe(2);
  await page.evaluate(() => playAttempts[0].reject(new Error('old request failed')));
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('#ambience').evaluate(audio => audio.muted)).toBe(false);
  await page.evaluate(() => playAttempts[1].reject(new Error('current request failed')));
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('aria-label', /重试|再试/);
});

test('a media error after playback starts updates the music control', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  await enter(page);
  await page.locator('#ambience').evaluate(audio => audio.dispatchEvent(new Event('error')));
  await expect(page.locator('#musicToggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#musicToggle')).toHaveAttribute('aria-label', /重试|再试/);
});

test('keyboard entry transfers focus to usable page content', async ({ page }) => {
  await page.goto('/');
  const overlay = page.locator('#loadingOverlay');
  await expect(overlay).toBeEnabled();
  await overlay.focus();
  await page.keyboard.press('Enter');
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('.brand')).toBeFocused();
});

test('pointer highlight follows the card after scrolling without pointerleave', async ({ page }) => {
  await enter(page);
  const error = await page.locator('.game-card').first().evaluate(card => {
    // Disable hover transitions and smooth scrolling to isolate stale geometry.
    document.documentElement.style.scrollBehavior = 'auto';
    card.scrollIntoView({ block: 'center' });
    card.dispatchEvent(new PointerEvent('pointerenter'));
    window.scrollBy(0, 30);
    const rect = card.getBoundingClientRect();
    const clientX = rect.left + 70, clientY = rect.top + 80;
    card.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY }));
    return Math.abs(parseFloat(card.style.getPropertyValue('--my')) - (clientY - rect.top));
  });
  expect(error).toBeLessThan(1);
});

test('snapshot encoding failure keeps a full-size visible canvas fallback', async ({ page }) => {
  await page.addInitScript(() => { HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); }; });
  await enter(page);
  await expect(page.locator('#bg')).toBeVisible();
  expect(await page.locator('#bg').evaluate(canvas => canvas.width)).toBeGreaterThan(1);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.locator('#bg').evaluate(canvas => canvas.width)).toBe(375);
});

test('resize replaces sky snapshots and releases the old object URL', async ({ page }) => {
  await page.addInitScript(() => {
    window.revokedURLs = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { revokedURLs.push(url); revoke(url); };
  });
  await enter(page);
  await expect(page.locator('#bg-snapshot')).toBeVisible();
  const old = await page.locator('#bg-snapshot').getAttribute('src');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#bg-snapshot')).not.toHaveAttribute('src', old);
  await expect(page.locator('#bg-snapshot')).toBeVisible();
  expect(await page.evaluate(url => revokedURLs.includes(url), old)).toBe(true);
  await expect(page.locator('#bg')).toBeHidden();
  expect(await page.locator('#bg').evaluate(canvas => [canvas.width, canvas.height])).toEqual([1, 1]);
});

test('reduced motion changes stop and resume animation', async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    window.drawCount = 0;
    const draw = Scene.draw;
    Scene.draw = (...args) => { drawCount++; return draw(...args); };
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => drawCount)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => drawCount)).toBeGreaterThan(2);
  await page.evaluate(() => {
    window.motionChanged = new Promise(resolve => {
      const query = matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', resolve, { once: true });
    });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => motionChanged);
  const reduced = await page.evaluate(() => drawCount);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => drawCount)).toBe(reduced);
});

test('pagehide and pageshow handlers pause and resume animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await enter(page);
  await page.evaluate(() => {
    window.drawCount = 0;
    const draw = Scene.draw;
    Scene.draw = (...args) => { drawCount++; return draw(...args); };
  });
  await expect.poll(() => page.evaluate(() => drawCount)).toBeGreaterThan(2);
  // Exercise the handlers, not a real BFCache navigation.
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  const paused = await page.evaluate(() => drawCount);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => drawCount)).toBe(paused);
  await page.evaluate(() => dispatchEvent(new Event('pageshow')));
  await expect.poll(() => page.evaluate(() => drawCount)).toBeGreaterThan(paused + 2);
});

test('a synchronous play failure leaves navigation usable and music retryable', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => { throw new Error('play unavailable'); };
  });
  await enter(page);
  await expect(page.locator('#musicToggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#musicToggle')).toHaveAttribute('aria-label', /重试|再试/);
  await expect(page.locator('[inert]')).toHaveCount(0);
});

test('out-of-order sky decoding cannot replace a newer resize snapshot', async ({ page }) => {
  await page.addInitScript(() => {
    window.skyDecodes = [];
    window.revokedURLs = [];
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const decoded = decode.call(this);
      if (this.id !== 'bg-snapshot') return decoded;
      return new Promise((resolve, reject) => {
        skyDecodes.push({ src: this.src, release: () => decoded.then(resolve, reject) });
      });
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { revokedURLs.push(url); revoke(url); };
  });
  await enter(page);
  await expect.poll(() => page.evaluate(() => skyDecodes.length)).toBeGreaterThan(0);
  const count = await page.evaluate(() => skyDecodes.length);
  await page.setViewportSize({ width: 414, height: 896 });
  await expect.poll(() => page.evaluate(() => skyDecodes.length)).toBeGreaterThan(count);
  const newest = await page.evaluate(async () => {
    const latest = skyDecodes[skyDecodes.length - 1];
    await latest.release();
    return latest.src;
  });
  await expect(page.locator('#bg-snapshot')).toHaveAttribute('src', newest);
  await page.evaluate(() => Promise.all(skyDecodes.slice(0, -1).map(item => item.release())));
  await expect(page.locator('#bg-snapshot')).toHaveAttribute('src', newest);
  expect(await page.evaluate(() => skyDecodes.slice(0, -1).every(item => revokedURLs.includes(item.src)))).toBe(true);
});
