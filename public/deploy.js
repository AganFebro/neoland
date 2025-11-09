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
  const useSchedule = document.getElementById('depUseSchedule');
  const scheduleWrap = document.getElementById('depScheduleWrap');
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
        // Always: Create on-chain collection PDA proof, then register in DB (no auto mint)
        let collId = null;
        const init = await fetchJSON('/api/tx/init-collection', {
          method: 'POST',
          body: JSON.stringify({ payer: publicKey, owner: publicKey, name, symbol, metadataUri: meta.metadataUri, price, supply }),
        });
        const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
        let initSig = null;
        if (init?.tx) {
          const buf = Uint8Array.from(atob(init.tx), c => c.charCodeAt(0));
          const tx = Transaction.from(buf);
          const signed = await provider.signTransaction(tx);
          const { rpc } = await getConfig();
          const connection = new Connection(rpc, 'confirmed');
          initSig = await sendAndTrack(connection, signed.serialize(), { commitment: 'confirmed', timeoutMs: 120000 });
          try { await waitForConfirmation(connection, initSig, { timeoutMs: 90000, desired: 'confirmed' }); } catch {}
        }

        const r = await fetchJSON('/api/deploy/config', {
          method: 'POST',
          body: JSON.stringify({ name, symbol, supply, price, imageCid: img.imageCid, metadataUri: meta.metadataUri, metadataGateway: meta.gateway, owner: publicKey, onchainPda: init.collectionPda, mintStartTs, mintEndTs }),
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
