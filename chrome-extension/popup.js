const defaults = {
  swapLR: 'leftright', fontSize: 18, theme: 'light',
  lineHeight: 1.8, customColor: '', customTextColor: '',
  marginTop: 12, marginBottom: 12,
  marginLeft: 20, marginRight: 20,
  pageScroll: false,
  autoEnterReader: false
};

function $(id) { return document.getElementById(id); }

function loadSettings() {
  chrome.storage.sync.get('ao3ReaderSettings', (data) => {
    const s = data.ao3ReaderSettings || defaults;
    $('swapLR').value = (typeof s.swapLR === 'boolean') ? (s.swapLR ? 'rightleft' : 'leftright') : (s.swapLR || 'leftright');
    $('fontSizeVal').textContent = s.fontSize;
    $('lineHeight').value = String(s.lineHeight);
    $('theme').value = s.theme || 'sepia';
    $('customColor').value = s.customColor || '';
    $('colorRow').style.display = s.theme === 'custom' ? '' : 'none';
    $('colorSwatch').style.background = s.customColor || '#f5f0e8';
    $('customTextColor').value = s.customTextColor || '';
    $('textColorRow').style.display = s.theme === 'custom' ? '' : 'none';
    $('textColorSwatch').style.background = s.customTextColor || '#1a1a1a';
    $('marginTop').value = String(s.marginTop || 12);
    $('marginBottom').value = String(s.marginBottom || 12);
    $('marginLeft').value = String(s.marginLeft || 20);
    $('marginRight').value = String(s.marginRight || 20);
    $('pageScroll').value = s.pageScroll ? '1' : '0';
    $('autoEnterReader').value = s.autoEnterReader ? '1' : '0';
  });
}

$('theme').addEventListener('change', function () {
  const isCustom = this.value === 'custom';
  $('colorRow').style.display = isCustom ? '' : 'none';
  $('textColorRow').style.display = isCustom ? '' : 'none';
});

$('customColor').addEventListener('input', function () {
  const val = this.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    $('colorSwatch').style.background = val;
    $('theme').value = 'custom';
    $('colorRow').style.display = '';
    $('textColorRow').style.display = '';
  }
});

$('customTextColor').addEventListener('input', function () {
  const val = this.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    $('textColorSwatch').style.background = val;
    $('theme').value = 'custom';
    $('colorRow').style.display = '';
    $('textColorRow').style.display = '';
  }
});

function saveSettings() {
  const isCustom = $('theme').value === 'custom';
  chrome.storage.sync.set({
    ao3ReaderSettings: {
      swapLR: $('swapLR').value,
      fontSize: parseInt($('fontSizeVal').textContent),
      lineHeight: parseFloat($('lineHeight').value),
      theme: $('theme').value,
      customColor: isCustom ? $('customColor').value.trim() : '',
      customTextColor: isCustom ? $('customTextColor').value.trim() : '',
      marginTop: parseInt($('marginTop').value),
      marginBottom: parseInt($('marginBottom').value),
      marginLeft: parseInt($('marginLeft').value),
      marginRight: parseInt($('marginRight').value),
      pageScroll: $('pageScroll').value === '1',
      autoEnterReader: $('autoEnterReader').value === '1'
    }
  }, () => {
    const btn = $('saveBtn');
    btn.textContent = '已保存 ✓';
    setTimeout(() => { btn.textContent = '保存设置'; }, 1500);
  });
}

$('fontSizeUp').addEventListener('click', () => {
  let val = parseInt($('fontSizeVal').textContent);
  if (val < 28) { val += 1; $('fontSizeVal').textContent = val; }
});

$('fontSizeDown').addEventListener('click', () => {
  let val = parseInt($('fontSizeVal').textContent);
  if (val > 12) { val -= 1; $('fontSizeVal').textContent = val; }
});

$('saveBtn').addEventListener('click', saveSettings);
document.addEventListener('DOMContentLoaded', loadSettings);
