import { fetchJSON, connectBackpack, setImgSrc, renderUpdates, setupCollapsible } from '/common.js';

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

async function loadHyped() {
  const wrap = document.getElementById('hypedWrap');
  wrap.innerHTML = '<div class="skeleton block"></div><div class="skeleton text"></div>';
  const { collections } = await fetchJSON('/api/collections');
  if (!collections || collections.length === 0) {
    wrap.innerHTML = '<div class="muted">No collections yet. Deploy one!</div>';
    return;
  }
  // Simple hype metric: highest minted_count; show top 3
  const sorted = [...collections].sort((a, b) => (b.minted_count || 0) - (a.minted_count || 0));
  const top3 = sorted.slice(0, 3);
  wrap.innerHTML = '';
  top3.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'nft';
    const minted = `${c.minted_count || 0}/${c.supply || 0}`;
    const slug = slugify(c.name || c.symbol || c.id);
    const collPath = `/mint/${slug}-${c.id}`;
    const marketPath = `/market/${slug}-${c.id}`;
    el.innerHTML = `
      <img alt="${c.name}" loading="lazy" />
      <div class="meta"><strong>${c.name}</strong> <span>(${c.symbol})</span></div>
      <div class="meta">Minted: ${minted}</div>
      <div class="row gap mt">
        <a class="btn" href="${collPath}">Mint Now</a>
        <a class="btn btn-ghost" href="${marketPath}">View Market</a>
      </div>
    `;
    setImgSrc(el.querySelector('img'), c.image);
    wrap.appendChild(el);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadHyped().catch(console.error);
  renderUpdates('#updatesWrap', { limit: 3 }).catch(console.error);
  setupCollapsible({ button: '#updatesToggle', panel: '#updatesPanel', open: false });
});
