// AO3 Reader - Content Script
(function () {
  'use strict';

  // ── Default settings ────────────────────────────────────────────────
  const DEFAULTS = {
    swapLR: false,
    fontSize: 18,
    theme: 'sepia',
    lineHeight: 1.8,
  };

  // ── State ───────────────────────────────────────────────────────────
  let settings = { ...DEFAULTS };
  let currentPage = 0;
  let totalPages = 1;
  let chapterLinks = { prev: null, next: null, select: null };
  let chapterTitle = '';
  let workTitle = '';
  let isActive = false;
  let readerEventsBound = false;
  let touchStartX = 0;
  let touchStartY = 0;

  // DOM refs (populated when reader is created)
  let overlay, header, viewport, pagesEl, footer, menu, pageIndicator;

  // ── Settings ────────────────────────────────────────────────────────
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('ao3ReaderSettings', (data) => {
        if (data.ao3ReaderSettings) {
          settings = { ...DEFAULTS, ...data.ao3ReaderSettings };
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

    // Get the userstuff content
    const userstuff = document.querySelector('#chapters .userstuff');
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

    overlay.appendChild(header);
    overlay.appendChild(viewport);
    overlay.appendChild(footer);
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
    return `
      <div class="menu-panel">
        <h3>阅读设置</h3>
        <div class="menu-row">
          <label>翻页方向</label>
          <select id="ao3-menu-swap">
            <option value="0" ${!settings.swapLR ? 'selected' : ''}>左=上页, 右=下页</option>
            <option value="1" ${settings.swapLR ? 'selected' : ''}>左=下页, 右=上页</option>
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
          </select>
        </div>
        <button id="ao3-menu-exit" class="btn-primary">退出阅读模式</button>
      </div>
    `;
  }

  // ── Reading mode lifecycle ──────────────────────────────────────────
  function enterReadingMode() {
    if (isActive) return;

    const parsed = parseAO3Page();
    if (!parsed.hasContent) return;

    // Rebuild reader UI with fresh content
    if (overlay) {
      footer.innerHTML = buildFooterHTML();
      menu.innerHTML = buildMenuHTML();
    }

    // Paginate content into pages
    const pageArrays = paginateContent(parsed.contentEl);
    if (pageArrays.length === 0) return;

    // Render pages
    renderPages(pageArrays);

    // Apply theme
    overlay.className = 'theme-' + settings.theme;

    // Show overlay
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.getElementById('ao3-reader-entry-btn').style.display = 'none';

    isActive = true;
    currentPage = 0;
    totalPages = pageArrays.length;
    updatePagePosition();
    updatePageIndicator();

    bindReaderEvents();
  }

  function exitReadingMode() {
    if (!isActive) return;

    overlay.style.display = 'none';
    document.body.style.overflow = '';
    document.getElementById('ao3-reader-entry-btn').style.display = '';
    menu.classList.remove('show');
    isActive = false;

    unbindReaderEvents();
  }

  // ── Pagination ──────────────────────────────────────────────────────
  function getAvailableHeight() {
    const headerH = header ? header.offsetHeight : 40;
    const footerH = footer ? footer.offsetHeight : 40;
    return window.innerHeight - headerH - footerH - 24;
  }

  function paginateContent(contentEl) {
    const pageWidth = window.innerWidth - 40; // 20px padding each side
    const pageHeight = getAvailableHeight();

    // Create hidden measurement container
    const measure = document.createElement('div');
    measure.style.cssText = `
      position: fixed;
      left: -9999px;
      top: 0;
      width: ${pageWidth}px;
      visibility: hidden;
      font-size: ${settings.fontSize}px;
      line-height: ${settings.lineHeight};
      font-family: 'Noto Serif SC', 'Source Han Serif SC', Georgia, 'Times New Roman', serif;
    `;
    document.body.appendChild(measure);

    const children = [...contentEl.children];
    const pages = [];
    let currentPageItems = [];
    let currentHeight = 0;

    for (const child of children) {
      // Skip empty/non-content elements
      const tag = child.tagName ? child.tagName.toLowerCase() : '';
      if (tag === 'h3' && child.className && child.className.includes('landmark')) continue;
      if (child.classList && child.classList.contains('landmark')) continue;
      if (child.id === 'toast') continue;

      const clone = child.cloneNode(true);
      measure.appendChild(clone);
      const h = clone.getBoundingClientRect().height;
      measure.removeChild(clone);

      // If this element alone is taller than a page, include it anyway (page will scroll)
      if (currentHeight + h > pageHeight && currentPageItems.length > 0) {
        pages.push(currentPageItems);
        currentPageItems = [];
        currentHeight = 0;
      }

      currentPageItems.push(child);
      currentHeight += h;
    }

    if (currentPageItems.length > 0) {
      pages.push(currentPageItems);
    }

    document.body.removeChild(measure);
    return pages;
  }

  function renderPages(pageArrays) {
    pagesEl.innerHTML = '';
    pagesEl.style.display = 'flex';
    pagesEl.style.flexWrap = 'nowrap';
    pagesEl.style.position = 'absolute';
    pagesEl.style.top = '0';
    pagesEl.style.left = '0';
    pagesEl.style.height = '100%';
    pagesEl.style.transition = 'transform 0.25s ease-out';
    pagesEl.style.columnWidth = '';
    pagesEl.style.fontSize = settings.fontSize + 'px';
    pagesEl.style.lineHeight = settings.lineHeight;

    const pageWidth = window.innerWidth;
    const pageHeight = viewport.clientHeight;

    for (const items of pageArrays) {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'ao3-reader-page';
      pageDiv.style.cssText = `
        width: ${pageWidth}px;
        height: ${pageHeight}px;
        overflow-y: auto;
        padding: 12px 20px;
        box-sizing: border-box;
        flex-shrink: 0;
      `;

      for (const el of items) {
        pageDiv.appendChild(el.cloneNode(true));
      }

      pagesEl.appendChild(pageDiv);
    }
  }

  function updatePagination() {
    totalPages = pagesEl.children.length;
    if (currentPage >= totalPages) {
      currentPage = Math.max(0, totalPages - 1);
    }
    updatePagePosition();
    updatePageIndicator();
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
    } else if (chapterLinks.prev) {
      // At first page, go to previous chapter
      exitReadingMode();
      window.location.href = chapterLinks.prev;
    }
  }

  function goToNextPage() {
    if (currentPage < totalPages - 1) {
      currentPage++;
      updatePagePosition();
      updatePageIndicator();
    } else if (chapterLinks.next) {
      // At last page, go to next chapter
      exitReadingMode();
      window.location.href = chapterLinks.next;
    }
  }

  function repaginate() {
    // Re-extract content and re-paginate (for font size changes)
    const parsed = parseAO3Page();
    if (!parsed.hasContent) return;

    const savedPage = currentPage;
    const pageArrays = paginateContent(parsed.contentEl);
    renderPages(pageArrays);
    totalPages = pageArrays.length;
    currentPage = Math.min(savedPage, totalPages - 1);
    updatePagePosition();
    updatePageIndicator();
  }

  function handleTap(clientX) {
    const vw = window.innerWidth;
    const third = vw / 3;

    if (clientX < third) {
      // Left zone
      settings.swapLR ? goToNextPage() : goToPrevPage();
    } else if (clientX > third * 2) {
      // Right zone
      settings.swapLR ? goToPrevPage() : goToNextPage();
    } else {
      // Middle zone - toggle menu
      toggleMenu();
    }
  }

  // ── Font settings ───────────────────────────────────────────────────
  function applyFontSettings() {
    // Update all page divs with current font settings
    const pageDivs = pagesEl.querySelectorAll('.ao3-reader-page');
    pageDivs.forEach((div) => {
      div.style.fontSize = settings.fontSize + 'px';
      div.style.lineHeight = settings.lineHeight;
    });
    pagesEl.style.fontSize = settings.fontSize + 'px';
    pagesEl.style.lineHeight = settings.lineHeight;
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
      if (swapSel) swapSel.value = settings.swapLR ? '1' : '0';
      if (fontVal) fontVal.textContent = settings.fontSize;
      if (themeSel) themeSel.value = settings.theme;
      menu.classList.add('show');
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
        settings.swapLR = this.value === '1';
        saveSettings();
      });
    }

    // Theme
    const themeSel = document.getElementById('ao3-menu-theme');
    if (themeSel) {
      themeSel.addEventListener('change', function () {
        settings.theme = this.value;
        overlay.className = 'theme-' + settings.theme;
        saveSettings();
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
          exitReadingMode();
          window.location.href = href;
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const href = nextBtn.getAttribute('data-href');
        if (href && href !== '#') {
          exitReadingMode();
          window.location.href = href;
        }
      });
    }

    if (selectEl && chapterLinks.select) {
      selectEl.addEventListener('change', (e) => {
        e.stopPropagation();
        const idx = parseInt(selectEl.value);
        const opt = chapterLinks.select.options[idx];
        if (opt) {
          const url = new URL(window.location.href);
          url.searchParams.set('view_single', '1'); // avoid ?view_full_work
          // AO3 chapter select uses the chapter ID from the option value
          const workId = extractWorkId();
          if (workId) {
            exitReadingMode();
            window.location.href =
              'https://archiveofourown.org/works/' +
              workId +
              '/chapters/' +
              opt.value;
          }
        }
      });
    }
  }

  function extractWorkId() {
    const m = window.location.pathname.match(/\/works\/(\d+)/);
    return m ? m[1] : null;
  }

  // ── Event handling ──────────────────────────────────────────────────
  function isInteractiveTarget(el) {
    return el.closest('a, button, select, input, textarea, [role="button"]');
  }

  function onViewportClick(e) {
    if (isInteractiveTarget(e.target)) return;
    e.preventDefault();
    handleTap(e.clientX);
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
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      e.preventDefault();
      if (dx > 0) {
        settings.swapLR ? goToNextPage() : goToPrevPage();
      } else {
        settings.swapLR ? goToPrevPage() : goToNextPage();
      }
      return;
    }

    // Tap detection (minimal movement)
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      handleTap(e.changedTouches[0].clientX);
    }
  }

  function onKeyDown(e) {
    if (menu.classList.contains('show')) {
      if (e.key === 'Escape') toggleMenu();
      return;
    }
    if (e.key === 'ArrowLeft') {
      settings.swapLR ? goToNextPage() : goToPrevPage();
    } else if (e.key === 'ArrowRight') {
      settings.swapLR ? goToPrevPage() : goToNextPage();
    } else if (e.key === 'Escape') {
      exitReadingMode();
    }
  }

  function onResize() {
    if (!isActive) return;
    repaginate();
  }

  function onMenuBackdropClick(e) {
    if (e.target === menu) {
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

    // Check if we're on a work page with content
    const parsed = parseAO3Page();
    if (!parsed.hasContent) return;

    createReaderUI();
    setupMessageListener();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
