// Minimal Backpack connector + simple API hooks
let wallet = { provider: null, publicKey: null };

function getBackpackProvider() {
  if (window?.backpack) return window.backpack;
  if (window?.solana && window.solana.isBackpack) return window.solana;
  return null;
}

async function connectBackpack() {
  const provider = getBackpackProvider();
  if (!provider) {
    alert('Backpack not detected. Please install the Backpack extension.');
    return;
  }
  try {
    await provider.connect();
    const pk = provider.publicKey?.toString?.() || provider.publicKey;
    wallet = { provider, publicKey: pk };
    document.getElementById('connectBtn').textContent = pk.slice(0, 6) + '...' + pk.slice(-6);
    document.getElementById('connectBtn').classList.add('btn-ghost');
  } catch (e) {
    console.error('Connect error', e);
    alert('Failed to connect to Backpack');
  }
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function loadCollections() {
  const { collections } = await fetchJSON('/api/collections');
  let solUsd = null;
  try { const r = await fetch('/api/sol-price'); if (r.ok) { const j = await r.json(); if (typeof j.usd === 'number') solUsd = j.usd; } } catch {}
  // Mint cards
  const mintWrap = document.getElementById('mintCollections');
  mintWrap.innerHTML = '';
  collections.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'nft';
    el.innerHTML = `
      <img src="${c.image || ''}" alt="${c.name}" onerror="this.style.display='none'" />
      <div class="meta"><strong>${c.name}</strong> <span>(${c.symbol})</span></div>
      <div class="meta">Price: ${(c.priceLamports || 0) / 1_000_000_000} SOL ${solUsd ? `(\$${(((c.priceLamports||0)/1_000_000_000)*solUsd).toFixed(2)})` : ''}</div>
      <div class="meta">Minted: ${c.minted_count || 0}/${c.supply || 0}</div>
      <div class="row gap mt">
        <button class="btn" data-id="${c.id}">Mint to Me</button>
      </div>
    `;
    el.querySelector('button').onclick = () => handleMintClientTx(c.id);
    mintWrap.appendChild(el);
  });

  // Checker dropdown
  const sel = document.getElementById('checkerCollection');
  sel.innerHTML = '';
  collections.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = `${c.name} (${c.symbol})`;
    sel.appendChild(o);
  });
}

