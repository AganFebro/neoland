import { fetchJSON, connectBackpack, showToast, getConfig, txExplorerUrl, waitForConfirmation, sendAndTrack, setImgSrc, showPrompt, renderUpdates, setupCollapsible } from '/common.js?v=2';

const CARV_MINT = 'D7WVEw9Pkf4dfCCE3fwGikRCCTvm9ipqTYPHRENLiw3s';
let __prices = null; // { solUsd, carvUsd, carvPerSol, _ts }
async function getPrices() {
  if (__prices && Date.now() - __prices._ts < 60_000) return __prices;
  try {
    const p = await fetchJSON('/api/prices');
    __prices = { ...p, _ts: Date.now() };
  } catch { __prices = { solUsd: null, carvUsd: null, carvPerSol: null, _ts: Date.now() }; }
  return __prices;
}

const PAGE_SIZE = 6;

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

function fmtSOL(lamports) { return (Number(lamports || 0) / 1_000_000_000).toString(); }
function fmtListingPrice(l) {
  if (l.currencyMint && l.priceAmount != null) {
    const carv = Number(l.priceAmount || 0) / 1_000_000_000;
    return `${carv.toFixed(2)} CARV`;
  }
  return `${fmtSOL(l.priceLamports)} SOL`;
}

async function loadListings(filter = {}) {
  const params = new URLSearchParams();
  if (filter.collectionId) params.set('collectionId', filter.collectionId);
  if (filter.seller) params.set('seller', filter.seller);
  const { listings } = await fetchJSON(`/api/market/listings?${params.toString()}`);
  return listings || [];
}

// Simple numeric pager renderer
function renderPager(container, totalPages, current, onPage) {
  if (!container) return;
  container.innerHTML = '';
  if (totalPages <= 1) return;
  for (let i = 1; i <= totalPages; i++) {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost';
    b.textContent = String(i);
    if (i === current) b.disabled = true;
    b.addEventListener('click', () => onPage(i));
    container.appendChild(b);
  }
}

