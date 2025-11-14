// Shared helpers (Backpack connect + fetch)
export async function fetchJSON(url, opts) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

// Runtime config (rpc, network)
let __cfg;
let __provider; // last connected Backpack provider
let __walletPopover;
let __walletMenu;
let __hoverTimer;
export async function getConfig() {
  if (__cfg) return __cfg;
  try {
    __cfg = await fetchJSON('/api/config');
  } catch {
    __cfg = { rpc: 'https://rpc.testnet.carv.io/rpc', network: 'carv-testnet' };
  }
  return __cfg;
}

export async function txExplorerUrl(sig) {
  if (!sig) return '#';
  const { rpc } = await getConfig();
  const base = 'https://solscan.io/tx/' + encodeURIComponent(sig);
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
}

// Set image source with robust fallback
export function setImgSrc(img, src, fallback = '/polos.jpg') {
  if (!img) return;
  const urls = [];
  const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };

  // Build a resilient IPFS gateway list
  const addIpfs = (pathish) => {
    const p = pathish.replace(/^\/+/, '');
    push(`https://gateway.pinata.cloud/ipfs/${p}`);
    push(`https://ipfs.io/ipfs/${p}`);
    push(`https://cloudflare-ipfs.com/ipfs/${p}`);
  };

  if (src) {
    try {
      if (src.startsWith('ipfs://')) {
        addIpfs(src.replace('ipfs://', ''));
      } else if (/https?:\/\/[^\s]+\/ipfs\//i.test(src)) {
        const m = src.match(/\/ipfs\/(.+)$/i);
        if (m && m[1]) addIpfs(m[1]);
        push(src);
      } else {
        push(src);
      }
    } catch { push(src); }
  }
  push(fallback);

  let i = 0;
  const tryNext = () => {
    if (i >= urls.length) return;
    const u = urls[i++];
    // Set once per attempt; subsequent errors advance to next URL
    img.onerror = tryNext;
    img.src = u;
  };
  tryNext();
}

// Lightweight site updates renderer
// Usage: renderUpdates('#updatesWrap', { limit: 3 })
export async function renderUpdates(target, { limit = 3 } = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  el.innerHTML = '<div class="skeleton text"></div>';
  try {
    const updates = await fetch('/updates.json', { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);
    if (!Array.isArray(updates) || updates.length === 0) {
      el.innerHTML = '<div class="muted">No updates yet.</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'updates-list';
    updates
      .sort((a, b) => (Number(b.ts||0) - Number(a.ts||0)))
      .slice(0, limit)
      .forEach((u) => {
        const row = document.createElement('div');
        row.className = 'update-item';
        const date = u.ts ? new Date(Number(u.ts) * 1000) : null;
        const when = date ? date.toLocaleString() : '';
        const title = (u.title || 'Update');
        const body = (u.body || '');
        const link = (u.url || null);
        row.innerHTML = `
          <div class="row between">
            <strong>${title}</strong>
            <span class="small muted">${when}</span>
          </div>
          <div class="small mt">${body}</div>
          ${link ? `<div class="mt"><a class="btn btn-ghost" href="${link}" target="_blank" rel="noopener">Learn more</a></div>` : ''}
        `;
        list.appendChild(row);
      });
    el.innerHTML = '';
    el.appendChild(list);
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="muted">Failed to load updates</div>';
  }
}

// Collapsible helper with height animation and ARIA wiring
// Usage: setupCollapsible({ button: '#updatesToggle', panel: '#updatesPanel', open: false, onToggle })
export function setupCollapsible({ button, panel, open = false, onToggle } = {}) {
  const btn = typeof button === 'string' ? document.querySelector(button) : button;
  const el = typeof panel === 'string' ? document.querySelector(panel) : panel;
  if (!btn || !el) return () => {};
  let isOpen = !!open;
  const setAria = () => {
    btn.setAttribute('aria-expanded', String(isOpen));
    btn.textContent = isOpen ? 'Hide' : 'Show';
  };
  const openAnim = () => { el.classList.add('open'); };
  const closeAnim = () => { el.classList.remove('open'); };
  const toggle = () => {
    isOpen = !isOpen;
    if (isOpen) openAnim(); else closeAnim();
    setAria();
    if (typeof onToggle === 'function') onToggle(isOpen);
  };
  // initial state
  el.classList.remove('open');
  setAria();
  btn.addEventListener('click', toggle);
  return toggle;
}

// Robust confirmation polling to avoid 30s SDK timeout
export async function waitForConfirmation(connection, signature, { timeoutMs = 90000, desired = 'confirmed' } = {}) {
  const start = Date.now();
  const ok = (st) => {
    if (!st) return false;
    if (st.err) throw new Error('Transaction failed');
    const cs = st.confirmationStatus || (st.confirmations === 0 ? 'finalized' : null);
    return cs === 'finalized' || (desired === 'confirmed' && cs === 'confirmed');
  };
  while (Date.now() - start < timeoutMs) {
    const r = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = r.value?.[0];
    if (ok(st)) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('Confirmation timed out');
}

// Send and track using onSignature with fallback polling
export async function sendAndTrack(connection, rawTx, { commitment = 'confirmed', timeoutMs = 120000 } = {}) {
  const sig = await connection.sendRawTransaction(rawTx, { maxRetries: 20, preflightCommitment: commitment });
  let subId;
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (subId != null) connection.removeSignatureListener(subId).catch(() => {});
        resolve(null);
      }, timeoutMs);
      connection.onSignature(sig, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (res?.err) reject(new Error('Transaction failed'));
        else resolve(true);
      }, commitment).then((id) => { subId = id; }).catch(() => {});
    });
  } catch (e) {
    // fall through; we'll still return signature
  }
  return sig;
}

