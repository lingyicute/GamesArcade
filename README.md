# GamesArcade

梨的小游戏陈列页。

## 部署

直接部署 `index.html` 和 `assets/`，无需任何构建步骤，也没有生产依赖。

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

## 🗂️ License

```
This program is released under the GNU Affero General Public License v3.0 (AGPLv3).

Copyright (C) 2026 lingyicute.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see https://www.gnu.org/licenses.
```