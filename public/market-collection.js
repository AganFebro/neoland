import { fetchJSON, connectBackpack, showToast, getConfig, txExplorerUrl, waitForConfirmation, sendAndTrack, setImgSrc } from '/common.js';

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function fmtSOL(l) { return (Number(l || 0) / 1_000_000_000).toString(); }
function fmtSOL4(l) { const n = Number(l||0)/1_000_000_000; return (Math.round(n*10000)/10000).toFixed(4); }

async function getCollectionFromPath() {
  const segs = location.pathname.split('/').filter(Boolean);
  const seg = segs[1]; // /market/<slug>[-|~]<id>
  let slug = seg || '';
  let idFromPath = '';
  if (slug.includes('~')) {
    const parts = slug.split('~');
    idFromPath = parts.pop();
    slug = parts.join('~');
  } else if (slug.includes('-')) {
    // Split on last hyphen to support hyphens in slug
    const i = slug.lastIndexOf('-');
    if (i > 0) { idFromPath = slug.slice(i + 1); slug = slug.slice(0, i); }
  }
  const qid = new URLSearchParams(location.search).get('id') || idFromPath;
  const { collections } = await fetchJSON('/api/collections');
  let coll = null;
  if (qid) coll = collections.find(c => c.id === qid);
  if (!coll) coll = collections.find(c => slugify(c.name || c.symbol || c.id) === slug);
  return coll;
}

async function loadCollectionListings(collectionId) {
  const { listings } = await fetchJSON(`/api/market/listings?collectionId=${encodeURIComponent(collectionId)}`);
  return listings || [];
}

async function loadCollectionActivity(collectionId) {
  try {
    const { events } = await fetchJSON(`/api/market/activity?collectionId=${encodeURIComponent(collectionId)}`);
    return Array.isArray(events) ? events : [];
  } catch { return []; }
}

