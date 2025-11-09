import { fetchJSON, connectBackpack, getConfig, sendAndTrack, waitForConfirmation, setImgSrc, showToast } from '/common.js';

const CARV_MINT = 'D7WVEw9Pkf4dfCCE3fwGikRCCTvm9ipqTYPHRENLiw3s';
let __prices = null;
async function getPrices() {
  try {
    if (!__prices || Date.now() - __prices._ts > 60000) {
      const p = await fetchJSON('/api/prices');
      __prices = { ...p, _ts: Date.now() };
    }
  } catch { __prices = { solUsd: null, carvUsd: null, carvPerSol: null, _ts: Date.now() }; }
  return __prices;
}

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function fmtSOL(l) { return (Number(l || 0) / 1_000_000_000).toString(); }
function fmtSOL4(l) { const n = Number(l||0)/1_000_000_000; return (Math.round(n*10000)/10000).toFixed(4); }
const state = { currency: 'SOL' };

async function getCollectionFromPath() {
  const segs = location.pathname.split('/').filter(Boolean);
  const seg = segs[1]; // /mint/<slug>-<id>
  let slug = seg || '';
  let idFromPath = '';
  if (slug.includes('~')) { const parts = slug.split('~'); idFromPath = parts.pop(); slug = parts.join('~'); }
  else if (slug.includes('-')) { const i = slug.lastIndexOf('-'); if (i > 0) { idFromPath = slug.slice(i + 1); slug = slug.slice(0, i); } }
  const qid = new URLSearchParams(location.search).get('id') || idFromPath;
  const { collections } = await fetchJSON('/api/collections');
  let coll = null;
  if (qid) coll = collections.find(c => c.id === qid);
  if (!coll) coll = collections.find(c => slugify(c.name || c.symbol || c.id) === slug);
  return coll;
}

async function loadActivity(collectionId) {
  try { const { events } = await fetchJSON(`/api/market/activity?collectionId=${encodeURIComponent(collectionId)}`); return Array.isArray(events) ? events : []; }
  catch { return []; }
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
      const price = Number(d.readBigUInt64LE(8 + 32 + 32));
      if (!best || price > best.priceLamports) best = { priceLamports: price };
    }
    return best;
  } catch { return null; }
}