// Build a server-prepared, client-signed mint tx
async function handleMintClientTx(id) {
  if (!wallet.publicKey) {
    alert('Connect Backpack first');
    return;
  }
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Minting...'; }
  try {
    // Generate mint keypair in-browser
    const { Keypair, PublicKey, Transaction } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    const mint = Keypair.generate();
    const r = await fetchJSON('/api/tx/mint-nft', {
      method: 'POST',
      body: JSON.stringify({ id, payer: wallet.publicKey, mintPubkey: mint.publicKey.toBase58() }),
    });
    const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
    const tx = Transaction.from(buf);
    // Sign with mint key locally
    tx.partialSign(mint);
    // Sign with wallet
    const signed = await wallet.provider.signTransaction(tx);
    const connection = new (await import('https://esm.sh/@solana/web3.js@1.98.0')).Connection((window.SOLANA_RPC) || 'https://rpc.testnet.carv.io/rpc', 'confirmed');
    const raw = signed.serialize();
    const sig = await connection.sendRawTransaction(raw, { maxRetries: 20, preflightCommitment: 'confirmed' });
    // Poll for confirmation up to 90s without throwing hard at 30s
    const start = Date.now();
    while (Date.now() - start < 90000) {
      const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const v = st.value?.[0];
      if (v?.err) throw new Error('Transaction failed');
      const cs = v?.confirmationStatus;
      if (cs === 'confirmed' || cs === 'finalized') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    alert(`Minted! Tx: ${sig}`);
    // Record on server for simple holdings UI
    await fetchJSON('/api/record-mint', { method: 'POST', body: JSON.stringify({ id, mint: mint.publicKey.toBase58() }) });
    await loadCollections();
  } catch (e) {
    console.error(e);
    alert('Mint failed: ' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Mint to Me'; }
  }
}

async function handleCheck() {
  const id = document.getElementById('checkerCollection').value;
  const wrap = document.getElementById('checkerResults');
  wrap.innerHTML = '';
  try {
    const { minted, image } = await fetchJSON(`/api/minted?id=${encodeURIComponent(id)}`);
    if (!minted || minted.length === 0) {
      wrap.innerHTML = '<div class="muted">No mints yet for this collection</div>';
      return;
    }
    minted.forEach((mintAddr) => {
      const el = document.createElement('div');
      el.className = 'nft';
      el.innerHTML = `
        <img src="${image || ''}" alt="NFT" onerror="this.style.display='none'" />
        <div class="meta"><strong>Mint</strong>: ${mintAddr}</div>
      `;
      wrap.appendChild(el);
    });
  } catch (e) {
    console.error(e);
    wrap.innerHTML = '<div class="muted">Error fetching holdings</div>';
  }
}

document.getElementById('connectBtn').addEventListener('click', connectBackpack);
document.getElementById('checkBtn').addEventListener('click', handleCheck);

loadCollections().catch(console.error);

// Deploy form handling: uploads to Pinata (via server) and adds config, then mints 1/1 via wallet
document.getElementById('deployForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!wallet.publicKey) { alert('Connect Backpack first'); return; }
  const name = document.getElementById('depName').value.trim();
  const symbol = document.getElementById('depSymbol').value.trim();
  const supply = Number(document.getElementById('depSupply').value || 0);
  const price = Number(document.getElementById('depPrice').value || 0);
  const file = document.getElementById('depImage').files[0];
  if (!file) { alert('Choose an image'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      const img = await fetchJSON('/api/pin/image', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentType: file.type, dataBase64: base64, nameTag: `image-${name}-${symbol}` }),
      });
      const meta = await fetchJSON('/api/pin/metadata', {
        method: 'POST',
        body: JSON.stringify({
          name,
          symbol,
          description: `${name} collection`,
          image: img.gateway,
          attributes: [],
          properties: { files: [{ uri: img.gateway, type: file.type || 'image/png' }] },
        }),
      });
      const dep = await fetchJSON('/api/deploy/config', {
        method: 'POST',
        body: JSON.stringify({ name, symbol, supply, price, imageCid: img.imageCid, metadataUri: meta.metadataUri, metadataGateway: meta.gateway, owner: wallet.publicKey }),
      });
      // Mint a 1/1 NFT to the deployer wallet for the collection
      const { Keypair, Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
      const mint = Keypair.generate();
      const r = await fetchJSON('/api/tx/mint-nft', {
        method: 'POST',
        body: JSON.stringify({ id: dep.id, payer: wallet.publicKey, mintPubkey: mint.publicKey.toBase58() }),
      });
      const buf = Uint8Array.from(atob(r.tx), c => c.charCodeAt(0));
      const tx = Transaction.from(buf);
      tx.partialSign(mint);
      const signed = await wallet.provider.signTransaction(tx);
      const connection = new Connection((window.SOLANA_RPC) || 'https://rpc.testnet.carv.io/rpc', 'confirmed');
      const raw = signed.serialize();
      const sig = await connection.sendRawTransaction(raw, { maxRetries: 20, preflightCommitment: 'confirmed' });
      const start = Date.now();
      while (Date.now() - start < 90000) {
        const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
        const v = st.value?.[0];
        if (v?.err) throw new Error('Transaction failed');
        const cs = v?.confirmationStatus;
        if (cs === 'confirmed' || cs === 'finalized') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      alert(`Deployed config ${dep.id} and minted 1/1: ${sig}`);
      await fetchJSON('/api/record-mint', { method: 'POST', body: JSON.stringify({ id: dep.id, mint: mint.publicKey.toBase58() }) });
      await loadCollections();
    } catch (err) {
      console.error(err);
      alert('Deploy failed: ' + (err.message || err));
    }
  };
  reader.readAsDataURL(file);
});
