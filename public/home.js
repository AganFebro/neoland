import { fetchJSON, connectBackpack, setImgSrc } from '/common.js';

async function loadHyped() {
  const wrap = document.getElementById('hypedWrap');
  wrap.innerHTML = '<div class="skeleton block"></div><div class="skeleton text"></div>';
  const { collections } = await fetchJSON('/api/collections');
  if (!collections || collections.length === 0) {
    wrap.innerHTML = '<div class="muted">No collections yet. Deploy one!</div>';
    return;
  }
  // Simple hype metric: highest minted_count (fallback to supply progress)
  const sorted = [...collections].sort((a, b) => (b.minted_count || 0) - (a.minted_count || 0));
  const top = sorted[0];
  const el = document.createElement('div');
  el.className = 'nft';
  const minted = `${top.minted_count || 0}/${top.supply || 0}`;
  el.innerHTML = `
    <img alt="${top.name}" loading="lazy" />
    <div class="meta"><strong>${top.name}</strong> <span>(${top.symbol})</span></div>
    <div class="meta">Minted: ${minted}</div>
    <div class="row gap mt">
      <a class="btn" href="/mint">Mint Now</a>
      <a class="btn btn-ghost" href="/collection">View Collections</a>
    </div>
  `;
  setImgSrc(el.querySelector('img'), top.image);
  wrap.innerHTML = '';
  wrap.appendChild(el);
}

window.addEventListener('DOMContentLoaded', () => {
  loadHyped().catch(console.error);
});
