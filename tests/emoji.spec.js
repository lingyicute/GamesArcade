const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// 裸写即彩色 emoji 的码位；↗ ↑ → ↓ ✦ ✧ ✹ 是「文字默认呈现」，不属于这一组。
const SUBSET_CODEPOINTS = ['U+1F319', 'U+1F33F', 'U+1F34A', 'U+1F34B', 'U+1F353', 'U+1F984'];
// 只按粗区间收集 emoji 会把这些文字符号一起塞进子集，导致 ↗ 之类被画成彩色 emoji 方块。
const TEXT_PRESENTATION = ['↑', '→', '↓', '↗', '✦', '✧', '✹'];

// 页面里出现的 emoji（与 index.html 中 .match-board / .pair-stage 的内容保持一致）
const EMOJI = ['🍋', '🌙', '🍓', '🦄', '🌿', '🍊'];

test('子集只收「裸写即彩色 emoji」的码位，文字符号不得纳入（回归：↗ 曾被画成彩色 emoji）', () => {
  // 服务端码位表不依赖完整字体，也不联网，可以直接跑脚本来验证。
  const out = execFileSync('python3', [path.join(__dirname, '..', 'scripts', 'subset_emoji.py'), '--dry-run-chars'], {
    encoding: 'utf8',
  });
  const kept = out.split('\n').filter(line => line.startsWith('  U+')).map(line => line.trim().split(' ')[0]);
  expect(kept).toEqual(SUBSET_CODEPOINTS);
  for (const symbol of TEXT_PRESENTATION) {
    expect(out).toContain(symbol);
  }
  expect(out).toContain('跳过');
});

test('emoji 由内嵌的 Yomi UI Emoji 子集接管，且不产生外部字体请求', async ({ page }, testInfo) => {
  const fontRequests = [];
  page.on('request', req => {
    if (/\.(ttf|otf|woff2?)(\?|$)/i.test(req.url())) fontRequests.push(req.url());
  });

  await page.goto('/');
  const info = await page.evaluate(async (emoji) => {
    await document.fonts.ready;
    const faces = [...document.fonts]
      .filter(face => face.family.replace(/["']/g, '') === 'Yomi UI Emoji')
      .map(face => face.status);
    const check = (text) => document.fonts.check('16px "Yomi UI Emoji"', text);
    const boards = [...document.querySelectorAll('.match-board span, .pair-stage span')];
    return {
      familyInStack: getComputedStyle(document.documentElement).getPropertyValue('--page-font').includes('Yomi UI Emoji'),
      bodyFamily: getComputedStyle(document.body).fontFamily,
      faces,
      coveredEmoji: emoji.filter(ch => check(ch)),
      // 回退路径也要能看见：每个 emoji 都占出非零宽度（系统 emoji 字体兜底）
      emojiBoxes: boards.map(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
      externalSrc: [...document.styleSheets]
        .flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } })
        .filter(rule => rule.type === CSSRule.FONT_FACE_RULE && rule.style.fontFamily.replace(/["']/g, '') === 'Yomi UI Emoji')
        .map(rule => rule.style.src),
    };
  }, EMOJI);

  // 三种浏览器共有的约定：字体在字体栈里、内嵌且不产生任何外部字体请求
  expect(info.familyInStack).toBe(true);
  expect(info.bodyFamily).toContain('Yomi UI Emoji');
  expect(info.externalSrc).toHaveLength(1);
  expect(info.externalSrc[0]).toContain('data:font/woff2;base64,');
  expect(info.emojiBoxes.length).toBeGreaterThan(0);
  expect(info.emojiBoxes.every(Boolean)).toBe(true);
  expect(fontRequests).toEqual([]);

  if (info.faces[0] === 'loaded') {
    expect(info.coveredEmoji).toEqual(EMOJI);

    // Chromium 额外核实真正落地绘制的字体（document.fonts.check 不校验字形覆盖，只有这里能证明）：
    // 棋盘 emoji 必须由内嵌子集（内部族名 SamsungColorEmoji）绘制，汉字标题则不能碰到它。
    if (testInfo.project.name === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const familiesOf = async selector => {
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
        const families = new Set();
        for (const nodeId of nodeIds) {
          const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          fonts.forEach(font => families.add(`${font.familyName}:${font.isCustomFont}`));
        }
        return [...families];
      };
      expect(await familiesOf('.match-board span')).toEqual(['SamsungColorEmoji:true']);
      expect(await familiesOf('#hero-title')).not.toContain('SamsungColorEmoji:true');
      // 卡片角上的 ↗ 必须继续由文字字体绘制，不能被 emoji 子集接管
      for (const selector of ['.launch-dot', '.button-arrow']) {
        expect(await familiesOf(selector)).not.toContain('SamsungColorEmoji:true');
      }
    }
  } else {
    // Firefox 不支持 CBDT/CBLC 位图字体（"no supported glyph data table(s) present"），
    // 会拒绝这份子集并优雅回退到系统 emoji 字体——这是预期行为，其余断言仍然成立。
    expect(testInfo.project.name).toBe('firefox');
    expect(info.faces).toEqual(['error']);
    expect(info.coveredEmoji).toEqual([]);
  }
});
