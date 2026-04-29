# AO3 Reader

优化 AO3 (Archive of Our Own) 网站在手机端的阅读体验，提供分页阅读模式，支持点击/滑动翻页。

## 功能

- **分页阅读** — 使用 CSS 多列布局将长文章自动分页，模拟电子书翻页体验
- **点击/滑动翻页** — 屏幕左侧点击=上一页，右侧=下一页，中间=设置；支持左右滑动
- **键盘翻页** — 左右方向键翻页，Esc 退出阅读模式
- **AJAX 章节切换** — 无需整页刷新即可切换到上一章/下一章/指定章节
- **多主题** — 浅色、护眼（sepia）、深色、自定义背景色
- **字体/边距调节** — 字号（12-28px）、行高（1.5/1.8/2.0/2.2）、四面边距独立调节
- **翻页方向可逆** — 支持左右翻页方向互换
- **浏览器前进/后退** — 使用 history.pushState，不影响浏览器原生导航

## 安装方式

### 方式一：油猴脚本（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 浏览器扩展
2. [点击安装脚本](https://raw.githubusercontent.com/franose371/ao3-reader/main/userscript/ao3-reader.user.js)
3. 访问任意 AO3 作品页面，点击右下角浮动按钮进入阅读模式

油猴脚本支持自动更新。

### 方式二：Chrome 扩展

1. 下载本仓库
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择 `chrome-extension/` 目录
5. 访问任意 AO3 作品页面使用

## 使用说明

进入阅读模式后：

| 操作 | 行为 |
|------|------|
| 点击屏幕左侧 | 上一页（翻页方向可设置） |
| 点击屏幕右侧 | 下一页 |
| 点击屏幕中间 | 打开/关闭设置菜单 |
| 左右滑动 | 翻页 |
| ← → 方向键 | 翻页 |
| Esc | 退出阅读模式 |
| 底部按钮 | 切换章节 |

阅读菜单中可调节字体、主题、边距、翻页方向等。

## 项目结构

```
ao3-reader/
├── chrome-extension/          # Chrome 扩展版本
│   ├── manifest.json          # 扩展清单 (Manifest V3)
│   ├── content.js             # 内容脚本
│   ├── content.css            # 注入样式
│   ├── background.js          # Service Worker（初始化默认设置）
│   ├── popup.html             # 弹出窗口
│   ├── popup.js
│   ├── popup.css
│   └── icons/                 # 扩展图标
└── userscript/                # 油猴脚本版本
    └── ao3-reader.user.js     # 单文件油猴脚本
```

## 技术实现

- **分页引擎**：通过 CSS `column-width` + `column-gap` 实现原生文本流分页，而非简单裁剪，确保段落完整显示
- **页面测量**：使用隐藏测量元素 + `scrollWidth` 精确计算分页数
- **章节加载**：`fetch()` 获取下一章 HTML，通过 `DOMParser` 解析提取正文内容，支持登录受限作品（自动携带 Cookie）
- **存储**：油猴脚本使用 `GM_setValue`/`GM_getValue`，Chrome 扩展使用 `chrome.storage.sync`

## License

MIT