function renderList(into, rows, kind, prices) {
  into.innerHTML = '';
  if (!rows.length) { into.innerHTML = '<div class="muted">No data</div>'; return; }
  const table = document.createElement('table'); table.className = 'table';
  table.innerHTML = `<thead><tr><th>${kind === 'mint' ? 'Minter' : 'Buyer'}</th><th>Item</th><th>${kind === 'mint' ? 'Time' : 'Price'}</th><th>${kind === 'mint' ? '' : 'Time'}</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  const fmtAddr = (a) => a ? `${a.slice(0,6)}...${a.slice(-6)}` : '—';
  const fmtTime = (t) => { const ts = Number(t||0)*1000; try { return ts ? new Date(ts).toLocaleString() : ''; } catch { return ''; } };
  rows.forEach((e) => {
    const tr = document.createElement('tr');
    if (kind === 'mint') {
      tr.innerHTML = `<td>${fmtAddr(e.minter)}</td><td>${e.mint}</td><td colspan="2">${fmtTime(e.ts)}</td>`;
    } else {
      const sol = Number(e.priceLamports || 0) / 1_000_000_000;
      let usd = '';
      try { const s = Number(prices?.solUsd || 0); if (s) usd = ` (<span class="usd">$${(sol*s).toFixed(2)}</span>)`; } catch {}
      tr.innerHTML = `<td>${fmtAddr(e.buyer)}</td><td>${e.mint}</td><td>${sol.toFixed(4)} SOL${usd}</td><td>${fmtTime(e.ts)}</td>`;
    }
    tbody.appendChild(tr);
  });
  into.appendChild(table);
}

async function mintOne(id, coll, btn) {
  // Enforce client-side window guard
  try {
    const now = Math.floor(Date.now()/1000);
    const s = coll?.mintStartTs != null ? Number(coll.mintStartTs) : null;
    const e = coll?.mintEndTs != null ? Number(coll.mintEndTs) : null;
    if (s != null && now < s) { showToast('Mint has not started yet', { title: 'Too early', variant: 'error' }); return; }
    if (e != null && now > e) { showToast('Mint is closed', { title: 'Ended', variant: 'error' }); return; }
  } catch {}
  const conn = await connectBackpack(); if (!conn) return;
  const { publicKey, provider } = conn;
  if (btn) { btn.disabled = true; btn.textContent = 'Minting...'; }
  try {
    const { Transaction, Connection, Keypair } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    let sig, mintAddr;
    if (state.currency === 'SOL') {
      try {
        const r2 = await fetchJSON('/api/tx/program-mint', { method: 'POST', body: JSON.stringify({ id, payer: publicKey, recipient: publicKey, nonce: Date.now(), lock: true }) });
        const buf2 = Uint8Array.from(atob(r2.tx), c => c.charCodeAt(0));
        const tx2 = Transaction.from(buf2);
        const signed2 = await provider.signTransaction(tx2);
        const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed');
        sig = await sendAndTrack(connection, signed2.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
        mintAddr = r2.mint;
      } catch (err) {
        const mint = Keypair.generate();
        const r = await fetchJSON('/api/tx/mint-nft', { method: 'POST', body: JSON.stringify({ id, payer: publicKey, mintPubkey: mint.publicKey.toBase58() }) });
        const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
        const tx = Transaction.from(buf); tx.partialSign(mint);
        const signed = await provider.signTransaction(tx);
        const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed');
        sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
        mintAddr = mint.publicKey.toBase58();
      }
    } else {
      const mint = Keypair.generate();
      const r = await fetchJSON('/api/tx/mint-nft', { method: 'POST', body: JSON.stringify({ id, payer: publicKey, mintPubkey: mint.publicKey.toBase58(), currencyMint: CARV_MINT }) });
      const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
      const tx = Transaction.from(buf); tx.partialSign(mint);
      const signed = await provider.signTransaction(tx);
      const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed');
      sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
      mintAddr = mint.publicKey.toBase58();
    }
    try { const { Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0'); const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed'); await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' }); } catch {}
    await fetchJSON('/api/record-mint', { method: 'POST', body: JSON.stringify({ id, mint: mintAddr, minter: publicKey, ts: Math.floor(Date.now()/1000) }) });
    showToast('Minted!', { title: 'Success', variant: 'success' });
    return true;
  } catch (e) {
    showToast((e.message || String(e)), { title: 'Mint failed', variant: 'error' });
    return false;
  } finally { if (btn) { btn.disabled = false; btn.textContent = 'Mint'; } }
}

async function renderPage() {
  const info = await getCollectionFromPath();
  const hero = document.getElementById('heroImg');
  const mintedThumbs = document.getElementById('mintedThumbs');
  const liveMints = document.getElementById('liveMints');
  const liveSales = document.getElementById('liveSales');
  const qtyEl = document.getElementById('qty');
  const btnMint = document.getElementById('mintNow');
  if (!info) {
    document.getElementById('collTitle').textContent = 'Collection not found';
    return;
  }
  document.getElementById('collTitle').textContent = `${info.name} (${info.symbol})`;
  document.getElementById('collMeta').textContent = `${info.id}`;
  const ownerEl = document.getElementById('collOwner');
  if (ownerEl && info.owner) {
    const short = `${info.owner.slice(0,6)}...${info.owner.slice(-6)}`;
    ownerEl.textContent = `Deployer: ${short}`;
    ownerEl.title = info.owner;
  }
  // Link to market page for this collection
  try {
    const link = document.getElementById('viewMarketBtn');
    if (link) link.href = `/market/${slugify(info.name || info.symbol || info.id)}-${info.id}`;
  } catch {}
  document.getElementById('mintTitle').textContent = `Mint ${info.name}`;
  setImgSrc(hero, info.image);

  // Stats
  let stats = { floorLamports: null, vol24hLamports: 0, totalVolumeLamports: 0 };
  try { stats = await fetchJSON(`/api/market/stats?collectionId=${encodeURIComponent(info.id)}`); } catch {}
  const prices = await getPrices();
  const usdPerSol = Number(prices?.solUsd || 0) || null;
  const cps = Number(prices?.carvPerSol || 0) || null;
  const setUsdPrimary = (elVal, elSub, lamports) => {
    if (!elVal || lamports == null) { if (elVal) elVal.textContent='—'; if (elSub) elSub.textContent=''; return; }
    const solAmt = lamports/1_000_000_000;
    const usdTxt = usdPerSol ? `$${(solAmt*usdPerSol).toFixed(2)}` : '—';
    const sub = `${solAmt.toFixed(4)} SOL${cps?` • ≈ ${(solAmt*cps).toFixed(2)} CARV`:''}`;
    elVal.textContent = usdTxt;
    if (elSub) { elSub.textContent = sub; elSub.style.display=''; }
  };
  setUsdPrimary(document.getElementById('statFloor'), document.getElementById('statFloorUsd'), stats.floorLamports);
  setUsdPrimary(document.getElementById('statVol24'), document.getElementById('statVol24Usd'), stats.vol24hLamports);
  setUsdPrimary(document.getElementById('statVolTotal'), document.getElementById('statVolTotalUsd'), stats.totalVolumeLamports);
  try {
    const best = await getBestOnchainOffer(info.onchain_pda);
    const bestEl = document.getElementById('statOffer'); const bestUsdEl = document.getElementById('statOfferUsd');
    if (best) {
      const solAmt = Number(best.priceLamports||0)/1_000_000_000;
      bestEl.textContent = usdPerSol ? `$${(solAmt*usdPerSol).toFixed(2)}` : `${solAmt.toFixed(4)} SOL`;
      if (bestUsdEl) bestUsdEl.textContent = `${solAmt.toFixed(4)} SOL${cps?` • ≈ ${(solAmt*cps).toFixed(2)} CARV`:''}`;
    } else { bestEl.textContent = '—'; if (bestUsdEl) bestUsdEl.textContent=''; }
  } catch {}

  // Price + minted count
  const priceRow = document.getElementById('priceRow');
  const lamports = Number(info.priceLamports || 0);
  const sol = lamports / 1_000_000_000;
  const usd = Number(prices?.solUsd || 0);
  const carvPerSol = Number(prices?.carvPerSol || 0);
  const carv = carvPerSol ? sol * carvPerSol : null;
  const minted = Number(info.minted_count || 0); const supply = Number(info.supply || 0);
  // Update minted counter
  const mintedEl = document.getElementById('mintedCount');
  if (mintedEl) mintedEl.textContent = `Items minted: ${minted}${supply ? ` / ${supply}` : ''}`;
  const renderPrice = () => {
    if (lamports === 0) { priceRow.innerHTML = `<strong>Price:</strong> Free`; return; }
    const solTxt = `${sol} SOL`;
    const carvTxt = carv != null ? ` • ≈ ${carv.toFixed(2)} CARV` : '';
    const usdTxt = usd ? ` • ≈ $${(sol*usd).toFixed(2)}` : '';
    priceRow.innerHTML = `<strong>Price:</strong> ${solTxt}${carvTxt}${usdTxt}`;
  };
  renderPrice();

  // Currency toggle
  const paySOL = document.getElementById('paySOL');
  const payCARV = document.getElementById('payCARV');
  const applyToggle = () => {
    if (state.currency === 'SOL') { if (paySOL) paySOL.className = 'btn'; if (payCARV) payCARV.className = 'btn btn-ghost'; }
    else { if (paySOL) paySOL.className = 'btn btn-ghost'; if (payCARV) payCARV.className = 'btn'; }
    renderPrice();
  };
  paySOL?.addEventListener('click', () => { state.currency = 'SOL'; applyToggle(); });
  payCARV?.addEventListener('click', () => { state.currency = 'CARV'; applyToggle(); });
  applyToggle();

  // Mint window note + disable
  try {
    const note = document.getElementById('mintWindowNote');
    const now = Math.floor(Date.now()/1000);
    const s = info.mintStartTs != null ? Number(info.mintStartTs) : null;
    const e = info.mintEndTs != null ? Number(info.mintEndTs) : null;
    const fmt = (t) => t ? new Date(t*1000).toLocaleString() : '';
    if (s != null || e != null) {
      if (s != null && now < s) { if (note) note.textContent = `Opens at ${fmt(s)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`; if (btnMint) btnMint.disabled = true; }
      else if (e != null && now > e) { if (note) note.textContent = `Mint closed at ${fmt(e)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`; if (btnMint) btnMint.disabled = true; }
      else { if (note) note.textContent = s != null ? `Open until ${fmt(e)}` : ''; }
    }
  } catch {}

  // Thumbs of current mints (if any)
  try {
    const { minted: mintedList } = await fetchJSON(`/api/minted?id=${encodeURIComponent(info.id)}`);
    (mintedList || []).slice(0, 6).forEach(() => {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = 'NFT';
      setImgSrc(img, info.image);
      mintedThumbs.appendChild(img);
    });
  } catch {}

  // Quantity controls (single mint logic; UI only)
  let qty = 1; const setQty = (n) => { qty = Math.max(1, Math.min(10, Number(n)||1)); qtyEl.textContent = String(qty); };
  document.getElementById('qtyMinus')?.addEventListener('click', () => setQty(qty-1));
  document.getElementById('qtyPlus')?.addEventListener('click', () => setQty(qty+1));

  btnMint?.addEventListener('click', async () => {
    const btn = btnMint; btn.disabled = true; btn.textContent = 'Minting...';
    try {
      // Mint window check (client)
      try {
        const now = Math.floor(Date.now()/1000);
        const s = info.mintStartTs != null ? Number(info.mintStartTs) : null;
        const e = info.mintEndTs != null ? Number(info.mintEndTs) : null;
        if (s != null && now < s) { showToast('Mint has not started yet', { title: 'Too early', variant: 'error' }); return; }
        if (e != null && now > e) { showToast('Mint is closed', { title: 'Ended', variant: 'error' }); return; }
      } catch {}
      // Supply check before any build
      const supply = Number(info.supply || 0);
      const mintedSoFar = Number(info.minted_count || 0);
      const remaining = supply ? Math.max(0, supply - mintedSoFar) : Number.POSITIVE_INFINITY;
      if (supply && qty > remaining) {
        showToast(`Only ${remaining} item(s) remaining`, { title: 'Not enough supply', variant: 'error' });
        return;
      }

      if (qty <= 1) {
        await mintOne(info.id, info, btn);
      } else {
        // Batch mint in one TX
        const { Transaction, Connection, Keypair } = await import('https://esm.sh/@solana/web3.js@1.98.0');
        const conn = await connectBackpack(); if (!conn) return;
        const { publicKey, provider } = conn;
        // Ask server for max batch-per-tx
        const est = await fetchJSON('/api/tx/mint-nft-batch-estimate', { method: 'POST', body: JSON.stringify({ id: info.id, payer: publicKey, want: qty, currencyMint: state.currency === 'CARV' ? CARV_MINT : null }) });
        const maxPerTx = Math.max(1, Math.min(Number(est.max || 1), qty));
        let left = qty;
        let totalMintedNow = 0;
        while (left > 0) {
          const take = Math.min(maxPerTx, left);
          const mints = Array.from({ length: take }, () => Keypair.generate());
          const body = { id: info.id, payer: publicKey, mintPubkeys: mints.map(m => m.publicKey.toBase58()) };
          if (state.currency === 'CARV') body.currencyMint = CARV_MINT;
          const r = await fetchJSON('/api/tx/mint-nft-batch', { method: 'POST', body: JSON.stringify(body) });
          const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
          const tx = Transaction.from(buf);
          mints.forEach((k) => tx.partialSign(k));
          const signed = await provider.signTransaction(tx);
          const { rpc } = await getConfig(); const connection = new Connection(rpc, 'confirmed');
          const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
          try { await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' }); } catch {}
          const ts = Math.floor(Date.now()/1000);
          for (const k of mints) {
            try { await fetchJSON('/api/record-mint', { method: 'POST', body: JSON.stringify({ id: info.id, mint: k.publicKey.toBase58(), minter: publicKey, ts }) }); } catch {}
          }
          totalMintedNow += take;
          left -= take;
        }
        showToast(`Minted ${totalMintedNow} item(s)!`, { title: 'Success', variant: 'success' });
      }
    } catch (e) {
      showToast((e.message || String(e)), { title: 'Mint failed', variant: 'error' });
    } finally { btn.disabled = false; btn.textContent = 'Mint'; }
    const events = await loadActivity(info.id); const prices = await getPrices();
    renderList(liveMints, events.filter(e=>e.type==='mint'), 'mint', prices);
  });

  // Live activity
  const events = await loadActivity(info.id);
  renderList(liveMints, events.filter(e=>e.type==='mint'), 'mint', prices);
  if (liveSales) renderList(liveSales, events.filter(e=>e.type==='sale'), 'sale', prices);
}

window.addEventListener('DOMContentLoaded', () => { renderPage().catch(console.error); });
