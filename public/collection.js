import { fetchJSON, connectBackpack, showToast, setImgSrc } from '/common.js';

async function renderHoldings(publicKey) {
  const wrap = document.getElementById('holdingsWrap');
  wrap.innerHTML = '<div class="skeleton block"></div><div class="skeleton text"></div>';
  try {
    const { items } = await fetchJSON(`/api/holdings-all?owner=${publicKey}`);
    if (!items || items.length === 0) {
      wrap.innerHTML = '<div class="muted">No NFTs found in your wallet</div>';
      return;
    }
    // Group by collectionId
    const byColl = new Map();
    for (const it of items) {
      const k = it.collectionId || it.symbol || it.name || 'unknown';
      const cur = byColl.get(k) || { id: it.collectionId, name: it.name, symbol: it.symbol, image: it.image, count: 0 };
      cur.count += 1;
      if (!cur.image && it.image) cur.image = it.image;
      byColl.set(k, cur);
    }

    // Fetch floors and SOL price
    const entries = [...byColl.values()];
    const floors = await Promise.all(entries.map(async (e) => {
      try { const r = await fetchJSON(`/api/market/stats?collectionId=${encodeURIComponent(e.id)}`); return r.floorLamports ?? null; } catch { return null; }
    }));
    let solUsd = null; try { const q = await fetchJSON('/api/sol-price'); if (typeof q.usd === 'number') solUsd = q.usd; } catch {}

    // Compute portfolio value
    let totalLamports = 0;
    floors.forEach((f, i) => { if (f != null) totalLamports += f * (entries[i].count || 0); });
    const totalSol = totalLamports / 1_000_000_000;
    const pv = document.getElementById('portfolioValue');
    if (pv) pv.textContent = `Portfolio: ${totalSol.toFixed(4)} SOL${solUsd ? ` ($${(totalSol*solUsd).toFixed(2)})` : ''}`;

    // Render grouped cards
    wrap.innerHTML = '';
    entries.forEach((e, idx) => {
      const el = document.createElement('div');
      el.className = 'nft';
      el.innerHTML = `
        <img alt="${e.name}" loading="lazy" />
        <div class="meta"><strong>${e.name}</strong> <span>(${e.symbol})</span></div>
        <div class="meta"><strong>Owned:</strong> ${e.count}</div>
        <div class="meta"><strong>Floor:</strong> ${floors[idx] != null ? (floors[idx]/1_000_000_000).toFixed(4) + ' SOL' : '—'} ${floors[idx] != null && solUsd ? `($${((floors[idx]/1_000_000_000)*solUsd).toFixed(2)})` : ''}</div>
      `;
    const img = el.querySelector('img');
    setImgSrc(img, e.image);
    wrap.appendChild(el);
    });
  } catch (e) {
    console.error(e);
    wrap.innerHTML = '<div class="muted">Failed to load holdings</div>';
  }
}

async function init() {
  const callout = document.getElementById('holdingsCallout');
  const connectBtn = document.getElementById('connectForHoldings');
  const conn = await connectBackpack({ silent: true });
  if (conn) {
    if (callout) callout.style.display = 'none';
    if (connectBtn) connectBtn.style.display = 'none';
    await renderHoldings(conn.publicKey);
  } else {
    if (connectBtn) connectBtn.addEventListener('click', async () => {
      const c = await connectBackpack();
      if (c) {
        if (callout) callout.style.display = 'none';
        connectBtn.style.display = 'none';
        await renderHoldings(c.publicKey);
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch(console.error);
});