async function renderCollection() {
  const info = await getCollectionFromPath();
  const wrap = document.getElementById('itemsWrap');
  if (!info) {
    document.getElementById('collTitle').textContent = 'Collection not found';
    wrap.innerHTML = '<div class="muted">Unknown collection</div>';
    return;
  }
  document.getElementById('collTitle').textContent = `${info.name} (${info.symbol})`;
  document.getElementById('collMeta').textContent = `${info.id}`;

  const listings = await loadCollectionListings(info.id);
  const activity = await loadCollectionActivity(info.id);
  // Load stats + SOL price (USD)
  let stats = { floorLamports: null, vol24hLamports: 0, totalVolumeLamports: 0 };
  let solUsd = null;
  try { stats = await fetchJSON(`/api/market/stats?collectionId=${encodeURIComponent(info.id)}`); } catch {}
  try { const q = await fetchJSON('/api/sol-price'); solUsd = typeof q.usd === 'number' ? q.usd : null; } catch {}
  // Fill stats UI
  const floorEl = document.getElementById('statFloor');
  const floorUsdEl = document.getElementById('statFloorUsd');
  const vol24El = document.getElementById('statVol24');
  const vol24UsdEl = document.getElementById('statVol24Usd');
  const totalEl = document.getElementById('statVolTotal');
  const totalUsdEl = document.getElementById('statVolTotalUsd');
  const setStat = (el, lamports) => { el.textContent = lamports != null ? `${fmtSOL4(lamports)} SOL` : '—'; };
  setStat(floorEl, stats.floorLamports);
  setStat(vol24El, stats.vol24hLamports);
  setStat(totalEl, stats.totalVolumeLamports);
  const setUsd = (el, lamports) => {
    if (!el) return;
    if (solUsd && lamports != null) {
      const sol = Number(lamports||0)/1_000_000_000;
      el.textContent = `≈ $${(sol*solUsd).toFixed(2)}`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  };
  setUsd(floorUsdEl, stats.floorLamports);
  setUsd(vol24UsdEl, stats.vol24hLamports);
  setUsd(totalUsdEl, stats.totalVolumeLamports);
  const q = () => (document.getElementById('itemSearch')?.value || '').toLowerCase();
  const renderItems = () => {
    wrap.innerHTML = '';
    listings
      .filter(l => !q() || (l.mint || '').toLowerCase().includes(q()))
      .forEach((l) => {
        const el = document.createElement('div');
        el.className = 'nft';
        el.innerHTML = `
          <img alt="NFT" loading="lazy" />
          <div class="meta"><strong>${info.name}</strong> <span>(${info.symbol})</span></div>
          <div class="meta"><strong>Mint:</strong> ${l.mint}</div>
          <div class="meta"><strong>Price:</strong> ${fmtSOL(l.priceLamports)} SOL ${solUsd ? `(<span class="usd">$${(Number(l.priceLamports||0)/1_000_000_000*solUsd).toFixed(2)}</span>)` : ''}</div>
          <div class="row gap mt">
            <button class="btn" data-id="${l.id}">Buy</button>
          </div>
        `;
        setImgSrc(el.querySelector('img'), info.image);
        el.querySelector('button').onclick = async (ev) => {
          const btn = ev.target;
          if (!btn.dataset.confirmed) {
            btn.dataset.confirmed = '1';
            const prev = btn.textContent; btn.textContent = 'Click again to Confirm';
            setTimeout(() => { delete btn.dataset.confirmed; btn.textContent = prev; }, 3000);
            return;
          }
          btn.disabled = true; btn.textContent = 'Buying...';
          try {
            const conn = await connectBackpack();
            if (!conn) throw new Error('Wallet not connected');
            const { provider, publicKey: pk } = conn;
            if (String(pk) === String(l.seller)) { showToast('You cannot buy your own listing.', { title: 'Not Allowed', variant: 'error' }); return; }
            const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
            const r = await fetchJSON(`/api/market/tx/buy`, { method: 'POST', body: JSON.stringify({ listingId: l.id, buyer: pk }) });
            const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
            const tx = Transaction.from(buf);
            const signed = await provider.signTransaction(tx);
            const { rpc } = await getConfig();
            const connection = new Connection(rpc, 'confirmed');
            const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
            try { await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' }); }
            catch { showToast('Network slow to confirm. Check explorer.', { title: 'Pending', variant: 'info', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] }); }
            try { await fetchJSON(`/api/market/sold`, { method: 'POST', body: JSON.stringify({ listingId: l.id, buyer: pk }) }); } catch {}
            const toast = showToast('Purchase executed!<br/>Refreshing in <span id="buyRefresh">5</span>s…', { title: 'Bought', variant: 'success', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
            // Reload in-app data immediately
            const fresh = await loadCollectionListings(info.id);
            listings.length = 0; Array.prototype.push.apply(listings, fresh);
            renderItems();
            // Also pull fresh activity data
            const evs = await loadCollectionActivity(info.id);
            activity.length = 0; Array.prototype.push.apply(activity, evs);
            // If activity tab is visible, re-render it
            if (!document.getElementById('sectionActivity').classList.contains('hidden')) renderActivity();
            // Auto full refresh after brief countdown to get everything consistent
            let n = 5; const span = toast?.querySelector?.('#buyRefresh');
            const timer = setInterval(() => { n -= 1; if (span) span.textContent = String(n); if (n <= 0) { clearInterval(timer); location.reload(); } }, 1000);
          } catch (e) {
            console.error(e);
            showToast((e.message || String(e)), { title: 'Buy failed', variant: 'error' });
          } finally {
            btn.disabled = false; btn.textContent = 'Buy';
          }
        };
        wrap.appendChild(el);
      });
  };
  const actWrap = document.getElementById('activityWrap');
  const fmtAddr = (a) => a ? `${a.slice(0,6)}...${a.slice(-6)}` : '—';
  const fmtTime = (t) => {
    const ts = Number(t || 0) * 1000; if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  };
  const renderActivity = () => {
    actWrap.innerHTML = '';
    if (!activity.length) { actWrap.innerHTML = '<div class="muted">No activity yet</div>'; return; }
    const table = document.createElement('table');
    table.className = 'table';
    table.innerHTML = `
      <thead><tr><th>Time</th><th>Event</th><th>Mint</th><th>Price</th><th>Actor(s)</th></tr></thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    activity.forEach((e) => {
      const tr = document.createElement('tr');
      if (e.type === 'mint') {
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Mint</span></td><td>${e.mint}</td><td>—</td><td>by ${fmtAddr(e.minter)}</td>`;
      } else if (e.type === 'sale') {
        const sol = Number(e.priceLamports || 0) / 1_000_000_000;
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Sale</span></td><td>${e.mint}</td><td>${sol.toFixed(4)} SOL</td><td>${fmtAddr(e.seller)} → ${fmtAddr(e.buyer)}</td>`;
      } else {
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td>${e.type}</td><td>${e.mint || ''}</td><td></td><td></td>`;
      }
      tbody.appendChild(tr);
    });
    actWrap.appendChild(table);
  };

  // Initial render defaults to Items
  renderItems();
  // Wire search
  const search = document.getElementById('itemSearch');
  if (search) search.addEventListener('input', () => renderItems());

  // Tabs
  const tabItems = document.getElementById('tabItems');
  const tabAct = document.getElementById('tabActivity');
  const secItems = document.getElementById('sectionItems');
  const secAct = document.getElementById('sectionActivity');
  const setTab = (name) => {
    const itemsActive = name === 'items';
    tabItems.setAttribute('aria-selected', String(itemsActive));
    tabAct.setAttribute('aria-selected', String(!itemsActive));
    if (itemsActive) { secItems.classList.remove('hidden'); secAct.classList.add('hidden'); }
    else { secAct.classList.remove('hidden'); secItems.classList.add('hidden'); renderActivity(); }
    document.getElementById('itemSearch').style.display = itemsActive ? '' : 'none';
  };
  tabItems?.addEventListener('click', () => setTab('items'));
  tabAct?.addEventListener('click', () => setTab('activity'));
}

window.addEventListener('DOMContentLoaded', () => {
  renderCollection().catch(console.error);
});
