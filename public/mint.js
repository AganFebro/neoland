import { fetchJSON, connectBackpack, showToast, getConfig, txExplorerUrl, waitForConfirmation, sendAndTrack, setImgSrc } from '/common.js';

const PAGE_SIZE = 6;
const state = { collections: [], solUsd: null, page: 1, filter: '' };

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

async function loadCollections() {
  const wrap = document.getElementById('mintCollections');
  wrap.innerHTML = '<div class="skeleton block"></div><div class="skeleton text"></div>';
  const [{ collections }, priceResp] = await Promise.all([
    fetchJSON('/api/collections'),
    fetch('/api/sol-price').then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  state.solUsd = typeof priceResp.usd === 'number' ? priceResp.usd : null;
  const visible = (collections || []).filter((c) => {
    const sup = Number(c.supply || 0);
    const minted = Number(c.minted_count || 0);
    return !(sup > 0 && minted >= sup); // hide sold-out
  });
  state.collections = visible;
  renderMint();
}

function renderMint() {
  const wrap = document.getElementById('mintCollections');
  const pager = document.getElementById('mintPager');
  wrap.innerHTML = '';
  const q = (state.filter || '').toLowerCase();
  const filtered = state.collections.filter(c => !q || (c.name || '').toLowerCase().includes(q) || (c.symbol || '').toLowerCase().includes(q));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page || 1), totalPages);
  const start = (state.page - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  slice.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'nft';
    el.innerHTML = `
      <img alt="${c.name}" loading="lazy" />
      <div class="meta"><strong>${c.name}</strong> <span>(${c.symbol})</span></div>
      <div class="meta">Price: ${(c.priceLamports || 0) / 1_000_000_000} SOL ${state.solUsd ? `(\$${(((c.priceLamports||0)/1_000_000_000)*state.solUsd).toFixed(2)})` : ''}</div>
      <div class="meta">Minted: ${c.minted_count || 0}/${c.supply || 0}</div>
      <div class="row gap mt">
        <button class="btn" data-id="${c.id}">Mint to Me</button>
      </div>
    `;
    setImgSrc(el.querySelector('img'), c.image);
    el.querySelector('button').onclick = (ev) => handleMintClientTx(ev, c.id);
    wrap.appendChild(el);
  });
  const anchor = document.getElementById('mintCollections');
  renderPager(pager, totalPages, state.page, (p) => {
    state.page = p;
    renderMint();
    anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function handleMintClientTx(ev, id) {
  const conn = await connectBackpack();
  if (!conn) return;
  const { publicKey, provider } = conn;
  const btn = ev?.target; if (btn) { btn.disabled = true; btn.textContent = 'Minting...'; }
  try {
    const { Keypair, Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    const mint = Keypair.generate();
    const r = await fetchJSON('/api/tx/mint-nft', {
      method: 'POST',
      body: JSON.stringify({ id, payer: publicKey, mintPubkey: mint.publicKey.toBase58() }),
    });
    const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
    const tx = Transaction.from(buf);
    tx.partialSign(mint);
    const signed = await provider.signTransaction(tx);
    const { rpc } = await getConfig();
    const connection = new Connection(rpc, 'confirmed');
    const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
    try {
      await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' });
    } catch (e) {
      // Surface a non-fatal toast if network is slow
      showToast('Network slow to confirm. Check explorer.', { title: 'Pending', variant: 'info', actions: [ { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
    }
    await fetchJSON('/api/record-mint', { method: 'POST', body: JSON.stringify({ id, mint: mint.publicKey.toBase58(), minter: publicKey, ts: Math.floor(Date.now()/1000) }) });
    const short = `${sig.slice(0, 6)}...${sig.slice(-6)}`;
    showToast(`Tx: ${short}`, {
      title: 'Minted! 🎉',
      variant: 'success',
      actions: [
        { label: 'Copy Tx', onClick: () => navigator.clipboard?.writeText(sig) },
        { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') },
      ],
    });
    await loadCollections();
  } catch (e) {
    console.error(e);
    showToast((e.message || String(e)), { title: 'Mint failed', variant: 'error', duration: 7000 });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Mint to Me'; }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('mintSearch');
  if (search) search.addEventListener('input', (e) => { state.filter = e.target.value || ''; state.page = 1; renderMint(); document.getElementById('mintCollections')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  loadCollections().catch(console.error);
});