// Highlight the current nav link based on location
function setActiveNav() {
  try {
    const path = window.location.pathname || '/';
    // Map path prefixes to nav hrefs
    const routes = [
      { prefix: '/deploy', href: '/deploy' },
      { prefix: '/mint', href: '/mint' },
      { prefix: '/market', href: '/market' },
      { prefix: '/', href: '/' },
    ];
    let target = '/';
    if (path !== '/') {
      for (const r of routes) { if (r.prefix !== '/' && path.startsWith(r.prefix)) { target = r.href; break; } }
    }
    const links = document.querySelectorAll('.nav .nav-link');
    links.forEach((a) => a.classList.remove('active'));
    links.forEach((a) => {
      try {
        const href = a.getAttribute('href');
        const u = new URL(href, window.location.origin);
        if (u.pathname === target) a.classList.add('active');
      } catch {}
    });
  } catch {}
}
if (typeof window !== 'undefined') {
  // Run as early as possible and also on page lifecycle events
  try { setActiveNav(); } catch {}
  window.addEventListener('DOMContentLoaded', setActiveNav);
  window.addEventListener('pageshow', setActiveNav);
  window.addEventListener('popstate', setActiveNav);
}

export function getBackpackProvider() {
  // Prefer the standard Solana provider if it identifies as Backpack
  if (window?.solana && window.solana.isBackpack) return window.solana;
  // Some versions expose window.backpack.solana
  if (window?.backpack?.solana) return window.backpack.solana;
  // Fallback to raw window.backpack (older builds)
  if (window?.backpack) return window.backpack;
  return null;
}

function onWalletInjectedOnce(cb) {
  let called = false;
  const fire = () => { if (!called) { called = true; cb(); } };
  // Common wallet injection events
  window.addEventListener('load', fire, { once: true });
  window.addEventListener('solana#initialized', fire, { once: true });
  window.addEventListener('backpack#initialized', fire, { once: true });
  // Also poll briefly in case events don’t fire
  const start = Date.now();
  const timer = setInterval(() => {
    if (getBackpackProvider()) { clearInterval(timer); fire(); }
    if (Date.now() - start > 2000) { clearInterval(timer); }
  }, 100);
}