// Render collections grid with floor price and listed counts (card style)
async function renderCollectionsTable() { // kept name to avoid changing init wiring
  const wrap = document.getElementById('collectionsWrap');
  wrap.innerHTML = '<div class="skeleton block"></div><div class="skeleton text"></div>';
  try {
    const [{ collections }, { listings }, sol] = await Promise.all([
      fetchJSON('/api/collections'),
      fetchJSON('/api/market/listings'),
      fetchJSON('/api/prices').catch(() => ({})),
    ]);
    const usd = typeof sol?.solUsd === 'number' ? sol.solUsd : (typeof sol?.usd === 'number' ? sol.usd : null);
    const carvPerSol = typeof sol?.carvPerSol === 'number' ? sol.carvPerSol : null;
    // stash for other renderers in this module
    renderCollectionsTable.__prices = { solUsd: usd, carvPerSol, carvUsd: (typeof sol?.carvUsd === 'number' ? sol.carvUsd : null) };
    const byId = new Map(collections.map((c) => [c.id, c]));
    const floor = new Map();
    const count = new Map();
    listings.forEach((l) => {
      const p = Number(l.priceLamports || 0);
      count.set(l.collectionId, (count.get(l.collectionId) || 0) + 1);
      floor.set(l.collectionId, Math.min(floor.get(l.collectionId) ?? Infinity, p));
    });

    const rows = collections.map((c) => ({
      id: c.id,
      slug: slugify(c.name || c.symbol || c.id),
      name: c.name,
      symbol: c.symbol,
      image: c.image,
      floorLamports: floor.get(c.id) ?? null,
      listed: count.get(c.id) || 0,
      supply: c.supply || 0,
    }));
    rows.sort((a, b) => (a.floorLamports ?? Number.MAX_SAFE_INTEGER) - (b.floorLamports ?? Number.MAX_SAFE_INTEGER));

    const q = (document.getElementById('collSearch')?.value || '').toLowerCase();
    const filtered = rows.filter(r => !q || (r.name || '').toLowerCase().includes(q) || (r.symbol || '').toLowerCase().includes(q));
    const page = Number(renderCollectionsTable.__page || 1);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const current = Math.min(Math.max(1, page), totalPages);
    renderCollectionsTable.__page = current;
    const start = (current - 1) * PAGE_SIZE;
    const slice = filtered.slice(start, start + PAGE_SIZE);
    const grid = document.createElement('div');
    grid.className = 'grid';
    slice.forEach((r) => {
        const el = document.createElement('div');
        el.className = 'nft';
        const solFloor = r.floorLamports != null ? (r.floorLamports / 1_000_000_000) : null;
        const carvTxt = (solFloor != null && carvPerSol) ? ` • ≈ ${(solFloor*carvPerSol).toFixed(2)} CARV` : '';
        const usdTxt = (solFloor != null && usd) ? ` • ≈ $${(solFloor*usd).toFixed(2)}` : '';
        el.innerHTML = `
          <div class="meta"><strong>${r.name}</strong> <span>(${r.symbol})</span> <span class="small muted">• ${r.id}</span></div>
          <img alt="${r.name}" loading="lazy" />
          <div class="meta"><strong>Floor:</strong> ${solFloor != null ? `${solFloor.toFixed(4)} SOL${carvTxt}${usdTxt}` : '—'}</div>
          <div class="meta"><strong>Listed:</strong> ${r.listed} / ${r.supply || 0}</div>
          <div class="row gap mt">
            <a class="btn" href="/market/${r.slug}-${r.id}">View Items</a>
          </div>
        `;
        setImgSrc(el.querySelector('img'), r.image);
        grid.appendChild(el);
      });
    wrap.innerHTML = '';
    wrap.appendChild(grid);
    const anchor = document.getElementById('collectionsWrap');
    renderPager(document.getElementById('collectionsPager'), totalPages, current, (p) => {
      renderCollectionsTable.__page = p;
      renderCollectionsTable();
      // Keep UX stable by scrolling the list back to top
      anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } catch (e) {
    console.error(e);
    wrap.innerHTML = '<div class="muted">Failed to load collections</div>';
  }
}

// Existing item-level marketplace actions (used on collection page too)
async function renderMarketListInto(wrap, listings) {
  const { collections } = await fetchJSON('/api/collections');
  const byId = new Map(collections.map(c => [c.id, c]));
  wrap.innerHTML = '';
  listings.forEach((l) => {
    const c = byId.get(l.collectionId);
    const el = document.createElement('div');
    el.className = 'nft';
    el.innerHTML = `
      <img alt="NFT" loading="lazy" />
      <div class="meta"><strong>${c?.name || 'Collection'}</strong> <span>(${c?.symbol || ''})</span></div>
      <div class="meta"><strong>Mint:</strong> ${l.mint}</div>
      <div class="meta"><strong>Price:</strong> ${(() => { const pr = renderCollectionsTable.__prices || {}; const usd = pr.solUsd; const carvUsd = pr.carvUsd; if (l.currencyMint && l.priceAmount != null) { const carv = Number(l.priceAmount||0)/1_000_000_000; const usdTxt = carvUsd?` ($${(carv*carvUsd).toFixed(2)})`:''; return `${carv.toFixed(2)} CARV${usdTxt}`; } const sol = Number(l.priceLamports||0)/1_000_000_000; const usdTxt = usd?` ($${(sol*usd).toFixed(2)})`:''; return `${sol} SOL${usdTxt}`; })()}</div>
      <div class="row gap mt">
        <button class="btn" data-id="${l.id}">Buy</button>
      </div>
    `;
    setImgSrc(el.querySelector('img'), c?.image);
    el.querySelector('button').onclick = async (ev) => {
        const btn = ev.target;
        if (!btn.dataset.confirmed) {
          btn.dataset.confirmed = '1';
          const prev = btn.textContent;
          btn.textContent = 'Click again to Confirm';
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
          try {
            await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' });
          } catch (e) {
            showToast('Network slow to confirm. Check explorer.', { title: 'Pending', variant: 'info', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
          }
          // Mark sold off-chain for UI
          try { await fetchJSON(`/api/market/sold`, { method: 'POST', body: JSON.stringify({ listingId: l.id, buyer: pk }) }); } catch {}
          showToast('Purchase executed!', { title: 'Bought', variant: 'success', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
          await renderCollectionsTable();
        } catch (e) {
          console.error(e);
          showToast((e.message || String(e)), { title: 'Buy failed', variant: 'error' });
        } finally {
          btn.disabled = false; btn.textContent = 'Buy';
        }
      };
    wrap.appendChild(el);
  });
}


async function renderMyListings(publicKey) {
  const wrap = document.getElementById('myListings');
  wrap.innerHTML = '<div class="skeleton block"></div><div class="skeleton text"></div>';
  try {
    const listings = await loadListings({ seller: publicKey });
    if (!listings.length) {
      wrap.innerHTML = '<div class="muted">No active listings</div>';
      return;
    }
    const { collections } = await fetchJSON('/api/collections');
    const byId = new Map(collections.map(c => [c.id, c]));
    wrap.innerHTML = '';
    listings.forEach((l) => {
      const c = byId.get(l.collectionId);
      const el = document.createElement('div');
      el.className = 'nft';
      el.innerHTML = `
        <img alt="NFT" loading="lazy" />
        <div class="meta"><strong>${c?.name || 'Collection'}</strong> <span>(${c?.symbol || ''})</span></div>
        <div class="meta"><strong>Mint:</strong> ${l.mint}</div>
        <div class="meta"><strong>Price:</strong> ${fmtListingPrice(l)}</div>
        <div class="row gap mt">
          <button class="btn" data-id="${l.id}">Cancel</button>
        </div>
      `;
      setImgSrc(el.querySelector('img'), c?.image);
      el.querySelector('button').onclick = async (ev) => {
        const btn = ev.target;
        if (!btn.dataset.confirmed) {
          btn.dataset.confirmed = '1';
          const prev = btn.textContent;
          btn.textContent = 'Click again to Confirm';
          setTimeout(() => { delete btn.dataset.confirmed; btn.textContent = prev; }, 3000);
          return;
        }
        btn.disabled = true; btn.textContent = 'Cancelling...';
        try {
          const conn = await connectBackpack();
          if (!conn) throw new Error('Wallet not connected');
          const { provider, publicKey: pk } = conn;
          const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
          // Build on-chain cancel tx
          const r = await fetchJSON('/api/market/tx/cancel', { method: 'POST', body: JSON.stringify({ mint: l.mint, seller: pk }) });
          const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
          const tx = Transaction.from(buf);
          const signed = await provider.signTransaction(tx);
          const { rpc } = await getConfig();
          const connection = new Connection(rpc, 'confirmed');
          const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
          try {
            await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' });
          } catch (e) {
            showToast('Network slow to confirm. Check explorer.', { title: 'Pending', variant: 'info', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
          }
          // Off-chain mark cancel
          await fetchJSON('/api/market/cancel', { method: 'POST', body: JSON.stringify({ listingId: l.id, seller: pk }) });
          showToast('Listing cancelled', { title: 'Cancelled', variant: 'success', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
          await Promise.all([renderCollectionsTable(), renderMyListings(pk)]);
        } catch (e) {
          console.error(e);
          showToast((e.message || String(e)), { title: 'Cancel failed', variant: 'error' });
        } finally {
          btn.disabled = false; btn.textContent = 'Cancel';
        }
      };
      wrap.appendChild(el);
    });
  } catch (e) {
    console.error(e);
    wrap.innerHTML = '<div class="muted">Failed to load your listings</div>';
  }
}

async function init() {
  // Collections table on this page
  const search = document.getElementById('collSearch');
  if (search) search.addEventListener('input', () => {
    renderCollectionsTable.__page = 1;
    renderCollectionsTable();
    document.getElementById('collectionsWrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  // Render site updates
  renderUpdates('#updatesWrap', { limit: 3 }).catch(console.error);
  setupCollapsible({ button: '#updatesToggle', panel: '#updatesPanel', open: false });
  await renderCollectionsTable();
  const conn = await connectBackpack({ silent: true });
  if (conn) {
    await renderMyListings(conn.publicKey);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch(console.error);
});
