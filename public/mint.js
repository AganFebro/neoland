import { fetchJSON, connectBackpack, showToast, getConfig, txExplorerUrl, waitForConfirmation, sendAndTrack, setImgSrc } from '/common.js';

const PAGE_SIZE = 6;
const CARV_MINT = 'D7WVEw9Pkf4dfCCE3fwGikRCCTvm9ipqTYPHRENLiw3s';
const state = { collections: [], solUsd: null, carvUsd: null, carvPerSol: null, page: 1, filter: '' };

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

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

async function loadCollections() {
  const wrap = document.getElementById('mintCollections');
  wrap.innerHTML = '<div class="skeleton block"></div><div class="skeleton text"></div>';
  const [{ collections }, priceResp, prAll] = await Promise.all([
    fetchJSON('/api/collections'),
    fetch('/api/sol-price').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    fetch('/api/prices').then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  state.solUsd = typeof priceResp.usd === 'number' ? priceResp.usd : null;
  if (typeof prAll.solUsd === 'number') state.solUsd = prAll.solUsd;
  if (typeof prAll.carvUsd === 'number') state.carvUsd = prAll.carvUsd;
  if (typeof prAll.carvPerSol === 'number') state.carvPerSol = prAll.carvPerSol;
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
    const lamports = Number(c.priceLamports || 0);
    const sol = lamports / 1_000_000_000;
    const usdTxt = state.solUsd ? `• ≈ $${(sol * state.solUsd).toFixed(2)}` : '';
    const carvTxt = state.carvPerSol ? `• ≈ ${(sol * state.carvPerSol).toFixed(2)} CARV` : '';
    const priceText = lamports <= 0 ? 'Free' : `${sol} SOL ${carvTxt ? carvTxt : ''} ${usdTxt ? usdTxt : ''}`.replace(/\s+/g,' ').trim();
    el.innerHTML = `
      <a class="block" href="/mint/${slugify(c.name || c.symbol || c.id)}-${c.id}"><img alt="${c.name}" loading="lazy" /></a>
      <div class="meta"><a href="/mint/${slugify(c.name || c.symbol || c.id)}-${c.id}"><strong>${c.name}</strong></a> <span>(${c.symbol})</span></div>
      <div class="meta">Price: ${priceText}</div>
      <div class="meta">Minted: ${c.minted_count || 0}/${c.supply || 0}</div>
      <div class="row gap mt">
        <a class="btn" href="/mint/${slugify(c.name || c.symbol || c.id)}-${c.id}">Details</a>
      </div>
    `;
    setImgSrc(el.querySelector('img'), c.image);
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
    const { Transaction, Connection, Keypair } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    let sig, mintAddr;
    try {
      // Try program mint first (locks metadata, owner authority)
      const r2 = await fetchJSON('/api/tx/program-mint', { method: 'POST', body: JSON.stringify({ id, payer: publicKey, recipient: publicKey, nonce: Date.now(), lock: true }) });
      const buf2 = Uint8Array.from(atob(r2.tx), c => c.charCodeAt(0));
      const tx2 = Transaction.from(buf2);
      const signed2 = await provider.signTransaction(tx2);
      const { rpc } = await getConfig();
      const connection = new Connection(rpc, 'confirmed');
      sig = await sendAndTrack(connection, signed2.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
      mintAddr = r2.mint;
    } catch (err) {
      // Fallback to legacy flow
      const mint = Keypair.generate();
      // Choose currency: default SOL; offer CARV based on live rates
      let currencyMint = null;
      try {
        const p = await fetch('/api/prices').then(r => r.ok ? r.json() : {});
        const solUsd = typeof p.solUsd === 'number' ? p.solUsd : null;
        const carvUsd = typeof p.carvUsd === 'number' ? p.carvUsd : null;
        if (solUsd && carvUsd) {
          const coll = state.collections.find((x) => x.id === id);
          const sol = Number(coll?.priceLamports || 0) / 1_000_000_000;
          const usd = sol * solUsd;
          const carv = usd / carvUsd;
          const ok = window.confirm(`Pay with CARV instead of SOL?\n≈ ${carv.toFixed(2)} CARV`);
          if (ok) currencyMint = CARV_MINT;
        }
      } catch {}
      const r = await fetchJSON('/api/tx/mint-nft', { method: 'POST', body: JSON.stringify({ id, payer: publicKey, mintPubkey: mint.publicKey.toBase58(), currencyMint }) });
      const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
      const tx = Transaction.from(buf);
      tx.partialSign(mint);
      const signed = await provider.signTransaction(tx);
      const { rpc } = await getConfig();
      const connection = new Connection(rpc, 'confirmed');
      sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
      mintAddr = mint.publicKey.toBase58();
    }
    try {
      const { rpc } = await getConfig();
      const connection = new Connection(rpc, 'confirmed');
      await waitForConfirmation(connection, sig, { timeoutMs: 90000, desired: 'confirmed' });
    } catch {}
    await fetchJSON('/api/record-mint', { method: 'POST', body: JSON.stringify({ id, mint: mintAddr, minter: publicKey, ts: Math.floor(Date.now()/1000) }) });
    const short = `${sig.slice(0, 6)}...${sig.slice(-6)}`;
    showToast(`Tx: ${short}`, { title: 'Minted! 🎉', variant: 'success', actions: [ { label: 'Copy Tx', onClick: () => navigator.clipboard?.writeText(sig) }, { label: 'View on Explorer', onClick: async () => window.open(await txExplorerUrl(sig), '_blank') } ] });
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
