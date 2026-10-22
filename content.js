const userSelectors = [
  'input[type="text"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[name*="email" i]',
  'input[autocomplete="username"]'
];
const passSelectors = [
  'input[type="password"]',
  'input[autocomplete="current-password"]'
];

function findInput(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function fill(user, pass) {
  const u = findInput(userSelectors);
  const p = findInput(passSelectors);
  const fire = (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (u) fire(u, user);
  if (p) fire(p, pass);
  return !!(u || p);
}

function detect() {
  const u = findInput(userSelectors);
  return { username: u?.value?.trim() || '', url: location.href };
}

const recentlySent = new Map();
const CAPTURE_COOLDOWN = 30000;

function looksLikeSubmit(btn) {
  if (!btn) return false;
  if (btn.type === 'submit') return true;
  if (btn.closest('form')?.querySelector('input[type="password"]')) return true;
  const text = ((btn.textContent || '') + ' ' + (btn.value || '')).toLowerCase().trim();
  const patterns = [
    'sign in', 'signin', 'login', 'log in', 'logon',
    'войти', 'вход', 'submit', 'continue', 'далее', 'next'
  ];
  return patterns.some(p => text.includes(p));
}

async function sendCaptured(user, pass) {
  if (!pass) return;
  const site = location.hostname.replace(/^www\./, '');
  const dedupKey = site + '|' + user + '|' + pass;
  const now = Date.now();
  if (recentlySent.has(dedupKey) && now - recentlySent.get(dedupKey) < CAPTURE_COOLDOWN) return;
  recentlySent.set(dedupKey, now);

  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'pendingSave',
      site, url: location.href, user, pass
    });
    if (resp?.id && !resp.dup) showSaveBanner(resp.id, site, user);
  } catch {}
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('button, [role="button"], input[type="submit"]');
  if (!btn) return;
  const passField = findInput(passSelectors);
  if (!passField || !passField.value) return;
  if (!looksLikeSubmit(btn)) return;

  const user = findInput(userSelectors)?.value?.trim() || '';
  const pass = passField.value;
  setTimeout(() => sendCaptured(user, pass), 0);
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!e.target?.matches?.('input[type="password"]')) return;
  const pass = e.target.value;
  const user = findInput(userSelectors)?.value?.trim() || '';
  setTimeout(() => sendCaptured(user, pass), 0);
}, true);

document.addEventListener('submit', (e) => {
  if (!e.target?.querySelector?.('input[type="password"]')) return;
  const p = e.target.querySelector('input[type="password"]');
  const u = e.target.querySelector('input[type="text"], input[type="email"]');
  setTimeout(() => sendCaptured(u?.value?.trim() || '', p?.value || ''), 0);
}, true);

const BANNER_ID = '__helium_pm_banner__';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function showSaveBanner(id, site, user) {
  if (document.getElementById(BANNER_ID)) return;

  const host = document.createElement('div');
  host.id = BANNER_ID;
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      .b {
        background:#0f172a; color:#f8fafc; padding:14px 16px;
        border-radius:12px; font:13px/1.4 system-ui, sans-serif;
        box-shadow:0 12px 32px rgba(0,0,0,.4);
        border:1px solid #334155; width:290px;
      }
      .b h4 { margin:0 0 6px; font-size:14px; font-weight:600; }
      .b p { margin:0 0 12px; font-size:12px; color:#94a3b8;
             overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .b .row { display:flex; gap:8px; }
      .b button {
        padding:8px 12px; font-size:12px; border-radius:8px;
        border:none; cursor:pointer; font-weight:500; font-family:inherit;
      }
      .b .save {
        background:linear-gradient(135deg,#2563eb,#7c3aed); color:#fff; flex:1;
      }
      .b .save:hover { opacity:.9; }
      .b .skip { background:#1e293b; color:#e2e8f0; }
      .b .skip:hover { background:#334155; }
      .b .ok { color:#4ade80; font-weight:600; padding:4px 0; font-size:13px; }
    </style>
    <div class="b">
      <h4>🔐 Сохранить пароль?</h4>
      <p>${escapeHtml(site)} — ${escapeHtml(user || 'без логина')}</p>
      <div class="row">
        <button class="save">Сохранить</button>
        <button class="skip">Не сейчас</button>
      </div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const remove = () => host.remove();
  const box = shadow.querySelector('.b');

  shadow.querySelector('.save').onclick = async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'confirmPending', id });
      if (resp?.ok) {
        box.innerHTML = '<p class="ok">Сохранено ✓</p>';
      } else if (resp?.error === 'locked') {
        box.innerHTML = '<p class="ok">Откройте Helium, чтобы сохранить</p>';
      } else {
        box.innerHTML = '<p class="ok">Ошибка сохранения</p>';
      }
    } catch {
      box.innerHTML = '<p class="ok">Ошибка</p>';
    }
    setTimeout(remove, 1800);
  };

  shadow.querySelector('.skip').onclick = async () => {
    try { await chrome.runtime.sendMessage({ action: 'removePending', id }); } catch {}
    remove();
  };

  setTimeout(remove, 25000);
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'fill') {
    sendResponse({ success: fill(req.user, req.pass) });
    return true;
  }
  if (req.action === 'detect') {
    sendResponse(detect());
    return true;
  }
});