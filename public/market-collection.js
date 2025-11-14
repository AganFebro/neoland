import { fetchJSON, connectBackpack, getBackpackProvider, showToast, getConfig, txExplorerUrl, waitForConfirmation, sendAndTrack, setImgSrc, showPrompt } from '/common.js';

const CARV_MINT = 'D7WVEw9Pkf4dfCCE3fwGikRCCTvm9ipqTYPHRENLiw3s';
let __prices = null;
async function getPrices() { try { if (!__prices || Date.now() - __prices._ts > 60000) { const p = await fetchJSON('/api/prices'); __prices = { ...p, _ts: Date.now() }; } } catch { __prices = { solUsd: null, carvUsd: null, carvPerSol: null, _ts: Date.now() }; } return __prices; }

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function fmtSOL(l) { return (Number(l || 0) / 1_000_000_000).toString(); }
function fmtListingPrice(l, solUsd, prices) {
  const pr = prices || {};
  const usdPerSol = Number(pr.solUsd || solUsd || 0) || null;
  const carvUsd = Number(pr.carvUsd || 0) || null;
  if (l.currencyMint && l.priceAmount != null) {
    const carv = Number(l.priceAmount || 0) / 1_000_000_000;
    const usdTxt = (carvUsd ? ` ($${(carv * carvUsd).toFixed(2)})` : '');
    return `${carv.toFixed(2)} CARV${usdTxt}`;
  }
  const sol = Number(l.priceLamports || 0) / 1_000_000_000;
  const usdTxt = (usdPerSol ? ` ($${(sol * usdPerSol).toFixed(2)})` : '');
  return `${sol} SOL${usdTxt}`;
}
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

async function getBestOnchainOffer(collectionPda) {
  try {
    const { Connection, PublicKey } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    const cfg = await getConfig();
    const c = new Connection(cfg.rpc, 'confirmed');
    const programId = new PublicKey(cfg.offersProgramId || 'OFFERS11111111111111111111111111111111111');
    const filters = [
      { memcmp: { offset: 8, bytes: new PublicKey(collectionPda).toBase58() } },
      { dataSize: 8 + 32 + 32 + 8 + 1 },
    ];
    const accs = await c.getProgramAccounts(programId, { filters });
    let best = null;
    for (const a of accs) {
      const d = a.account.data;
      const bidder = new PublicKey(d.slice(8 + 32, 8 + 32 + 32)).toBase58();
      const price = Number(d.readBigUInt64LE(8 + 32 + 32));
      if (!best || price > best.priceLamports) best = { bidder, priceLamports: price, pubkey: a.pubkey.toBase58() };
    }
    return best;
  } catch { return null; }
}

