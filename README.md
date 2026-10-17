# GamesArcade

小游戏陈列页；直接部署 `index.html` 和 `assets/`，无需构建或生产依赖。

## 本地预览

```sh
python -m http.server 8000 --bind 0.0.0.0
```

页面采用渐进增强：禁用 JavaScript 时仍可浏览全部游戏、使用游戏链接；音乐、筛选与加载遮罩仅在脚本执行后启用。

## 回归测试（仅开发环境）

需要 Node.js 18+、npm 和 Python 3。Playwright 仅用于测试，不参与生产部署。

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm test
```

测试会启动本地 HTTP 服务；非 CI 环境也可复用已在 8000 端口运行的项目服务。请勿在该端口运行无关服务。
默认单 worker，避免多个 Canvas 密集型浏览器实例耗尽小型容器资源。可用 `npm test -- --project=chromium` 只测试一种浏览器。

覆盖：无 JavaScript 降级、分类筛选、资源失败/超时、音频异步竞态与错误、键盘焦点、滚动后的指针高亮、天空快照降级/乱序/URL 回收、减少动态效果偏好切换、页面生命周期处理器、精灵像素对齐/阴影缩放/异常状态恢复，以及动画绘制边界采样。

## License

AGPL-3.0
