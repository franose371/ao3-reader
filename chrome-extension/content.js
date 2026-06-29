// AO3 Reader - Content Script
(function () {
  'use strict';

  // ── Default settings ────────────────────────────────────────────────
  const DEFAULTS = {
    swapLR: 'leftright',
    fontSize: 18,
    theme: 'light',
    lineHeight: 1.8,
    customColor: '',
    marginTop: 12,
    marginBottom: 12,
    marginLeft: 20,
    marginRight: 20,
    pageScroll: false,
    pageScrollDirection: 'updown',
    autoEnterReader: false,
  };

  // ── State ───────────────────────────────────────────────────────────
  let settings = { ...DEFAULTS };
  let currentPage = 0;
  let totalPages = 1;
  let chapterLinks = { prev: null, next: null, select: null };
  let chapterTitle = '';
  let workTitle = '';
  let isActive = false;
  let isLoadingChapter = false;
  let readerEventsBound = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let lastPageActionTime = 0;
  let cachedContentEl = null;   // for repaginate after AJAX chapter load
  let chapterSummary = null;    // cloned DOM node for chapter summary
  let pageScrollEventsBound = false;
  let psTouchStartX = 0;
  let psTouchStartY = 0;
  const chapterCache = new Map();  // url -> chapter data, so popstate can render without refetch

  // DOM refs (populated when reader is created)
  let overlay, header, viewport, pagesEl, footer, menu, pageIndicator, loadingEl;

  // ── Settings ────────────────────────────────────────────────────────
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('ao3ReaderSettings', (data) => {
        if (data.ao3ReaderSettings) {
          settings = { ...DEFAULTS, ...data.ao3ReaderSettings };
          // Migrate old boolean swapLR to string
          if (typeof settings.swapLR === 'boolean') {
            settings.swapLR = settings.swapLR ? 'rightleft' : 'leftright';
          }
        }
        resolve();
      });
    });
  }

  function saveSettings() {
    chrome.storage.sync.set({ ao3ReaderSettings: settings });
  }

  // ── AO3 page parsing ────────────────────────────────────────────────
  function parseAO3Page() {
    const result = { hasContent: false, contentEl: null };

    // Get the userstuff content — exclude blockquote.userstuff used in
    // chapter summaries/notes to avoid picking up summary instead of body
    const allUserstuff = document.querySelectorAll('#chapters .userstuff');
    let userstuff = null;
    for (const el of allUserstuff) {
      if (!el.closest('.summary') && !el.closest('.notes') && el.tagName !== 'BLOCKQUOTE') {
        userstuff = el;
        break;
      }
    }
    if (!userstuff && allUserstuff.length > 0) userstuff = allUserstuff[0];
    if (!userstuff) return result;

    // Get work title
    const titleEl = document.querySelector('h2.title.heading');
    workTitle = titleEl ? titleEl.textContent.trim() : '';

    // Get chapter title
    const chapterTitleEl =
      document.querySelector('#chapters h3.title') ||
      document.querySelector('.chapter .title');
    chapterTitle = chapterTitleEl
      ? chapterTitleEl.textContent.trim()
      : workTitle;

    // Get chapter navigation links
    const prevLink = document.querySelector('li.chapter.previous a');
    const nextLink = document.querySelector('li.chapter.next a');
    chapterLinks.prev = prevLink ? prevLink.href : null;
    chapterLinks.next = nextLink ? nextLink.href : null;

    // Get chapter select dropdown (if exists)
    const chapterSelect = document.querySelector('#selected_id');
    if (chapterSelect && chapterSelect.tagName === 'SELECT') {
      const options = [...chapterSelect.options].map((opt) => ({
        value: opt.value,
        text: opt.textContent.trim(),
        selected: opt.selected,
      }));
      chapterLinks.select = {
        options,
        currentIndex: chapterSelect.selectedIndex,
        onChange: chapterSelect.getAttribute('onchange'),
      };
    }

    // Get author
    const authorEl = document.querySelector('h3.byline a[rel="author"]');
    if (authorEl) {
      chapterTitle = workTitle + ' - ' + authorEl.textContent.trim();
    }

    // Get chapter summary (if exists)
    const summaryBlock = document.querySelector('.preface .summary blockquote.userstuff')
      || document.querySelector('.chapter.preface .summary blockquote.userstuff');
    chapterSummary = summaryBlock ? summaryBlock.cloneNode(true) : null;

    result.hasContent = true;
    result.contentEl = userstuff;
    return result;
  }

  // ── Reading mode UI ─────────────────────────────────────────────────
  function createReaderUI() {
    // Floating entry button
    const entryBtn = document.createElement('button');
    entryBtn.id = 'ao3-reader-entry-btn';
    entryBtn.innerHTML = '📖';
    entryBtn.title = '进入阅读模式';
    entryBtn.addEventListener('click', enterReadingMode);
    document.body.appendChild(entryBtn);

    // Overlay
    overlay = document.createElement('div');
    overlay.id = 'ao3-reader-overlay';
    overlay.style.display = 'none';

    // Header
    header = document.createElement('div');
    header.id = 'ao3-reader-header';
    header.innerHTML = `
      <button id="ao3-reader-btn-exit" title="退出">✕</button>
      <span class="chapter-title">${escapeHtml(chapterTitle)}</span>
      <span class="page-indicator" id="ao3-reader-page-indicator">1/1</span>
    `;

    // Viewport
    viewport = document.createElement('div');
    viewport.id = 'ao3-reader-viewport';

    pagesEl = document.createElement('div');
    pagesEl.id = 'ao3-reader-pages';
    viewport.appendChild(pagesEl);

    // Footer
    footer = document.createElement('div');
    footer.id = 'ao3-reader-footer';
    footer.innerHTML = buildFooterHTML();

    // Menu
    menu = document.createElement('div');
    menu.id = 'ao3-reader-menu';
    menu.innerHTML = buildMenuHTML();

    // Chapter loading overlay
    loadingEl = document.createElement('div');
    loadingEl.id = 'ao3-reader-loading';
    loadingEl.setAttribute('role', 'status');
    loadingEl.setAttribute('aria-live', 'polite');
    loadingEl.setAttribute('aria-hidden', 'true');
    loadingEl.innerHTML = `
      <div class="loading-card">
        <div class="loading-spinner"></div>
        <div class="loading-text">章节加载中...</div>
      </div>
    `;

    overlay.appendChild(header);
    overlay.appendChild(viewport);
    overlay.appendChild(footer);
    overlay.appendChild(loadingEl);
    overlay.appendChild(menu);
    document.body.appendChild(overlay);

    // Cache DOM refs
    pageIndicator = document.getElementById('ao3-reader-page-indicator');
  }

  function buildFooterHTML() {
    const prevDisabled = chapterLinks.prev ? '' : 'disabled';
    const nextDisabled = chapterLinks.next ? '' : 'disabled';
    const prevHref = chapterLinks.prev || '#';
    const nextHref = chapterLinks.next || '#';

    let selectHTML = '';
    if (chapterLinks.select) {
      const opts = chapterLinks.select.options
        .map(
          (o, i) =>
            `<option value="${i}" ${o.selected ? 'selected' : ''}>${escapeHtml(o.text)}</option>`
        )
        .join('');
      selectHTML = `
        <select id="ao3-reader-chapter-select" style="max-width:40%;font-size:12px;">
          ${opts}
        </select>`;
    }

    return `
      <button id="ao3-reader-prev-chapter" data-href="${prevHref}" ${prevDisabled}>← 上一章</button>
      ${selectHTML}
      <button id="ao3-reader-next-chapter" data-href="${nextHref}" ${nextDisabled}>下一章 →</button>
    `;
  }

  function buildMenuHTML() {
    const customDisplay = settings.theme === 'custom' ? '' : 'display:none;';
    const colorVal = settings.customColor || getThemeDefaultColor();
    return `
      <div class="menu-backdrop"></div>
      <div class="menu-panel">
        <h3>阅读设置</h3>
        <div class="menu-row">
          <label>翻页方向</label>
          <select id="ao3-menu-swap">
            <option value="leftright" ${settings.swapLR === 'leftright' ? 'selected' : ''}>左右</option>
            <option value="rightleft" ${settings.swapLR === 'rightleft' ? 'selected' : ''}>右左</option>
            <option value="updown" ${settings.swapLR === 'updown' ? 'selected' : ''}>上下</option>
          </select>
        </div>
        <div class="menu-row">
          <label>字号</label>
          <div style="display:flex;align-items:center;gap:6px;">
            <button id="ao3-menu-font-down">−</button>
            <span id="ao3-menu-font-val">${settings.fontSize}</span>
            <button id="ao3-menu-font-up">+</button>
          </div>
        </div>
        <div class="menu-row">
          <label>主题</label>
          <select id="ao3-menu-theme">
            <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>浅色</option>
            <option value="sepia" ${settings.theme === 'sepia' ? 'selected' : ''}>护眼</option>
            <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>深色</option>
            <option value="custom" ${settings.theme === 'custom' ? 'selected' : ''}>自定义</option>
          </select>
        </div>
        <div class="menu-row" id="ao3-menu-color-row" style="${customDisplay}">
          <label>背景色</label>
          <input type="text" id="ao3-menu-custom-color" value="${colorVal}"
            placeholder="#f5f0e8" pattern="^#[0-9a-fA-F]{6}$"
            style="width:80px;padding:4px 6px;font-size:13px;border:1px solid #ccc;border-radius:4px;">
        </div>
        <div class="menu-row">
          <label>行高</label>
          <select id="ao3-menu-lh">
            <option value="1.5" ${settings.lineHeight === 1.5 ? 'selected' : ''}>1.5</option>
            <option value="1.8" ${settings.lineHeight === 1.8 ? 'selected' : ''}>1.8</option>
            <option value="2.0" ${settings.lineHeight === 2.0 ? 'selected' : ''}>2.0</option>
            <option value="2.2" ${settings.lineHeight === 2.2 ? 'selected' : ''}>2.2</option>
          </select>
        </div>
        <div style="font-size:14px;font-weight:bold;margin:10px 0 4px;">边距设置 (px)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div class="menu-row" style="margin:4px 0;">
            <label>上</label>
            <select id="ao3-menu-mt" style="width:60px;">
              ${[0,4,8,12,16,20,24,28,32,40].map(v => `<option value="${v}" ${(settings.marginTop || 12) === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="menu-row" style="margin:4px 0;">
            <label>下</label>
            <select id="ao3-menu-mb" style="width:60px;">
              ${[0,4,8,12,16,20,24,28,32,40].map(v => `<option value="${v}" ${(settings.marginBottom || 12) === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="menu-row" style="margin:4px 0;">
            <label>左</label>
            <select id="ao3-menu-ml" style="width:60px;">
              ${[4,8,12,16,20,24,28,32,40].map(v => `<option value="${v}" ${(settings.marginLeft || 20) === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="menu-row" style="margin:4px 0;">
            <label>右</label>
            <select id="ao3-menu-mr" style="width:60px;">
              ${[4,8,12,16,20,24,28,32,40].map(v => `<option value="${v}" ${(settings.marginRight || 20) === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="menu-section-label">跳屏翻页</div>
        <div class="menu-row">
          <label>跳屏翻页</label>
          <select id="ao3-menu-pagescroll">
            <option value="0" ${!settings.pageScroll ? 'selected' : ''}>关闭</option>
            <option value="1" ${settings.pageScroll ? 'selected' : ''}>开启</option>
          </select>
        </div>
        <div class="menu-row" id="ao3-menu-pagescroll-dir-row" style="${settings.pageScroll ? '' : 'display:none;'}">
          <label>跳屏方向</label>
          <select id="ao3-menu-pagescroll-dir">
            <option value="updown" ${settings.pageScrollDirection === 'updown' ? 'selected' : ''}>上下</option>
            <option value="leftright" ${settings.pageScrollDirection === 'leftright' ? 'selected' : ''}>左右</option>
            <option value="rightleft" ${settings.pageScrollDirection === 'rightleft' ? 'selected' : ''}>右左</option>
          </select>
        </div>
        <p style="font-size:11px;color:#999;margin:0;">点按跳屏区域跳至上/下一屏，无滚动动画</p>
        <div class="menu-row" style="margin-top:10px;">
          <label>自动进入阅读</label>
          <select id="ao3-menu-autoenter">
            <option value="0" ${!settings.autoEnterReader ? 'selected' : ''}>关闭</option>
            <option value="1" ${settings.autoEnterReader ? 'selected' : ''}>开启</option>
          </select>
        </div>
        <p style="font-size:11px;color:#999;margin:0;">开启后，进入作品页自动打开阅读模式</p>
        <button id="ao3-menu-exit" class="btn-primary">退出阅读模式</button>
      </div>
    `;
  }

  // ── Reading mode lifecycle ──────────────────────────────────────────
  function enterReadingMode() {
    if (isActive) return;

    const parsed = parseAO3Page();
    if (!parsed.hasContent) return;

    // Rebuild footer/menu with current state
    if (overlay) {
      footer.innerHTML = buildFooterHTML();
      menu.innerHTML = buildMenuHTML();
    }

    // Use window.innerHeight to avoid browser address bar overlap (Edge)
    overlay.style.height = window.innerHeight + 'px';
    overlay.style.visibility = 'hidden';
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Render paginated content with accurate viewport height
    const numPages = renderPages(parsed.contentEl);
    if (numPages === 0) {
      overlay.style.display = 'none';
      overlay.style.visibility = '';
      document.body.style.overflow = '';
      return;
    }

    applyTheme();

    // Make visible
    overlay.style.visibility = '';
    document.getElementById('ao3-reader-entry-btn').style.display = 'none';

    isActive = true;
    currentPage = 0;
    totalPages = numPages;
    updatePagePosition();
    updatePageIndicator();

    // Cache the initial chapter so that popstate back to this URL renders
    // from memory instead of re-fetching the page we just rendered.
    const initialKey = normalizeChapterUrl(window.location.href);
    if (initialKey && !chapterCache.has(initialKey)) {
      const tempContainer = document.createElement('div');
      tempContainer.appendChild(parsed.contentEl.cloneNode(true));
      chapterCache.set(initialKey, {
        tempContainer,
        chapterTitle,
        workTitle,
        chapterLinks: { ...chapterLinks },
        chapterSummary: chapterSummary ? chapterSummary.cloneNode(true) : null,
      });
    }

    unbindPageScrollEvents();
    bindReaderEvents();
  }

  function exitReadingMode() {
    if (!isActive) return;

    overlay.style.display = 'none';
    document.body.style.overflow = '';
    document.getElementById('ao3-reader-entry-btn').style.display = '';
    menu.classList.remove('show');
    hideChapterLoading();
    isActive = false;

    unbindReaderEvents();

    // Re-enable page scroll if setting is on
    if (settings.pageScroll) bindPageScrollEvents();
  }

  // ── Page scroll (regular page navigation) ───────────────────────────
  function scrollPageDown() {
    window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'instant' });
  }

  function scrollPageUp() {
    window.scrollBy({ top: -window.innerHeight * 0.9, behavior: 'instant' });
  }

  // Return 'up' | 'down' | null based on tap position and current direction setting
  function getTapScrollDir(x, y) {
    const dir = settings.pageScrollDirection;
    if (dir === 'updown') {
      return y < window.innerHeight / 2 ? 'up' : 'down';
    }
    if (dir === 'leftright') {
      if (x < window.innerWidth / 3) return 'up';
      if (x > window.innerWidth * 2 / 3) return 'down';
      return null;
    }
    // rightleft
    if (x > window.innerWidth * 2 / 3) return 'up';
    if (x < window.innerWidth / 3) return 'down';
    return null;
  }

  // Return 'up' | 'down' for a horizontal swipe
  function getSwipeScrollDir(dx) {
    if (settings.pageScrollDirection === 'rightleft') {
      return dx > 0 ? 'up' : 'down';
    }
    // updown and leftright both: right→down, left→up
    return dx > 0 ? 'down' : 'up';
  }

  function doScrollAction(dir) {
    if (dir === 'up') scrollPageUp();
    else if (dir === 'down') scrollPageDown();
  }

  function onPageScrollClick(e) {
    if (isActive) return;
    if (isInteractiveTarget(e.target)) return;
    const dir = getTapScrollDir(e.clientX, e.clientY);
    if (dir) {
      e.preventDefault();
      doScrollAction(dir);
    }
  }

  function onPageScrollTouchStart(e) {
    if (isActive) return;
    if (e.touches.length === 1) {
      psTouchStartX = e.touches[0].clientX;
      psTouchStartY = e.touches[0].clientY;
    }
  }

  function onPageScrollTouchMove(e) {
    if (isActive) return;
    const dx = e.touches[0].clientX - psTouchStartX;
    const dy = e.touches[0].clientY - psTouchStartY;
    // Block native scroll for horizontal swipes so scrollBy jump is clean
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      e.preventDefault();
    }
  }

  function onPageScrollTouchEnd(e) {
    if (isActive) return;
    if (isInteractiveTarget(e.target)) return;

    const dx = e.changedTouches[0].clientX - psTouchStartX;
    const dy = e.changedTouches[0].clientY - psTouchStartY;

    // Horizontal swipe
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      e.preventDefault();
      doScrollAction(getSwipeScrollDir(dx));
      return;
    }

    // Tap detection
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const dir = getTapScrollDir(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      if (dir) {
        e.preventDefault();
        doScrollAction(dir);
      }
    }
  }

  function onPageScrollKeyDown(e) {
    if (isActive) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      doScrollAction('up');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      doScrollAction('down');
    }
  }

  function bindPageScrollEvents() {
    if (pageScrollEventsBound) return;
    document.addEventListener('click', onPageScrollClick);
    document.addEventListener('touchstart', onPageScrollTouchStart, { passive: true });
    document.addEventListener('touchmove', onPageScrollTouchMove, { passive: false });
    document.addEventListener('touchend', onPageScrollTouchEnd);
    document.addEventListener('keydown', onPageScrollKeyDown);
    pageScrollEventsBound = true;
  }

  function unbindPageScrollEvents() {
    if (!pageScrollEventsBound) return;
    document.removeEventListener('click', onPageScrollClick);
    document.removeEventListener('touchstart', onPageScrollTouchStart);
    document.removeEventListener('touchmove', onPageScrollTouchMove);
    document.removeEventListener('touchend', onPageScrollTouchEnd);
    document.removeEventListener('keydown', onPageScrollKeyDown);
    pageScrollEventsBound = false;
  }

  // ── Pagination ──────────────────────────────────────────────────────
  function prepareContentClone(contentEl) {
    const clone = contentEl.cloneNode(true);
    clone.querySelectorAll('.landmark').forEach((el) => el.remove());
    const toast = clone.querySelector('#toast');
    if (toast) toast.remove();

    // Prepend chapter summary at the beginning
    if (chapterSummary) {
      const summaryClone = chapterSummary.cloneNode(true);
      summaryClone.classList.add('ao3-reader-chapter-summary');
      clone.insertBefore(summaryClone, clone.firstChild);
    }

    return clone;
  }

  function renderPages(contentEl) {
    const pageWidth = window.innerWidth;
    // viewport is between header and footer in flex layout
    const pageHeight = viewport.clientHeight || Math.max(200, window.innerHeight - 100);
    const padTop = settings.marginTop || 12;
    const padBottom = settings.marginBottom || 12;
    const padLeft = settings.marginLeft || 20;
    const padRight = settings.marginRight || 20;
    const contentWidth = Math.max(100, pageWidth - padLeft - padRight);
    const contentHeight = Math.max(100, pageHeight - padTop - padBottom);
    const columnGap = padLeft + padRight;

    // Native column fragmentation paginates the real laid-out text flow and
    // breaks between lines, rather than clipping the rendered content.
    const measure = document.createElement('div');
    measure.className = 'ao3-reader-page';
    measure.style.cssText = buildColumnContentStyle({
      contentWidth,
      contentHeight,
      columnGap,
      hidden: true,
    });
    measure.appendChild(prepareContentClone(contentEl));
    document.body.appendChild(measure);

    const measuredWidth = measure.scrollWidth || measure.getBoundingClientRect().width;
    const numPages = Math.max(1, Math.ceil((measuredWidth + columnGap) / pageWidth));
    document.body.removeChild(measure);

    // Cache for repaginate (so we don't re-parse the original DOM)
    cachedContentEl = contentEl;

    // Build page elements
    pagesEl.innerHTML = '';
    pagesEl.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: ${numPages * pageWidth}px;
      font-size: ${settings.fontSize}px;
      line-height: ${settings.lineHeight};
    `;

    const columnContent = document.createElement('div');
    columnContent.className = 'ao3-reader-page';
    columnContent.style.cssText = `
      ${buildColumnContentStyle({ contentWidth, contentHeight, columnGap })}
      position: absolute;
      left: ${padLeft}px;
      top: ${padTop}px;
    `;
    columnContent.appendChild(prepareContentClone(contentEl));
    pagesEl.appendChild(columnContent);

    return numPages;
  }

  function buildColumnContentStyle({ contentWidth, contentHeight, columnGap, hidden = false }) {
    return `
      ${hidden ? 'position: fixed; left: -10000px; top: 0;' : ''}
      width: ${contentWidth}px;
      height: ${contentHeight}px;
      overflow: visible;
      box-sizing: border-box;
      visibility: ${hidden ? 'hidden' : 'visible'};
      pointer-events: ${hidden ? 'none' : 'auto'};
      font-size: ${settings.fontSize}px;
      line-height: ${settings.lineHeight};
      font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Noto Serif CJK SC', Georgia, 'Times New Roman', serif;
      column-width: ${contentWidth}px;
      column-gap: ${columnGap}px;
      column-fill: auto;
      break-inside: auto;
    `;
  }

  function updatePagePosition() {
    pagesEl.style.transform = `translateX(-${currentPage * window.innerWidth}px)`;
  }

  function updatePageIndicator() {
    if (pageIndicator) {
      pageIndicator.textContent = `${currentPage + 1}/${totalPages}`;
    }
  }

  function goToPage(n) {
    if (n < 0 || n >= totalPages) return false;
    currentPage = n;
    updatePagePosition();
    updatePageIndicator();
    return true;
  }

  function goToPrevPage() {
    if (currentPage > 0) {
      currentPage--;
      updatePagePosition();
      updatePageIndicator();
      lastPageActionTime = Date.now();
    } else if (chapterLinks.prev) {
      lastPageActionTime = Date.now();
      loadChapter(chapterLinks.prev);
    }
  }

  function goToNextPage() {
    if (currentPage < totalPages - 1) {
      currentPage++;
      updatePagePosition();
      updatePageIndicator();
      lastPageActionTime = Date.now();
    } else if (chapterLinks.next) {
      lastPageActionTime = Date.now();
      loadChapter(chapterLinks.next);
    }
  }

  function repaginate() {
    if (!cachedContentEl) {
      const parsed = parseAO3Page();
      if (!parsed.hasContent) return;
      cachedContentEl = parsed.contentEl;
    }

    const savedPage = currentPage;
    const numPages = renderPages(cachedContentEl);
    totalPages = numPages;
    currentPage = Math.min(savedPage, totalPages - 1);
    updatePagePosition();
    updatePageIndicator();
  }

  function handleTap(clientX, clientY) {
    const dir = settings.swapLR;
    let action = null;

    if (dir === 'updown') {
      if (clientY < window.innerHeight * 0.4) action = 'prev';
      else if (clientY > window.innerHeight * 0.6) action = 'next';
    } else if (dir === 'leftright') {
      if (clientX < window.innerWidth / 3) action = 'prev';
      else if (clientX > window.innerWidth * 2 / 3) action = 'next';
    } else { // rightleft
      if (clientX > window.innerWidth * 2 / 3) action = 'prev';
      else if (clientX < window.innerWidth / 3) action = 'next';
    }

    if (action === 'prev') {
      goToPrevPage();
    } else if (action === 'next') {
      goToNextPage();
    } else {
      toggleMenu();
      lastPageActionTime = Date.now();
    }
  }

  // ── Theme ────────────────────────────────────────────────────────────
  function applyTheme() {
    overlay.classList.remove('theme-light', 'theme-sepia', 'theme-dark');
    overlay.classList.add('theme-' + settings.theme);

    if (settings.customColor && /^#[0-9a-fA-F]{6}$/.test(settings.customColor)) {
      overlay.style.backgroundColor = settings.customColor;
      overlay.style.setProperty('--ao3-reader-card-bg', settings.customColor);
    } else {
      overlay.style.backgroundColor = '';
      overlay.style.removeProperty('--ao3-reader-card-bg');
    }
  }

  // ── Menu ────────────────────────────────────────────────────────────
  function toggleMenu() {
    if (menu.classList.contains('show')) {
      menu.classList.remove('show');
    } else {
      // Refresh menu values
      const swapSel = document.getElementById('ao3-menu-swap');
      const fontVal = document.getElementById('ao3-menu-font-val');
      const themeSel = document.getElementById('ao3-menu-theme');
      const colorInput = document.getElementById('ao3-menu-custom-color');
      const colorRow = document.getElementById('ao3-menu-color-row');
      if (swapSel) swapSel.value = settings.swapLR;
      if (fontVal) fontVal.textContent = settings.fontSize;
      if (themeSel) themeSel.value = settings.theme;
      if (colorInput) {
        colorInput.value = settings.customColor || getThemeDefaultColor();
      }
      if (colorRow) {
        colorRow.style.display = settings.theme === 'custom' ? '' : 'none';
      }
      const lhSel = document.getElementById('ao3-menu-lh');
      if (lhSel) lhSel.value = String(settings.lineHeight);
      const mtSel = document.getElementById('ao3-menu-mt');
      if (mtSel) mtSel.value = String(settings.marginTop || 12);
      const mbSel = document.getElementById('ao3-menu-mb');
      if (mbSel) mbSel.value = String(settings.marginBottom || 12);
      const mlSel = document.getElementById('ao3-menu-ml');
      if (mlSel) mlSel.value = String(settings.marginLeft || 20);
      const mrSel = document.getElementById('ao3-menu-mr');
      if (mrSel) mrSel.value = String(settings.marginRight || 20);
      const psSel = document.getElementById('ao3-menu-pagescroll');
      if (psSel) psSel.value = settings.pageScroll ? '1' : '0';
      const psDirSel = document.getElementById('ao3-menu-pagescroll-dir');
      if (psDirSel) psDirSel.value = settings.pageScrollDirection;
      const psDirRow = document.getElementById('ao3-menu-pagescroll-dir-row');
      if (psDirRow) psDirRow.style.display = settings.pageScroll ? '' : 'none';
      const aeSel = document.getElementById('ao3-menu-autoenter');
      if (aeSel) aeSel.value = settings.autoEnterReader ? '1' : '0';
      menu.classList.add('show');
    }
  }

  function getThemeDefaultColor() {
    switch (settings.theme) {
      case 'light': return '#ffffff';
      case 'sepia': return '#f5f0e8';
      case 'dark': return '#1a1a1a';
      default: return '#f5f0e8';
    }
  }

  function bindMenuEvents() {
    // Exit button
    const exitBtn = document.getElementById('ao3-menu-exit');
    if (exitBtn) {
      exitBtn.addEventListener('click', exitReadingMode);
    }

    // Swap toggle
    const swapSel = document.getElementById('ao3-menu-swap');
    if (swapSel) {
      swapSel.addEventListener('change', function () {
        settings.swapLR = this.value;
        saveSettings();
      });
    }

    // Theme
    const themeSel = document.getElementById('ao3-menu-theme');
    const colorInput = document.getElementById('ao3-menu-custom-color');
    const colorRow = document.getElementById('ao3-menu-color-row');
    if (themeSel) {
      themeSel.addEventListener('change', function () {
        settings.theme = this.value;
        if (this.value === 'custom') {
          if (colorRow) colorRow.style.display = '';
          if (colorInput) {
            settings.customColor = colorInput.value;
          }
        } else {
          if (colorRow) colorRow.style.display = 'none';
          settings.customColor = '';
        }
        applyTheme();
        saveSettings();
      });
    }

    // Custom color input
    if (colorInput) {
      colorInput.addEventListener('input', function () {
        const val = this.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          settings.customColor = val;
          settings.theme = 'custom';
          if (themeSel) themeSel.value = 'custom';
          applyTheme();
          saveSettings();
        }
      });
    }

    // Font size
    const fontDown = document.getElementById('ao3-menu-font-down');
    const fontUp = document.getElementById('ao3-menu-font-up');
    const fontVal = document.getElementById('ao3-menu-font-val');

    if (fontDown) {
      fontDown.addEventListener('click', () => {
        if (settings.fontSize > 12) {
          settings.fontSize--;
          if (fontVal) fontVal.textContent = settings.fontSize;
          saveSettings();
          repaginate();
        }
      });
    }
    if (fontUp) {
      fontUp.addEventListener('click', () => {
        if (settings.fontSize < 28) {
          settings.fontSize++;
          if (fontVal) fontVal.textContent = settings.fontSize;
          saveSettings();
          repaginate();
        }
      });
    }

    // Line height
    const lhSel = document.getElementById('ao3-menu-lh');
    if (lhSel) {
      lhSel.addEventListener('change', function () {
        settings.lineHeight = parseFloat(this.value);
        saveSettings();
        repaginate();
      });
    }

    // Margins
    ['mt','mb','ml','mr'].forEach((key) => {
      const sel = document.getElementById('ao3-menu-' + key);
      if (!sel) return;
      sel.addEventListener('change', function () {
        const map = { mt: 'marginTop', mb: 'marginBottom', ml: 'marginLeft', mr: 'marginRight' };
        settings[map[key]] = parseInt(this.value);
        saveSettings();
        repaginate();
      });
    });

    // Page scroll toggle
    const psSel = document.getElementById('ao3-menu-pagescroll');
    const psDirRow = document.getElementById('ao3-menu-pagescroll-dir-row');
    if (psSel) {
      psSel.addEventListener('change', function () {
        settings.pageScroll = this.value === '1';
        if (psDirRow) psDirRow.style.display = this.value === '1' ? '' : 'none';
        saveSettings();
        if (!isActive) {
          if (settings.pageScroll) {
            bindPageScrollEvents();
          } else {
            unbindPageScrollEvents();
          }
        }
      });
    }

    // Page scroll direction
    const psDirSel = document.getElementById('ao3-menu-pagescroll-dir');
    if (psDirSel) {
      psDirSel.addEventListener('change', function () {
        settings.pageScrollDirection = this.value;
        saveSettings();
      });
    }

    // Auto-enter reading mode
    const aeSel = document.getElementById('ao3-menu-autoenter');
    if (aeSel) {
      aeSel.addEventListener('change', function () {
        settings.autoEnterReader = this.value === '1';
        saveSettings();
      });
    }
  }

  // ── Chapter navigation ──────────────────────────────────────────────
  function bindFooterEvents() {
    const prevBtn = document.getElementById('ao3-reader-prev-chapter');
    const nextBtn = document.getElementById('ao3-reader-next-chapter');
    const selectEl = document.getElementById('ao3-reader-chapter-select');

    if (prevBtn) {
      prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const href = prevBtn.getAttribute('data-href');
        if (href && href !== '#') {
          loadChapter(href);
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const href = nextBtn.getAttribute('data-href');
        if (href && href !== '#') {
          loadChapter(href);
        }
      });
    }

    if (selectEl && chapterLinks.select) {
      selectEl.addEventListener('change', (e) => {
        e.stopPropagation();
        const idx = parseInt(selectEl.value);
        const opt = chapterLinks.select.options[idx];
        if (opt && opt.value) {
          const workId = extractWorkId();
          if (workId) {
            loadChapter(buildChapterUrl(opt.value, workId));
          }
        }
      });
    }
  }

  function extractWorkId(url) {
    const m = (url || window.location.pathname).match(/\/works\/(\d+)/);
    return m ? m[1] : null;
  }

  // Build a chapter URL from an option value which may be:
  //   a full URL  → use as-is
  //   a path      → prepend origin
  //   a bare ID   → construct /works/{workId}/chapters/{id}
  function buildChapterUrl(optValue, workId) {
    if (/^https?:\/\//i.test(optValue)) return optValue;
    if (/^\/works\/\d+\/chapters\/\d+/.test(optValue)) {
      return window.location.origin + optValue;
    }
    return 'https://archiveofourown.org/works/' + workId + '/chapters/' + optValue;
  }

  // Strip fragment and trailing slash so that the same chapter reached via
  // different links (and the URL the browser restores on popstate) maps to
  // the same cache entry.
  function normalizeChapterUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, window.location.href);
      u.hash = '';
      let path = u.pathname;
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      u.pathname = path;
      return u.href;
    } catch {
      return url;
    }
  }

  function showChapterLoading() {
    if (!loadingEl) return;
    menu.classList.remove('show');
    // Restore loading spinner HTML (in case error state was previously shown)
    loadingEl.querySelector('.loading-card').innerHTML = `
      <div class="loading-spinner"></div>
      <div class="loading-text">章节加载中...</div>
    `;
    loadingEl.classList.remove('error');
    loadingEl.classList.add('show');
    loadingEl.setAttribute('aria-hidden', 'false');
  }

  function hideChapterLoading() {
    if (!loadingEl) return;
    loadingEl.classList.remove('show', 'error');
    loadingEl.setAttribute('aria-hidden', 'true');
  }

  function showChapterError(message) {
    if (!loadingEl) return;
    const card = loadingEl.querySelector('.loading-card');
    if (card) {
      card.innerHTML = `
        <div class="error-icon">⚠</div>
        <div class="loading-text">${escapeHtml(message)}</div>
      `;
      card.style.cursor = 'pointer';
      card.onclick = () => hideChapterLoading();
    }
    loadingEl.classList.add('show', 'error');
    loadingEl.setAttribute('aria-hidden', 'false');
    // Auto-dismiss after 4 seconds
    clearTimeout(loadingEl._errorTimer);
    loadingEl._errorTimer = setTimeout(() => hideChapterLoading(), 2500);
  }

  async function loadChapter(url, opts = {}) {
    if (isLoadingChapter) return;
    const { updateHistory = true } = opts;
    isLoadingChapter = true;

    const cacheKey = normalizeChapterUrl(url);
    const cached = cacheKey ? chapterCache.get(cacheKey) : null;

    if (cached) {
      // Render from cache — no network request needed (e.g. browser back)
      applyChapterData(cached, url, { updateHistory });
      isLoadingChapter = false;
      hideChapterLoading();
      return;
    }

    showChapterLoading();

    // Fetch the chapter page
    let html;
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      html = await resp.text();
    } catch (err) {
      isLoadingChapter = false;
      const statusMatch = err.message.match(/HTTP (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      if (status === 403 || status === 503) {
        showChapterError('AO3 正在验证浏览器身份，请等待片刻后重试');
      } else {
        showChapterError('章节加载失败，请检查网络后重试');
      }
      return;
    }

    // Detect Cloudflare challenge in response HTML
    if (html.includes('cf-browser-verify') || html.includes('Just a moment') || html.includes('_cf_chl_opt')) {
      isLoadingChapter = false;
      showChapterError('AO3 正在验证浏览器身份，请等待片刻后重试');
      return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Extract body content — same filtering as parseAO3Page
    const allUserstuff = doc.querySelectorAll('#chapters .userstuff');
    let userstuff = null;
    for (const el of allUserstuff) {
      if (!el.closest('.summary') && !el.closest('.notes') && el.tagName !== 'BLOCKQUOTE') {
        userstuff = el;
        break;
      }
    }
    if (!userstuff && allUserstuff.length > 0) userstuff = allUserstuff[0];
    if (!userstuff) {
      isLoadingChapter = false;
      showChapterError('章节内容解析失败，该页面可能不是有效的AO3章节页面');
      return;
    }

    // Extract metadata
    const titleEl = doc.querySelector('h2.title.heading');
    workTitle = titleEl ? titleEl.textContent.trim() : workTitle;

    const chapterTitleEl =
      doc.querySelector('#chapters h3.title') ||
      doc.querySelector('.chapter .title');
    chapterTitle = chapterTitleEl
      ? chapterTitleEl.textContent.trim()
      : workTitle;

    const authorEl = doc.querySelector('h3.byline a[rel="author"]');
    if (authorEl) {
      chapterTitle = workTitle + ' - ' + authorEl.textContent.trim();
    }

    // Get chapter summary from fetched page
    const summaryBlock = doc.querySelector('.preface .summary blockquote.userstuff')
      || doc.querySelector('.chapter.preface .summary blockquote.userstuff');
    // Import node from parsed document into current document
    chapterSummary = summaryBlock ? document.importNode(summaryBlock, true) : null;

    // Chapter navigation
    const prevLink = doc.querySelector('li.chapter.previous a');
    const nextLink = doc.querySelector('li.chapter.next a');
    chapterLinks.prev = prevLink ? prevLink.href : null;
    chapterLinks.next = nextLink ? nextLink.href : null;

    const chapterSelect = doc.querySelector('#selected_id');
    if (chapterSelect && chapterSelect.tagName === 'SELECT') {
      chapterLinks.select = {
        options: [...chapterSelect.options].map((opt) => ({
          value: opt.value,
          text: opt.textContent.trim(),
          selected: opt.selected,
        })),
        currentIndex: chapterSelect.selectedIndex,
        onChange: chapterSelect.getAttribute('onchange'),
      };
    } else {
      chapterLinks.select = null;
    }

    // Re-paginate with new content (userstuff is from the parsed doc, but we need
    // to measure it in the live DOM — clone it into a temporary container)
    const tempContainer = document.createElement('div');
    while (userstuff.firstChild) {
      tempContainer.appendChild(userstuff.firstChild);
    }

    const data = {
      tempContainer,
      chapterTitle,
      workTitle,
      chapterLinks: { ...chapterLinks },
      chapterSummary: chapterSummary ? chapterSummary.cloneNode(true) : null,
    };
    applyChapterData(data, url, { updateHistory });

    if (cacheKey) chapterCache.set(cacheKey, data);

    isLoadingChapter = false;
    hideChapterLoading();
  }

  // Render an already-parsed chapter payload (either freshly fetched or pulled
  // from the history cache). Handles UI update, pagination and history.
  function applyChapterData(data, url, opts = {}) {
    const { updateHistory = true } = opts;
    chapterTitle = data.chapterTitle;
    workTitle = data.workTitle;
    chapterLinks = { ...data.chapterLinks };
    chapterSummary = data.chapterSummary;

    const titleSpan = header.querySelector('.chapter-title');
    if (titleSpan) titleSpan.textContent = chapterTitle;

    const numPages = renderPages(data.tempContainer);
    totalPages = numPages;
    currentPage = 0;
    updatePagePosition();
    updatePageIndicator();

    footer.innerHTML = buildFooterHTML();
    bindFooterEvents();

    if (updateHistory) {
      history.pushState({ ao3Reader: true }, '', url);
    }
  }

  // ── Event handling ──────────────────────────────────────────────────
  function isInteractiveTarget(el) {
    return el.closest('a, button, select, input, textarea, [role="button"]');
  }

  function onViewportClick(e) {
    if (isInteractiveTarget(e.target)) return;
    // Suppress click if a touch event already triggered a page action
    // (mobile browsers fire both touchend and click for the same tap)
    if (Date.now() - lastPageActionTime < 500) return;
    e.preventDefault();
    handleTap(e.clientX, e.clientY);
  }

  function onViewportTouchStart(e) {
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
  }

  function onViewportTouchEnd(e) {
    if (menu.classList.contains('show')) return;
    if (isInteractiveTarget(e.target)) return;

    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;

    // Swipe detection
    const rd = settings.swapLR;
    if (rd === 'updown') {
      // Vertical swipe
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
        e.preventDefault();
        if (dy > 0) goToNextPage();
        else goToPrevPage();
        return;
      }
    } else {
      // Horizontal swipe
      const reversed = rd === 'rightleft';
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
        e.preventDefault();
        if (dx > 0) reversed ? goToPrevPage() : goToNextPage();
        else reversed ? goToNextPage() : goToPrevPage();
        return;
      }
    }

    // Tap detection (minimal movement)
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      handleTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
  }

  function onKeyDown(e) {
    if (menu.classList.contains('show')) {
      if (e.key === 'Escape') toggleMenu();
      return;
    }
    if (e.key === 'ArrowLeft') {
      if (settings.swapLR === 'rightleft') goToNextPage();
      else goToPrevPage();
    } else if (e.key === 'ArrowRight') {
      if (settings.swapLR === 'rightleft') goToPrevPage();
      else goToNextPage();
    } else if (e.key === 'Escape') {
      exitReadingMode();
    }
  }

  function onResize() {
    if (!isActive) return;
    overlay.style.height = window.innerHeight + 'px';
    repaginate();
  }

  function onPopState() {
    if (!isActive) return;
    loadChapter(window.location.href, { updateHistory: false });
  }

  function onMenuBackdropClick(e) {
    if (e.target.classList.contains('menu-backdrop')) {
      toggleMenu();
    }
  }

  function bindReaderEvents() {
    if (readerEventsBound) return;

    viewport.addEventListener('click', onViewportClick);
    viewport.addEventListener('touchstart', onViewportTouchStart, {
      passive: true,
    });
    viewport.addEventListener('touchend', onViewportTouchEnd);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    window.addEventListener('popstate', onPopState);
    menu.addEventListener('click', onMenuBackdropClick);

    // Header exit button
    const exitBtn = document.getElementById('ao3-reader-btn-exit');
    if (exitBtn) {
      exitBtn.addEventListener('click', exitReadingMode);
    }

    bindMenuEvents();
    bindFooterEvents();

    readerEventsBound = true;
  }

  function unbindReaderEvents() {
    if (!readerEventsBound) return;

    viewport.removeEventListener('click', onViewportClick);
    viewport.removeEventListener('touchstart', onViewportTouchStart);
    viewport.removeEventListener('touchend', onViewportTouchEnd);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('popstate', onPopState);
    menu.removeEventListener('click', onMenuBackdropClick);

    const exitBtn = document.getElementById('ao3-reader-btn-exit');
    if (exitBtn) {
      exitBtn.removeEventListener('click', exitReadingMode);
    }

    readerEventsBound = false;
  }

  // ── Message handling (from popup) ───────────────────────────────────
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === 'toggleReader') {
        if (isActive) {
          exitReadingMode();
        } else {
          enterReadingMode();
        }
        sendResponse({ active: isActive });
      } else if (msg.action === 'getStatus') {
        sendResponse({ active: isActive });
      }
    });
  }

  // ── Utils ───────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Init ────────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();

    // Page scroll works on all matched pages (works, search, etc.)
    if (settings.pageScroll) bindPageScrollEvents();

    // Check if we're on a work page with content
    const parsed = parseAO3Page();
    if (!parsed.hasContent) return;

    createReaderUI();
    setupMessageListener();

    if (settings.autoEnterReader) {
      enterReadingMode();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