async function waitForProvider(timeoutMs = 2000) {
  const existing = getBackpackProvider();
  if (existing) return existing;
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(getBackpackProvider()); } };
    onWalletInjectedOnce(done);
    setTimeout(done, timeoutMs);
  });
}

function setButton(pk) {
  const btn = document.getElementById('connectBtn');
  if (!btn) return;
  if (!pk) {
    btn.textContent = 'Connect Backpack';
    btn.classList.remove('btn-ghost');
    return;
  }
  btn.textContent = `${pk.slice(0, 6)}...${pk.slice(-6)}`;
  btn.classList.add('btn-ghost');
}

function closeWalletPopover() {
  if (__walletPopover) { __walletPopover.remove(); __walletPopover = null; }
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('resize', closeWalletPopover);
  window.removeEventListener('scroll', closeWalletPopover, true);
}

function onDocClick(e) {
  const btn = document.getElementById('connectBtn');
  if (__walletPopover && e.target && __walletPopover.contains(e.target)) return;
  if (btn && e.target && btn.contains(e.target)) return;
  closeWalletPopover();
}

async function fetchSolBalance(pk) {
  try {
    const { Connection, PublicKey } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    const { rpc } = await getConfig();
    const c = new Connection(rpc, 'confirmed');
    const lamports = await c.getBalance(new PublicKey(pk), 'confirmed');
    return Number(lamports || 0) / 1_000_000_000;
  } catch { return null; }
}