async function getMyOnchainOffer(collectionPda, bidderPk) {
  try {
    const { Connection, PublicKey } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    const cfg = await getConfig();
    const c = new Connection(cfg.rpc, 'confirmed');
    const programId = new PublicKey(cfg.offersProgramId || 'OFFERS11111111111111111111111111111111111');
    const filters = [
      { memcmp: { offset: 8, bytes: new PublicKey(collectionPda).toBase58() } },
      { dataSize: 8 + 32 + 32 + 8 + 1 },
    ];
    const accs = await c.getProgramAccounts(programId, { filters });
    for (const a of accs) {
      const d = a.account.data;
      const bidder = new PublicKey(d.slice(8 + 32, 8 + 32 + 32)).toBase58();
      if (bidder !== bidderPk) continue;
      const price = Number(d.readBigUInt64LE(8 + 32 + 32));
      return { bidder, priceLamports: price, pubkey: a.pubkey.toBase58() };
    }
    return null;
  } catch { return null; }
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
  // Set collection image preview (top-right) and hide placeholder after load
  try {
    const imgSrc = info.image || info.image_gateway;
    const hero = document.getElementById('collHeroImg');
    if (hero && imgSrc) setImgSrc(hero, imgSrc);
  } catch {}
  try {
    const rbps = Number(info.royaltyBps || 0);
    const pct = (rbps / 100).toFixed(2).replace(/\.00$/, '');
    document.getElementById('collMeta').textContent = `${info.id} • Royalty: ${pct}%`;
  } catch {
    document.getElementById('collMeta').textContent = `${info.id}`;
  }

  // Fetch everything in parallel, but render Items as soon as listings arrive
  let listings = [];
  const listingsP = loadCollectionListings(info.id).then((l)=>Array.isArray(l)?l:[]).catch(()=>[]);
  const offersP = fetchJSON(`/api/market/offers?collectionId=${encodeURIComponent(info.id)}`).then(r=>Array.isArray(r.offers)?r.offers:[]).catch(()=>[]);
  const activityP = loadCollectionActivity(info.id).catch(()=>[]);
  const statsP = fetchJSON(`/api/market/stats?collectionId=${encodeURIComponent(info.id)}`).catch(()=>({ floorLamports: null, vol24hLamports: 0, totalVolumeLamports: 0 }));
  const pricesP = getPrices().catch(()=>({}));

  // Render items ASAP (skeleton -> quick empty state)
  listings = await listingsP;
  try {
    const wrapQuick = document.getElementById('itemsWrap');
    if (wrapQuick) {
      wrapQuick.innerHTML = '';
      if (!Array.isArray(listings) || listings.length === 0) {
        wrapQuick.innerHTML = '<div class="muted">No active listings in this collection.</div>';
      }
    }
  } catch {}
  
  // Fill stats UI
  const floorEl = document.getElementById('statFloor');
  const floorUsdEl = document.getElementById('statFloorUsd');
  const vol24El = document.getElementById('statVol24');
  const vol24UsdEl = document.getElementById('statVol24Usd');
  const totalEl = document.getElementById('statVolTotal');
  const totalUsdEl = document.getElementById('statVolTotalUsd');
  // Inject Best Offer stat
  const statsRow = document.getElementById('statsRow');
  let bestOfferEl = document.createElement('div');
  bestOfferEl.className = 'stat';
  bestOfferEl.innerHTML = `<div class="label">Best Offer</div><div class="value" id="statBestOffer">—</div><div class="sub" id="statBestOfferUsd"></div>`;
  statsRow?.appendChild(bestOfferEl);
  // Stats style: USD primary, SOL + CARV as sub (match mint-collection)
  const prices = await pricesP; const usdPerSol = Number(prices?.solUsd || 0) || null;
  const cps = Number(prices?.carvPerSol || 0) || null;
  const setUsdPrimary = (valEl, subEl, lamports) => {
    if (!valEl) return;
    if (lamports == null) { valEl.textContent = '—'; if (subEl) subEl.textContent = ''; return; }
    const solAmt = Number(lamports || 0) / 1_000_000_000;
    const usdTxt = usdPerSol ? `$${(solAmt * usdPerSol).toFixed(2)}` : '—';
    valEl.textContent = usdTxt;
    if (subEl) {
      const sub = `${solAmt.toFixed(4)} SOL${cps ? ` • ≈ ${(solAmt * cps).toFixed(2)} CARV` : ''}`;
      subEl.textContent = sub;
      subEl.style.display = '';
    }
  };
  const stats = await statsP;
  setUsdPrimary(floorEl, floorUsdEl, stats.floorLamports);
  setUsdPrimary(vol24El, vol24UsdEl, stats.vol24hLamports);
  setUsdPrimary(totalEl, totalUsdEl, stats.totalVolumeLamports);
  const offers = await offersP;
  let best = offers.length ? offers.reduce((a, b) => (Number(a.priceLamports||0) > Number(b.priceLamports||0) ? a : b)) : null;
  const bestEl = document.getElementById('statBestOffer');
  const bestUsdEl = document.getElementById('statBestOfferUsd');
  // Prefer on-chain best offer if collection has onchain_pda
  if (info.onchain_pda) {
    try { const on = await getBestOnchainOffer(info.onchain_pda); if (on) best = on; } catch {}
  }
  if (best) {
    const prices = await getPrices();
    const solUsd = Number(prices?.solUsd || 0) || null;
    const cps = Number(prices?.carvPerSol || 0) || null;
    const solAmt = Number(best.priceLamports||0)/1_000_000_000;
    bestEl.textContent = solUsd ? `$${(solAmt*solUsd).toFixed(2)}` : `${solAmt.toFixed(4)} SOL`;
    if (bestUsdEl) bestUsdEl.textContent = `${solAmt.toFixed(4)} SOL${cps?` • ≈ ${(solAmt*cps).toFixed(2)} CARV`:''}`;
  }
  const q = () => (document.getElementById('itemSearch')?.value || '').toLowerCase();
  const renderItems = () => {
    wrap.innerHTML = '';
    const rows = listings.filter(l => !q() || (l.mint || '').toLowerCase().includes(q()));
    if (!rows.length) { wrap.innerHTML = '<div class="muted">No active listings in this collection.</div>'; return; }
    rows.forEach((l) => {
      const el = document.createElement('div');
        el.className = 'nft';
        const priceHtml = (function() {
          if (l.currencyMint && l.priceAmount != null) {
            const carv = Number(l.priceAmount || 0) / 1_000_000_000;
            const usd = __prices?.carvUsd ? ` ($${(carv * __prices.carvUsd).toFixed(2)})` : '';
            return `${carv.toFixed(2)} CARV${usd}`;
          }
          const sol = Number(l.priceLamports || 0) / 1_000_000_000;
          const solUsd2 = Number(prices?.solUsd || 0) || null;
          const usd = solUsd2 ? ` ($${(sol*solUsd2).toFixed(2)})` : '';
          return `${sol} SOL${usd}`;
        })();
        el.innerHTML = `
          <img alt="NFT" loading="lazy" />
          <div class="meta"><strong>${info.name}</strong> <span>(${info.symbol})</span></div>
          <div class="meta"><strong>Mint:</strong> ${l.mint}</div>
          <div class="meta"><strong>Price:</strong> ${priceHtml}</div>
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
            const endpoint = l.currencyMint ? '/api/market/tx/buy-spl' : '/api/market/tx/buy';
            const r = await fetchJSON(endpoint, { method: 'POST', body: JSON.stringify({ listingId: l.id, buyer: pk }) });
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
            actData.length = 0; Array.prototype.push.apply(actData, evs);
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
  // Offer actions UI (on-chain make/cancel)
  try {
    const toolbar = document.querySelector('.toolbar .stack');
    if (toolbar) {
      const actions = document.createElement('div');
      actions.className = 'row gap mt';
      const makeBtn = document.createElement('button'); makeBtn.className = 'btn'; makeBtn.textContent = 'Make Offer';
      const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = 'Cancel Offer'; cancelBtn.style.display = 'none';
      actions.appendChild(makeBtn); actions.appendChild(cancelBtn);
      const bestEl = document.getElementById('statBestOffer');
      const bestUsdEl = document.getElementById('statBestOfferUsd');
      const refreshOfferButtons = async () => {
        const conn = await connectBackpack({ silent: true });
        const my = conn && info.onchain_pda ? await getMyOnchainOffer(info.onchain_pda, conn.publicKey) : null;
        cancelBtn.style.display = my ? '' : 'none';
      };
      makeBtn.addEventListener('click', async () => {
        const conn = await connectBackpack(); if (!conn) return;
        if (!info.onchain_pda) { showToast('Collection is missing on-chain PDA.', { title: 'Unavailable', variant: 'error' }); return; }
        let solUsd = null; try { const q = await fetchJSON('/api/sol-price'); solUsd = typeof q.usd === 'number' ? q.usd : null; } catch {}
        const priceStr = await showPrompt({ title: 'Make Collection Offer', label: 'Offer price (SOL)', inputType: 'number', min: 0.0001, step: 0.0001, usdPerSol: solUsd });
        if (!priceStr) return; const price = Number(priceStr); if (!isFinite(price) || price <= 0) { showToast('Invalid price', { title: 'Validation', variant: 'error' }); return; }
        try {
          const build = await fetchJSON('/api/offers/tx/make', { method: 'POST', body: JSON.stringify({ collectionId: info.id, bidder: conn.publicKey, priceSol: price }) });
          const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
          const buf = Uint8Array.from(atob(build.tx), c => c.charCodeAt(0));
          const tx = Transaction.from(buf);
          const signed = await conn.provider.signTransaction(tx);
          const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed');
          const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed' });
          try { await waitForConfirmation(connection, sig, { desired: 'confirmed' }); } catch {}
          showToast(`Offer placed: ${price.toFixed(4)} SOL`, { title: 'Offer Created', variant: 'success' });
          try { await fetchJSON('/api/market/activity/offer-created', { method: 'POST', body: JSON.stringify({ collectionId: info.id, bidder: conn.publicKey, priceLamports: Math.round(price*1_000_000_000), ts: Math.floor(Date.now()/1000) }) }); } catch {}
          const bo = await getBestOnchainOffer(info.onchain_pda); if (bo) { bestEl.textContent = `${fmtSOL4(bo.priceLamports)} SOL`; const lamports = bo.priceLamports; if (bestUsdEl) { const usdQ = await fetchJSON('/api/sol-price').catch(()=>({})); const usd = typeof usdQ.usd==='number'?usdQ.usd:null; if (usd){ const sol = lamports/1_000_000_000; bestUsdEl.textContent = `≈ $${(sol*usd).toFixed(2)}`; bestUsdEl.style.display=''; } } }
          await refreshOfferButtons();
        } catch (e) {
          showToast((e.message || String(e)), { title: 'Offer failed', variant: 'error' });
        }
      });
      cancelBtn.addEventListener('click', async () => {
        const conn = await connectBackpack(); if (!conn) return;
        try {
          const build = await fetchJSON('/api/offers/tx/cancel', { method: 'POST', body: JSON.stringify({ collectionId: info.id, bidder: conn.publicKey }) });
          const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
          const buf = Uint8Array.from(atob(build.tx), c => c.charCodeAt(0));
          const tx = Transaction.from(buf);
          const signed = await conn.provider.signTransaction(tx);
          const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed');
          const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed' });
          try { await waitForConfirmation(connection, sig, { desired: 'confirmed' }); } catch {}
          showToast('Offer cancelled', { title: 'Cancelled', variant: 'success' });
          try { await fetchJSON('/api/market/activity/offer-cancelled', { method: 'POST', body: JSON.stringify({ collectionId: info.id, bidder: conn.publicKey, ts: Math.floor(Date.now()/1000) }) }); } catch {}
          const bo = await getBestOnchainOffer(info.onchain_pda); if (bo) { bestEl.textContent = `${fmtSOL4(bo.priceLamports)} SOL`; } else { bestEl.textContent = '—'; if (bestUsdEl) bestUsdEl.textContent = ''; }
          await refreshOfferButtons();
        } catch (e) {
          showToast((e.message || String(e)), { title: 'Cancel failed', variant: 'error' });
        }
      });
      toolbar.appendChild(actions);
      refreshOfferButtons();
    }
  } catch {}
  const actWrap = document.getElementById('activityWrap');
  let actData = await activityP;
  const fmtAddr = (a) => a ? `${a.slice(0,6)}...${a.slice(-6)}` : '—';
  const fmtTime = (t) => {
    const ts = Number(t || 0) * 1000; if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  };
  const renderActivity = () => {
    actWrap.innerHTML = '';
    if (!actData.length) { actWrap.innerHTML = '<div class="muted">No activity yet</div>'; return; }
    const table = document.createElement('table');
    table.className = 'table';
    table.innerHTML = `
      <thead><tr><th>Time</th><th>Event</th><th>Mint</th><th>Price</th><th>Actor(s)</th></tr></thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    actData.forEach((e) => {
      const tr = document.createElement('tr');
      if (e.type === 'mint') {
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Mint</span></td><td>${e.mint}</td><td>—</td><td>by ${fmtAddr(e.minter)}</td>`;
      } else if (e.type === 'sale') {
        const sol = Number(e.priceLamports || 0) / 1_000_000_000;
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Sale</span></td><td>${e.mint}</td><td>${sol.toFixed(4)} SOL</td><td>${fmtAddr(e.seller)} → ${fmtAddr(e.buyer)}</td>`;
      } else if (e.type === 'list') {
        const sol = Number(e.priceLamports || 0) / 1_000_000_000;
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">List</span></td><td>${e.mint}</td><td>${sol.toFixed(4)} SOL</td><td>by ${fmtAddr(e.seller)}</td>`;
      } else if (e.type === 'list_cancel') {
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Cancel Listing</span></td><td>${e.mint}</td><td>—</td><td>by ${fmtAddr(e.seller)}</td>`;
      } else if (e.type === 'offer_created') {
        const sol = Number(e.priceLamports || 0) / 1_000_000_000;
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Offer</span></td><td>—</td><td>${sol.toFixed(4)} SOL</td><td>by ${fmtAddr(e.bidder)}</td>`;
      } else if (e.type === 'offer_cancelled') {
        const sol = Number(e.priceLamports || 0) / 1_000_000_000;
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Offer Cancel</span></td><td>—</td><td>${sol.toFixed(4)} SOL</td><td>by ${fmtAddr(e.bidder)}</td>`;
      } else if (e.type === 'offer_accepted') {
        const sol = Number(e.priceLamports || 0) / 1_000_000_000;
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td><span class="pill">Offer Accepted</span></td><td>${e.mint || ''}</td><td>${sol.toFixed(4)} SOL</td><td>${fmtAddr(e.actor1)} → ${fmtAddr(e.actor2)}</td>`;
      } else {
        tr.innerHTML = `<td>${fmtTime(e.ts)}</td><td>${e.type}</td><td>${e.mint || ''}</td><td></td><td></td>`;
      }
      tbody.appendChild(tr);
    });
    actWrap.appendChild(table);
  };

  // Owned tab: NFTs the connected wallet holds; allow accept best on-chain offer
  const ownedWrap = document.getElementById('ownedWrap');
  const renderOwned = async () => {
    ownedWrap.innerHTML = '';
    const conn = await connectBackpack({ silent: true });
    if (!conn) { ownedWrap.innerHTML = '<div class="muted">Connect wallet to see your items.</div>'; return; }
    try {
      const { items } = await fetchJSON(`/api/holdings?owner=${encodeURIComponent(conn.publicKey)}&id=${encodeURIComponent(info.id)}`);
      const ownedItems = Array.isArray(items) ? items : [];
      const hasOwned = ownedItems.length > 0;
      const best = info.onchain_pda ? await getBestOnchainOffer(info.onchain_pda) : null;
      // no need to prefetch mint account; on-chain program validates eligibility

      // Section: Your NFTs (not necessarily listed)
      if (hasOwned) {
        const secTitle = document.createElement('div'); secTitle.className = 'subtitle'; secTitle.textContent = 'Your NFTs';
        ownedWrap.appendChild(secTitle);
        const gridOwned = document.createElement('div'); gridOwned.className = 'grid mt'; ownedWrap.appendChild(gridOwned);

        ownedItems.forEach(async (it) => {
          const el = document.createElement('div'); el.className = 'nft';
        el.innerHTML = `
          <img alt="NFT" loading="lazy" />
          <div class="meta"><strong>${info.name}</strong> <span>(${info.symbol})</span></div>
          <div class="meta"><strong>Mint:</strong> ${it.mint}</div>
          <div class="row gap mt"></div>
        `;
        setImgSrc(el.querySelector('img'), it.image || info.image);
        const row = el.querySelector('.row');
        // Accept button now relies on on-chain validation (Offers v2).
        // Hide/disable if the connected wallet is also the bidder (cannot accept own offer).
        if (best && best.priceLamports > 0 && String(best.bidder) !== String(conn.publicKey)) {
          const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = `Accept ${fmtSOL4(best.priceLamports)} SOL`;
          btn.addEventListener('click', async () => {
            try {
              btn.disabled = true; btn.textContent = 'Accepting…';
              const build = await fetchJSON('/api/offers/tx/accept', { method: 'POST', body: JSON.stringify({ collectionId: info.id, bidder: best.bidder, seller: conn.publicKey, mint: it.mint }) });
              const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
              const buf = Uint8Array.from(atob(build.tx), c => c.charCodeAt(0));
              const tx = Transaction.from(buf);
              const signed = await conn.provider.signTransaction(tx);
              const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed');
              const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed' });
              try { await waitForConfirmation(connection, sig, { desired: 'confirmed' }); } catch {}
              showToast('Offer accepted! SOL received and NFT transferred.', { title: 'Success', variant: 'success' });
              try {
                await fetchJSON('/api/market/activity/offer-accepted', { method: 'POST', body: JSON.stringify({ collectionId: info.id, bidder: best.bidder, seller: conn.publicKey, mint: it.mint, priceLamports: Number(best.priceLamports || 0), ts: Math.floor(Date.now()/1000) }) });
              } catch {}
            } catch (e) {
              showToast((e.message || String(e)), { title: 'Accept failed', variant: 'error' });
            } finally { btn.disabled = false; btn.textContent = `Accept ${fmtSOL4(best.priceLamports)} SOL`; }
          });
          row.appendChild(btn);
        } else {
          const muted = document.createElement('div'); muted.className = 'muted';
          if (!best || best.priceLamports === 0) {
            muted.textContent = 'No on-chain offers yet.';
          } else if (String(best.bidder) === String(conn.publicKey)) {
            muted.textContent = 'Your offer is the best. You cannot accept your own offer.';
          } else {
            muted.textContent = 'Offer available.';
          }
          row.appendChild(muted);
        }
        // List for Sale button (moved from market page)
        const btnList = document.createElement('button'); btnList.className = 'btn btn-ghost'; btnList.textContent = 'List for Sale';
        btnList.addEventListener('click', async (ev) => {
          const prices = await getPrices();
          const usdPerSol = prices.solUsd || null;
          const carvUsd = prices.carvUsd || null;
          const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
          const modal = document.createElement('div'); modal.className = 'modal';
          modal.innerHTML = `
            <div class="title">List for Sale</div>
            <div class="row gap" role="tablist" aria-label="Currency">
              <button class="btn btn-ghost cur cur-sol" role="tab" aria-selected="true">SOL</button>
              <button class="btn btn-ghost cur cur-carv" role="tab" aria-selected="false">CARV</button>
            </div>
            <label class="label" for="listPrice">Enter price (min 0.003 SOL or 1 CARV)</label>
            <input id="listPrice" class="input" type="number" placeholder="0.05" value="0.05" min="0.000000001" step="0.000000001" />
            <div class="hint small muted" style="margin-top:6px"></div>
            <div class="error" role="alert" aria-live="polite" style="display:none"></div>
            <div class="row gap mt right actions">
              <button type="button" class="btn btn-ghost cancel">Cancel</button>
              <button type="button" class="btn confirm">List NFT</button>
            </div>
          `;
          overlay.appendChild(modal); document.body.appendChild(overlay);
          const btnSol = modal.querySelector('.cur-sol');
          const btnCarv = modal.querySelector('.cur-carv');
          const input = modal.querySelector('#listPrice');
          const hint = modal.querySelector('.hint');
          const error = modal.querySelector('.error');
          let useCarv = false;
          const setMode = (carv) => {
            useCarv = !!carv;
            btnSol.setAttribute('aria-selected', String(!useCarv));
            btnCarv.setAttribute('aria-selected', String(useCarv));
            input.placeholder = useCarv ? '8.40' : '0.05';
            renderHint();
          };
          const renderHint = () => {
            const v = Number(String(input.value).trim());
            error.style.display = 'none'; error.textContent = '';
            if (!isFinite(v) || v <= 0) { hint.textContent = ''; return; }
            if (useCarv && carvUsd && usdPerSol) {
              const usd = v * carvUsd; const sol = usd / usdPerSol;
              hint.textContent = `≈ ${sol.toFixed(4)} SOL • ≈ $${usd.toFixed(2)}`;
            } else if (!useCarv && usdPerSol) {
              const usd = v * usdPerSol; let carvTxt = '';
              if (carvUsd) { const carv = usd / carvUsd; carvTxt = ` • ≈ ${carv.toFixed(2)} CARV`; }
              hint.textContent = `≈ $${usd.toFixed(2)}${carvTxt}`;
            } else {
              hint.textContent = '';
            }
          };
          btnSol.addEventListener('click', () => setMode(false));
          btnCarv.addEventListener('click', () => setMode(true));
          input.addEventListener('input', renderHint);
          setMode(false);
          const close = (result) => { overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 160); return result; };
          const awaitResult = () => new Promise((res) => {
            modal.querySelector('.cancel').addEventListener('click', () => res(close(null)));
            modal.querySelector('.confirm').addEventListener('click', () => {
              const v = Number(String(input.value).trim());
              if (!isFinite(v) || v <= 0) { error.textContent = 'Please enter a valid number.'; error.style.display = ''; return; }
              if (!useCarv && v < 0.003) { error.textContent = 'Minimum price is 0.003 SOL.'; error.style.display = ''; return; }
              if (useCarv && v < 1) { error.textContent = 'Minimum price is 1 CARV.'; error.style.display = ''; return; }
              res(close({ useCarv, value: v }));
            });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) res(close(null)); });
            modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') res(close(null)); if (e.key === 'Enter') modal.querySelector('.confirm').click(); });
          });
          const sel = await awaitResult();
          if (!sel) return;
          let currencyMint = null; let priceAmount = null; let priceSol = null;
          if (sel.useCarv) { currencyMint = CARV_MINT; priceAmount = Math.round(sel.value * 1_000_000_000); }
          else { priceSol = sel.value; }
          const btn = ev.target; btn.disabled = true; btn.textContent = 'Listing...';
          try {
            const conn2 = await connectBackpack(); if (!conn2) throw new Error('Wallet not connected');
            const { provider, publicKey: pk } = conn2;
            const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
            const body = currencyMint ? { mint: it.mint, seller: pk, currencyMint, priceAmount } : { mint: it.mint, seller: pk, priceSol };
            const r = await fetchJSON('/api/market/tx/list', { method: 'POST', body: JSON.stringify(body) });
            const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
            const tx = Transaction.from(buf);
            const signed = await provider.signTransaction(tx);
            const { rpc } = await getConfig();
            const connection = new Connection(rpc, 'confirmed');
            const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
            try { await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' }); } catch {}
            const idxBody = currencyMint ? { mint: it.mint, collectionId: info.id, seller: pk, currencyMint, priceAmount } : { mint: it.mint, collectionId: info.id, seller: pk, priceSol };
            await fetchJSON('/api/market/list', { method: 'POST', body: JSON.stringify(idxBody) });
            const t = showToast('Listing created on-chain.<br/>Refreshing in <span id="listRefresh">5</span>s…', { title: 'Listed', variant: 'success', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
            // Refresh items + owned tab
            await Promise.all([
              (async()=>{ const listings = await loadCollectionListings(info.id); const container = document.getElementById('itemsWrap'); if (container) { /* trigger re-render by resetting search */ const s = document.getElementById('itemSearch'); if (s) s.dispatchEvent(new Event('input')); } })(),
              renderOwned()
            ]);
            let n = 5; const span = t?.querySelector?.('#listRefresh'); const timer = setInterval(() => { n -= 1; if (span) span.textContent = String(n); if (n <= 0) { clearInterval(timer); location.reload(); } }, 1000);
          } catch (e) {
            showToast((e.message || String(e)), { title: 'List failed', variant: 'error' });
          } finally { btn.disabled = false; btn.textContent = 'List for Sale'; }
        });
        row.appendChild(btnList);
          gridOwned.appendChild(el);
        });
      } else {
        const msg = document.createElement('div'); msg.className = 'muted'; msg.textContent = 'You do not own items from this collection.'; ownedWrap.appendChild(msg);
      }

      // Listed NFTs moved to separate tab
      try {} catch {}
    } catch (e) {
      ownedWrap.innerHTML = '<div class="muted">Failed to load holdings.</div>';
    }
  };

  // Listed tab: user listings for this collection; allow cancel
  const listedWrap = document.getElementById('listedWrap');
  const renderListed = async () => {
    if (!listedWrap) return;
    listedWrap.innerHTML = '';
    // Use existing provider if already connected; otherwise attempt silent connect
    let provider = getBackpackProvider();
    let pk = provider?.publicKey || null;
    if (!pk) {
      const conn = await connectBackpack({ silent: true });
      provider = conn?.provider || null;
      pk = conn?.publicKey || null;
    }
    if (!pk) { listedWrap.innerHTML = '<div class="muted">Connect wallet to see your listings.</div>'; return; }
    try {
      const qs = new URLSearchParams({ collectionId: info.id, seller: pk });
      const { listings: myListings } = await fetchJSON(`/api/market/listings?${qs.toString()}`);
      if (!Array.isArray(myListings) || !myListings.length) { listedWrap.innerHTML = '<div class="muted">You have no active listings in this collection.</div>'; return; }
      for (const l of myListings) {
        const card = document.createElement('div'); card.className = 'nft';
        const pricesNow = await getPrices().catch(()=>({}));
        const priceHtml = (function(){
          if (l.currencyMint && l.priceAmount != null) {
            const carv = Number(l.priceAmount||0)/1_000_000_000; const usd = pricesNow?.carvUsd?` ($${(carv*pricesNow.carvUsd).toFixed(2)})`:''; return `${carv.toFixed(2)} CARV${usd}`;
          }
          const sol = Number(l.priceLamports||0)/1_000_000_000; const usd = pricesNow?.solUsd?` ($${(sol*pricesNow.solUsd).toFixed(2)})`:''; return `${sol} SOL${usd}`;
        })();
        card.innerHTML = `
          <img alt="NFT" loading="lazy" />
          <div class="meta"><strong>${info.name}</strong> <span>(${info.symbol})</span></div>
          <div class="meta"><strong>Mint:</strong> ${l.mint}</div>
          <div class="meta"><strong>Price:</strong> ${priceHtml}</div>
          <div class="row gap mt">
            <button class="btn" data-id="${l.id}">Cancel</button>
          </div>
        `;
        setImgSrc(card.querySelector('img'), info.image);
        const cancelBtn = card.querySelector('button');
        cancelBtn.addEventListener('click', async (ev) => {
          const btn = ev.target;
          if (!btn.dataset.confirmed) { btn.dataset.confirmed = '1'; const prev = btn.textContent; btn.textContent = 'Click again to Confirm'; setTimeout(()=>{ delete btn.dataset.confirmed; btn.textContent = prev; }, 2500); return; }
          btn.disabled = true; btn.textContent = 'Cancelling...';
          try {
            const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
            const r = await fetchJSON('/api/market/tx/cancel', { method: 'POST', body: JSON.stringify({ mint: l.mint, seller: pk }) });
            const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
            const tx = Transaction.from(buf);
            const prov = getBackpackProvider() || provider || (await connectBackpack())?.provider;
            const signed = await prov.signTransaction(tx);
            const { rpc } = await getConfig();
            const connection = new Connection(rpc, 'confirmed');
            const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
            try { await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' }); } catch {}
            await fetchJSON('/api/market/cancel', { method: 'POST', body: JSON.stringify({ listingId: l.id, seller: pk }) });
            showToast('Listing cancelled', { title: 'Cancelled', variant: 'success' });
            await renderListed();
          } catch (e) {
            showToast((e.message || String(e)), { title: 'Cancel failed', variant: 'error' });
          } finally { btn.disabled = false; btn.textContent = 'Cancel'; }
        });
        listedWrap.appendChild(card);
      }
    } catch (e) {
      listedWrap.innerHTML = '<div class="muted">Failed to load your listings.</div>';
    }
  };

  // Initial render defaults to Items
  renderItems();
  // Wire search
  const search = document.getElementById('itemSearch');
  if (search) search.addEventListener('input', () => renderItems());

  // Tabs
  const tabItems = document.getElementById('tabItems');
  const tabAct = document.getElementById('tabActivity');
  const tabOwned = document.getElementById('tabOwned');
  const tabListed = document.getElementById('tabListed');
  const secItems = document.getElementById('sectionItems');
  const secAct = document.getElementById('sectionActivity');
  const secOwned = document.getElementById('sectionOwned');
  const secListed = document.getElementById('sectionListed');
  const setTab = (name) => {
    const itemsActive = name === 'items';
    const actActive = name === 'activity';
    const ownActive = name === 'owned';
    const listedActive = name === 'listed';
    tabItems.setAttribute('aria-selected', String(itemsActive));
    tabAct.setAttribute('aria-selected', String(actActive));
    tabOwned.setAttribute('aria-selected', String(ownActive));
    tabListed.setAttribute('aria-selected', String(listedActive));
    secItems.classList.toggle('hidden', !itemsActive);
    secAct.classList.toggle('hidden', !actActive);
    secOwned.classList.toggle('hidden', !ownActive);
    secListed.classList.toggle('hidden', !listedActive);
    if (actActive) { (async () => { try { actData = await loadCollectionActivity(info.id); } catch { actData = []; } renderActivity(); })(); }
    if (ownActive) renderOwned();
    if (listedActive) renderListed();
    const search = document.getElementById('itemSearch');
    if (search) search.style.display = itemsActive ? '' : 'none';
  };
  tabItems?.addEventListener('click', () => setTab('items'));
  tabAct?.addEventListener('click', () => setTab('activity'));
  tabOwned?.addEventListener('click', () => setTab('owned'));
  tabListed?.addEventListener('click', () => setTab('listed'));
}

window.addEventListener('DOMContentLoaded', () => {
  renderCollection().catch(console.error);
});
