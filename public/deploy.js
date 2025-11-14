import { fetchJSON, connectBackpack, showToast, getConfig, txExplorerUrl, waitForConfirmation, sendAndTrack } from '/common.js';

window.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('deployForm');
  const submitBtn = document.querySelector('button[form="deployForm"][type="submit"], #deployForm button[type="submit"]');
  let isSubmitting = false;
  const fileInput = document.getElementById('depImage');
  const preview = document.getElementById('depPreview');
  const priceInput = document.getElementById('depPrice');
  const placeholder = document.getElementById('depPlaceholder');
  const drop = document.getElementById('depDrop');
  const fileName = document.getElementById('depFileName');
  const priceUsdBox = document.getElementById('depPriceUsd');
  const royaltyInput = document.getElementById('depRoyalty');
  // Collection cover inputs removed
  const useSchedule = document.getElementById('depUseSchedule');
  const scheduleWrap = document.getElementById('depScheduleWrap');
  const limitOneCheckbox = document.getElementById('depLimitOne');
  const startInput = document.getElementById('depStart');
  const endInput = document.getElementById('depEnd');
  // Live USD + CARV estimate for price
  (async () => {
    try {
      const j = await fetch('/api/prices').then(r => r.ok ? r.json() : {});
      const usd = typeof j.solUsd === 'number' ? j.solUsd : null;
      const carvPerSol = typeof j.carvPerSol === 'number' ? j.carvPerSol : null;
      const update = () => {
        const v = Number(priceInput.value || 0);
        if (isFinite(v) && (usd || carvPerSol)) {
          const usdTxt = usd ? `≈ $${(v * usd).toFixed(2)}` : '';
          const carvTxt = carvPerSol ? ` • ≈ ${(v * carvPerSol).toFixed(2)} CARV` : '';
          priceUsdBox.textContent = `${usdTxt}${carvTxt}`.replace(/^\s+|\s+$/g, '');
        } else {
          priceUsdBox.textContent = '';
        }
      };
      priceInput.addEventListener('input', update);
      update();
    } catch {}
  })();

  // Toggle schedule inputs
  try {
    const updateSched = () => { if (scheduleWrap) scheduleWrap.classList.toggle('hidden', !useSchedule?.checked); };
    if (useSchedule) { useSchedule.addEventListener('change', updateSched); updateSched(); }
  } catch {}

  // Live 1:1 preview (supports PNG transparency)
  // Sanitize royalty input to digits and a single dot, clamp 0..25
  function sanitizeRoyaltyInput(el) {
    if (!el) return;
    let v = String(el.value || '');
    v = v.replace(/[^\d.]/g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    let num = Number(v);
    if (!isFinite(num)) { num = 0; }
    if (num < 0) num = 0;
    if (num > 25) num = 25;
    el.value = String(num);
  }
  royaltyInput?.addEventListener('input', () => sanitizeRoyaltyInput(royaltyInput));
  function setName(name) { if (fileName) fileName.textContent = name || 'PNG/JPG • drag & drop supported'; }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) {
      preview.removeAttribute('src');
      if (placeholder) placeholder.style.display = 'grid';
      setName('PNG/JPG • drag & drop supported');
      return;
    }
    // Use data URL to comply with CSP (no blob: in img-src)
    const fr = new FileReader();
    fr.onload = () => {
      preview.src = fr.result;
      if (placeholder) placeholder.style.display = 'none';
    };
    fr.readAsDataURL(f);
    setName(f.name);
  });

  // Click and keyboard to open file dialog
  if (drop) {
    const openPicker = () => fileInput?.click();
    drop.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPicker(); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });

    // Drag & drop behavior
    const cancel = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, (e)=>{ cancel(e); drop.classList.add('drag'); }));
    ['dragleave','dragend','drop'].forEach(ev => drop.addEventListener(ev, (e)=>{ cancel(e); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { showToast('Please drop an image file', { title: 'Invalid file', variant: 'error' }); return; }
      const dt = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change'));
    });
  }
  // Collection cover UI removed
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return; // guard against double-submit
    const conn = await connectBackpack();
    if (!conn) return;
    const { publicKey, provider } = conn;

    const name = document.getElementById('depName').value.trim();
    let symbol = document.getElementById('depSymbol').value.trim();
    symbol = symbol.toUpperCase();
    const symEl = document.getElementById('depSymbol');
    symEl.value = symbol;
    const supply = Number(document.getElementById('depSupply').value || 0);
    const price = Number(document.getElementById('depPrice').value || 0);
    const file = fileInput.files[0];
    sanitizeRoyaltyInput(royaltyInput);
    const royaltyPct = Number(royaltyInput?.value || '');
    if (!(isFinite(royaltyPct) && royaltyPct >= 0 && royaltyPct <= 25)) { showToast('Royalty must be a number between 0 and 25', { title: 'Validation', variant: 'error' }); return; }
    const royaltyBps = Math.round(royaltyPct * 100);
    const coverFile = null;
    // schedule validation
    let mintStartTs = null, mintEndTs = null;
    if (useSchedule?.checked) {
      const s = startInput?.value || '';
      const e2 = endInput?.value || '';
      if (!s || !e2) { showToast('Provide both start and end date/time', { title: 'Validation', variant: 'error' }); return; }
      const ss = Math.floor(new Date(s).getTime() / 1000);
      const ee = Math.floor(new Date(e2).getTime() / 1000);
      if (!ss || !ee || !isFinite(ss) || !isFinite(ee)) { showToast('Invalid start or end time', { title: 'Validation', variant: 'error' }); return; }
      if (ee <= ss) { showToast('End time must be after start', { title: 'Validation', variant: 'error' }); return; }
      mintStartTs = ss; mintEndTs = ee;
    }
    // Inline validation
    if (!name) { showToast('Name is required', { title: 'Validation', variant: 'error' }); return; }
    if (!symbol || symbol.length < 2 || symbol.length > 10) { showToast('Symbol must be 2-10 uppercase letters', { title: 'Validation', variant: 'error' }); return; }
    if (!Number.isFinite(supply) || !Number.isInteger(supply)) { showToast('Supply must be an integer', { title: 'Validation', variant: 'error' }); return; }
    if (supply < 10 || supply > 100000) { showToast('Supply must be between 10 and 100000', { title: 'Validation', variant: 'error' }); return; }
    if (!Number.isFinite(price) || price < 0) { showToast('Price must be a non-negative number', { title: 'Validation', variant: 'error' }); return; }
    if (!file) { showToast('Choose an image', { title: 'Validation', variant: 'error' }); return; }

    // Pre-check: symbol must be unique per wallet (PDA uniqueness)
    try {
      const pre = await fetchJSON('/api/collections/check-symbol', { method: 'POST', body: JSON.stringify({ owner: publicKey, symbol }) });
      if (pre?.exists) {
        showToast(`Symbol already used for this wallet. On-chain PDA: <code>${pre.collectionPda}</code>`, { title: 'Symbol Exists', variant: 'warning', duration: 7000 });
        return;
      }
    } catch {}

    const reader = new FileReader();
    // mark in-flight and disable UI before any async work
    isSubmitting = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Deploying…'; }
    Array.from(form.querySelectorAll('input, button')).forEach(el => { el.disabled = true; });
    reader.onload = async () => {
      try {

        // Proceed to IPFS only after preflight check
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
            image: img.gateway, // use HTTPS gateway for broad explorer support
            attributes: [],
            properties: { files: [{ uri: img.gateway, type: file.type || 'image/png' }] },
          }),
        });
        // Collection cover removed from deploy flow

        // Create on-chain collection PDA proof and parent collection NFT in one tx
        let collId = null;
        const init = await fetchJSON('/api/tx/init-collection', {
          method: 'POST',
          body: JSON.stringify({ payer: publicKey, owner: publicKey, name, symbol, metadataUri: meta.metadataUri, price, supply, collectionMetaUri: null }),
        });
        const { Transaction, Connection, PublicKey } = await import('https://esm.sh/@solana/web3.js@1.98.0');
        let initSig = null;
        let collectionMint = init?.collectionMint || null;
        if (init?.tx) {
          const buf = Uint8Array.from(atob(init.tx), c => c.charCodeAt(0));
          const tx = Transaction.from(buf);
          const signed = await provider.signTransaction(tx);
          const { rpc } = await getConfig();
          const connection = new Connection(rpc, 'confirmed');
          initSig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
          try { await waitForConfirmation(connection, initSig, { timeoutMs: 90000, desired: 'confirmed' }); } catch {}
        }

        // Ensure creator has CARV ATA to reduce size of future mint txs (enables verify in the same tx)
        try {
          const CARV_MINT = 'D7WVEw9Pkf4dfCCE3fwGikRCCTvm9ipqTYPHRENLiw3s';
          const ensure = await fetchJSON('/api/tx/ensure-ata', { method: 'POST', body: JSON.stringify({ owner: publicKey, mint: CARV_MINT }) });
          if (ensure?.tx) {
            const buf = Uint8Array.from(atob(ensure.tx), c => c.charCodeAt(0));
            const tx = Transaction.from(buf);
            const signed = await provider.signTransaction(tx);
            const { rpc } = await getConfig();
            const connection = new Connection(rpc, 'confirmed');
            const sig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
            try { await waitForConfirmation(connection, sig, { timeoutMs: 60000, desired: 'confirmed' }); } catch {}
          }
        } catch {}

        const limitOnePerWallet = !!limitOneCheckbox?.checked;
        const r = await fetchJSON('/api/deploy/config', {
          method: 'POST',
          body: JSON.stringify({ name, symbol, supply, price, imageCid: img.imageCid, metadataUri: meta.metadataUri, metadataGateway: meta.gateway, owner: publicKey, onchainPda: init.collectionPda, mintStartTs, mintEndTs, collectionMint, royaltyBps, limitOnePerWallet }),
        });
        collId = r.id;
        const short = initSig ? `${initSig.slice(0, 6)}...${initSig.slice(-6)}` : 'already initialized';
        const actions = [];
        if (initSig) actions.push({ label: 'View Tx', onClick: async () => window.open(await txExplorerUrl(initSig), '_blank') });
        actions.push({ label: 'Go to Mint', onClick: () => (window.location.href = '/mint') });
        showToast(`ID: <code>${collId}</code><br/>On-chain: ${short}`, { title: 'Collection Created', variant: 'success', actions });

        // Fill success panel
        const sec = document.getElementById('deploySuccess');
        const body = document.getElementById('deploySuccessBody');
        if (sec && body) {
          sec.style.display = '';
          body.innerHTML = `Your collection was created. ID: <code>${collId || ''}</code>`;
          const copyBtn = document.getElementById('copyDeployId');
          if (copyBtn && collId) copyBtn.onclick = () => navigator.clipboard?.writeText(collId);
        }
      } catch (err) {
        console.error(err);
        showToast((err.message || String(err)), { title: 'Deploy failed', variant: 'error', duration: 7000 });
        // re-enable on failure so user can try again
        isSubmitting = false;
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Deploy Now!!!'; }
        Array.from(form.querySelectorAll('input, button')).forEach(el => {
          // Keep Connect button enabled; others back to normal
          if (el.id !== 'connectBtn') el.disabled = false;
        });
      }
    };
    reader.readAsDataURL(file);
  });
});