export async function showWalletPopover() {
  const btn = document.getElementById('connectBtn');
  if (!btn) return;
  if (__walletPopover) { closeWalletPopover(); return; }
  const pk = __provider?.publicKey?.toString?.() || __provider?.publicKey || btn.textContent?.replace('Connect Backpack','');
  const anchor = btn.getBoundingClientRect();
  const left = Math.round(window.scrollX + anchor.left);
  const top = Math.round(window.scrollY + anchor.bottom + 8);
  const pop = document.createElement('div');
  pop.className = 'popover wallet-popover';
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.innerHTML = `
    <div class="title">Wallet</div>
    <div class="addr">${pk}</div>
    <div class="row mt"><div class="muted">Balance</div><div id="wpBal">…</div></div>
    <div class="row small muted"><div></div><div id="wpUsd"></div></div>
    <div class="actions">
      <button class="btn btn-ghost" id="wpCopy">Copy</button>
      <button class="btn" id="wpDisconnect">Disconnect</button>
    </div>
  `;
  document.body.appendChild(pop);
  __walletPopover = pop;
  document.addEventListener('click', onDocClick, true);
  window.addEventListener('resize', closeWalletPopover);
  window.addEventListener('scroll', closeWalletPopover, true);
  // Load balance + USD
  try {
    const [sol, pr] = await Promise.all([
      fetchSolBalance(pk),
      fetch('/api/sol-price').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    const balEl = pop.querySelector('#wpBal');
    const usdEl = pop.querySelector('#wpUsd');
    if (sol != null) balEl.textContent = `${sol.toFixed(4)} SOL`;
    const usd = typeof pr.usd === 'number' ? pr.usd : null;
    if (usd && sol != null) usdEl.textContent = `≈ $${(sol * usd).toFixed(2)}`;
  } catch {}
  // Actions
  pop.querySelector('#wpCopy')?.addEventListener('click', () => navigator.clipboard?.writeText(pk));
  pop.querySelector('#wpDisconnect')?.addEventListener('click', async () => {
    try { await disconnectBackpack(); } catch {}
    closeWalletPopover();
  });
}

function closeWalletMenu(immediate = false) {
  if (!__walletMenu) return;
  const el = __walletMenu;
  const remove = () => { if (el === __walletMenu) { el.remove(); __walletMenu = null; } };
  window.removeEventListener('scroll', scheduleCloseWalletMenu, true);
  window.removeEventListener('resize', scheduleCloseWalletMenu, true);
  clearTimeout(__hoverTimer);
  if (immediate) { remove(); return; }
  el.classList.remove('open');
  el.classList.add('closing');
  setTimeout(remove, 160);
}

function scheduleCloseWalletMenu() {
  clearTimeout(__hoverTimer);
  __hoverTimer = setTimeout(() => closeWalletMenu(), 200);
}

export async function showWalletMenu() {
  const btn = document.getElementById('connectBtn');
  if (!btn) return;
  if (__walletMenu) { return; }
  const pk = __provider?.publicKey?.toString?.() || __provider?.publicKey || btn.textContent?.replace('Connect Backpack','').trim();
  const short = pk && pk.length > 14 ? `${pk.slice(0, 6)}...${pk.slice(-6)}` : (pk || 'Wallet');

  const menu = document.createElement('div');
  menu.className = 'wallet-menu open';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="wm-header">
      <div class="wm-addr" id="wmAddr" title="Go to Collection">${short}</div>
      <button class="btn btn-ghost wm-copy" id="wmCopy" title="Copy address">Copy</button>
    </div>
    <div class="wm-section">
      <div class="wm-row">
        <button class="btn" id="wmLinkWallet" title="Link another wallet" disabled>Link Wallet</button>
        <button class="btn btn-ghost" id="wmTwitter" title="Sign in with X/Twitter" disabled>X / Twitter</button>
      </div>
    </div>
    <ul class="wm-list">
      <li id="wmProfile" role="menuitem">Profile</li>
      <li id="wmManage" role="menuitem" style="display:none">Manage Collections</li>
      <li id="wmSettings" role="menuitem">Account Settings</li>
      <li id="wmRewards" role="menuitem">Rewards</li>
    </ul>
    <div class="wm-footer">
      <button class="btn" id="wmLogout">Log out</button>
    </div>
  `;
  document.body.appendChild(menu);
  __walletMenu = menu;

  // Position near top-right/right edge; CSS anchors to right:16px, top ~ header height
  // Hover logic
  clearTimeout(__hoverTimer);
  const keepOpen = () => { clearTimeout(__hoverTimer); };
  btn.addEventListener('mouseleave', scheduleCloseWalletMenu);
  menu.addEventListener('mouseenter', keepOpen);
  menu.addEventListener('mouseleave', scheduleCloseWalletMenu);
  // Keep menu open while user scrolls; close on outside click or mouseleave
  window.addEventListener('resize', scheduleCloseWalletMenu, { passive: true });

  // Handlers
  const goCollection = () => { try { window.location.href = '/collection'; } catch(e) { console.error(e); } };
  menu.querySelector('#wmAddr')?.addEventListener('click', goCollection);
  menu.querySelector('#wmProfile')?.addEventListener('click', goCollection);
  // Conditionally show Manage if wallet is a collection owner
  (async () => {
    try {
      const j = await fetchJSON('/api/collections');
      const owns = (j.collections || []).some((c) => String(c.owner) === String(pk));
      if (owns) {
        const m = menu.querySelector('#wmManage');
        if (m) {
          m.style.display = '';
          m.addEventListener('click', () => { window.location.href = '/manage'; });
        }
      }
    } catch {}
  })();
  menu.querySelector('#wmCopy')?.addEventListener('click', () => { if (pk) navigator.clipboard?.writeText(pk); });
  menu.querySelector('#wmSettings')?.addEventListener('click', (e) => e.preventDefault());
  menu.querySelector('#wmRewards')?.addEventListener('click', (e) => e.preventDefault());
  menu.querySelector('#wmLogout')?.addEventListener('click', async () => { try { await disconnectBackpack(); } catch {} closeWalletMenu(true); });
}

export async function connectBackpack(opts = {}) {
  const provider = await waitForProvider(2500);
  if (!provider) {
    if (!opts.silent) showToast('Backpack not detected. Please install the extension.', { variant: 'error', title: 'Wallet Not Found' });
    return null;
  }
  try {
    if (opts.silent) {
      // Reconnect without prompting if user previously approved this site.
      await provider.connect({ onlyIfTrusted: true });
    } else {
      await provider.connect();
      localStorage.setItem('autoconnect', '1');
    }
  } catch (e) {
    if (opts.silent) return null;
    throw e;
  }
  const pk = provider.publicKey?.toString?.() || provider.publicKey;
  __provider = provider;
  setButton(pk);
  // Keep UI in sync with wallet events
  if (provider.on) {
    try {
      provider.on('connect', () => setButton(provider.publicKey?.toString?.() || provider.publicKey));
      provider.on('disconnect', () => { localStorage.removeItem('autoconnect'); setButton(null); closeWalletPopover(); });
      provider.on('accountChanged', (pubkey) => setButton(pubkey?.toString?.() || pubkey));
    } catch {}
  }
  return { provider, publicKey: pk };
}

export async function disconnectBackpack() {
  const provider = getBackpackProvider();
  if (provider && provider.disconnect) {
    try { await provider.disconnect(); } catch {}
  }
  localStorage.removeItem('autoconnect');
  __provider = null;
  setButton(null);
}

// Wire connect button on load and try silent auto-connect
window.addEventListener('DOMContentLoaded', () => {
  // Theme setup
  const getPreferredTheme = () => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  const applyTheme = (t) => {
    try { document.documentElement.setAttribute('data-theme', t); } catch {}
    const tt = document.getElementById('themeToggle');
    if (tt) {
      tt.textContent = t === 'dark' ? '☀️' : '🌙';
      tt.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      tt.setAttribute('title', t === 'dark' ? 'Light mode' : 'Dark mode');
    }
  };
  applyTheme(getPreferredTheme());
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
      const next = cur === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      applyTheme(next);
    });
  }

  // Active nav highlight
  const here = location.pathname.replace(/\/+$/, '');
  const links = document.querySelectorAll('.nav .nav-link');
  links.forEach((a) => {
    const href = (a.getAttribute('href') || '').replace(/\/+$/, '');
    if (href === here || (href !== '/' && here.startsWith(href))) a.classList.add('active');
    if (a.classList.contains('active')) a.setAttribute('aria-current', 'page');
  });

  // Network badge fill
  getConfig().then(({ network }) => {
    const b = document.getElementById('networkBadge');
    if (b) b.textContent = network;
  }).catch(() => {});

  const btn = document.getElementById('connectBtn');
  if (btn) btn.addEventListener('click', async (e) => {
    if (btn.classList.contains('btn-ghost')) {
      // Already connected: toggle wallet menu on click as well
      if (__walletMenu) { closeWalletMenu(); } else { await showWalletMenu(); }
    } else {
      await connectBackpack();
    }
  });
  // Hover to open wallet menu when connected
  if (btn) btn.addEventListener('mouseenter', async () => {
    if (btn.classList.contains('btn-ghost')) { await showWalletMenu(); }
  });
  document.addEventListener('click', (e) => {
    if (!__walletMenu) return;
    const btn = document.getElementById('connectBtn');
    if (e.target && (__walletMenu.contains(e.target) || (btn && btn.contains(e.target)))) return;
    closeWalletMenu();
  }, true);
  // Listeners are cleaned inside closeWalletMenu
  // Attempt silent reconnect if user connected before
  if (localStorage.getItem('autoconnect') === '1') {
    connectBackpack({ silent: true }).catch(() => {});
  }
});

// Neobrutal inline toast popup
export function showToast(message, { title, variant = 'info', duration = 5000, actions = [] } = {}) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${variant}`;
  toast.innerHTML = `
    ${title ? `<div class="title">${title}</div>` : ''}
    <div class="msg">${message}</div>
    <div class="actions"></div>
    <button class="close" aria-label="Close">×</button>
  `;
  const actionsWrap = toast.querySelector('.actions');
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = a.label || 'Action';
    b.addEventListener('click', () => a.onClick && a.onClick(toast));
    actionsWrap.appendChild(b);
  });
  const closeBtn = toast.querySelector('.close');
  const remove = () => {
    toast.classList.add('closing');
    setTimeout(() => toast.remove(), 200);
  };
  closeBtn.addEventListener('click', remove);
  container.appendChild(toast);
  if (duration > 0) setTimeout(remove, duration);
  return toast;
}

