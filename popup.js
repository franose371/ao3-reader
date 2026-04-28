const defaults = {
  swapLR: false, fontSize: 18, theme: 'light',
  lineHeight: 1.8, customColor: '',
  marginTop: 12, marginBottom: 12,
  marginLeft: 20, marginRight: 20
};

function $(id) { return document.getElementById(id); }

function loadSettings() {
  chrome.storage.sync.get('ao3ReaderSettings', (data) => {
    const s = data.ao3ReaderSettings || defaults;
    $('swapLR').value = s.swapLR ? '1' : '0';
    $('fontSizeVal').textContent = s.fontSize;
    $('lineHeight').value = String(s.lineHeight);
    $('theme').value = s.theme || 'sepia';
    $('customColor').value = s.customColor || '';
    $('colorRow').style.display = s.theme === 'custom' ? '' : 'none';
    $('marginTop').value = String(s.marginTop || 12);
    $('marginBottom').value = String(s.marginBottom || 12);
    $('marginLeft').value = String(s.marginLeft || 20);
    $('marginRight').value = String(s.marginRight || 20);
  });
}

$('theme').addEventListener('change', function () {
  $('colorRow').style.display = this.value === 'custom' ? '' : 'none';
});

$('customColor').addEventListener('input', function () {
  const val = this.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    $('theme').value = 'custom';
    $('colorRow').style.display = '';
  }
});

function saveSettings() {
  chrome.storage.sync.set({
    ao3ReaderSettings: {
      swapLR: $('swapLR').value === '1',
      fontSize: parseInt($('fontSizeVal').textContent),
      lineHeight: parseFloat($('lineHeight').value),
      theme: $('theme').value,
      customColor: $('theme').value === 'custom' ? $('customColor').value.trim() : '',
      marginTop: parseInt($('marginTop').value),
      marginBottom: parseInt($('marginBottom').value),
      marginLeft: parseInt($('marginLeft').value),
      marginRight: parseInt($('marginRight').value)
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