// Neobrutalist modal prompt
export function showPrompt({
  title = 'Input Required',
  label = 'Enter value',
  placeholder = '',
  defaultValue = '',
  okText = 'OK',
  cancelText = 'Cancel',
  inputType = 'text',
  min,
  max,
  step,
  pattern,
  usdPerSol,
  hintRender,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="title">${title}</div>
      <label class="label" for="modalInput">${label}</label>
      <input id="modalInput" class="input" placeholder="${placeholder}" />
      <div class="hint small muted" style="margin-top:6px"></div>
      <div class="error" role="alert" aria-live="polite" style="display:none"></div>
      <div class="row gap mt right actions">
        <button type="button" class="btn btn-ghost cancel">${cancelText}</button>
        <button type="button" class="btn confirm">${okText}</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector('#modalInput');
    // Apply input attributes if provided
    try {
      input.type = inputType || 'text';
      if (min != null) input.setAttribute('min', String(min));
      if (max != null) input.setAttribute('max', String(max));
      if (step != null) input.setAttribute('step', String(step));
      if (pattern != null) input.setAttribute('pattern', String(pattern));
      // On number type, prevent wheel from changing value accidentally
      input.addEventListener('wheel', (e) => input.type === 'number' && input.blur(), { passive: true });
    } catch {}
    input.value = defaultValue ?? '';
    input.focus();
    try { if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, String(input.value).length); } catch {}

    const cleanup = (val) => {
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 180);
      resolve(val);
    };
    const hintBox = modal.querySelector('.hint');
    const errorBox = modal.querySelector('.error');
    const showError = (msg) => {
      if (!msg) { errorBox.style.display = 'none'; errorBox.textContent = ''; return; }
      errorBox.textContent = msg;
      errorBox.style.display = '';
    };
    const renderHint = () => {
      if (!hintBox) return;
      const v = String(input.value).trim();
      if (hintRender) { hintBox.innerHTML = hintRender(v) || ''; return; }
      if (usdPerSol && input.type === 'number') {
        const n = Number(v);
        if (isFinite(n)) { hintBox.textContent = `≈ $${(n * usdPerSol).toFixed(2)}`; return; }
      }
      hintBox.textContent = '';
    };
    renderHint();

    const extract = () => String(input.value).trim();
    const validateAndSubmit = () => {
      const val = extract();
      // Default validation for number type + min/max
      if (input.type === 'number') {
        const num = Number(val);
        if (!isFinite(num)) { showError('Please enter a valid number.'); return; }
        const minAttr = input.getAttribute('min');
        const maxAttr = input.getAttribute('max');
        if (minAttr != null && num < Number(minAttr)) { showError(`Minimum value is ${minAttr}${/sol/i.test(label) ? ' SOL' : ''}.`); return; }
        if (maxAttr != null && num > Number(maxAttr)) { showError(`Maximum value is ${maxAttr}${/sol/i.test(label) ? ' SOL' : ''}.`); return; }
      }
      showError('');
      cleanup(val);
    };

    modal.querySelector('.cancel').addEventListener('click', () => cleanup(null));
    modal.querySelector('.confirm').addEventListener('click', validateAndSubmit);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cleanup(null);
      if (e.key === 'Enter') validateAndSubmit();
    });

    input.addEventListener('input', () => { showError(''); renderHint(); });
  });
}
