import { connectBackpack, fetchJSON, getConfig, getBackpackProvider, setImgSrc, showToast } from './common.js';

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'for') e.htmlFor = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).filter(Boolean).forEach((c) => e.appendChild(c));
  return e;
}

function toIsoLocal(tsSec) {
  if (!tsSec) return '';
  const d = new Date(Number(tsSec) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}
function fromLocal(dtStr) { return dtStr ? Math.floor(new Date(dtStr).getTime() / 1000) : null; }

async function loadOwnerCollections(owner) {
  const j = await fetchJSON('/api/collections');
  return (j.collections || []).filter((c) => String(c.owner) === String(owner));
}

function renderCard(coll, owner) {
  const started = coll.mintStartTs != null ? (Math.floor(Date.now()/1000) >= Number(coll.mintStartTs)) : false;
  const form = el('div', { class: 'manage-card' });
  const minSupply = Math.max(10, Number(coll.minted_count || 0));
  const maxSupply = 100000;
  form.innerHTML = `
    <div class="manage-head">
      <div class="manage-left">
        <div class="square-frame"><img id="img_${coll.id}" alt="" /></div>
        <div class="stack">
          <h4 class="subtitle manage-title">${coll.name} <span class="mini-badge">${coll.symbol}</span></h4>
          <div class="manage-sub">ID: ${coll.id}</div>
        </div>
      </div>
      <div class="badge">Minted ${Number(coll.minted_count || 0)}/${coll.supply || '∞'}</div>
    </div>
    <div class="manage-meta">
      <label class="stack">
        <span class="label">Mint Price (SOL)</span>
        <input class="input" type="number" step="0.0001" min="0" id="price_${coll.id}" value="${(Number(coll.priceLamports||0)/1_000_000_000).toString()}"/>
      </label>
      <label class="stack">
        <span class="label">Royalty %</span>
        <input class="input" type="number" step="0.5" min="0" max="25" id="royalty_${coll.id}" value="${(Number(coll.royaltyBps||0)/100).toString()}"/>
        <div class="hint">Creator receives this percent on secondary sales. Max 25%.</div>
      </label>
      <label class="stack">
        <span class="label">Supply</span>
        <input class="input" type="number" min="${minSupply}" max="${maxSupply}" id="supply_${coll.id}" value="${Number(coll.supply || 0)}"/>
        <div class="hint">Min 10, Max 100,000. Cannot be lower than minted (${Number(coll.minted_count||0)}).</div>
      </label>
      <div class="stack">
        <span class="label">Mint Window</span>
        <div class="form-row">
          <label class="stack">
            <span class="small muted">Start</span>
            <input class="input" type="datetime-local" id="start_${coll.id}" value="${toIsoLocal(coll.mintStartTs)}" ${started ? 'disabled' : ''} />
          </label>
          <label class="stack">
            <span class="small muted">End</span>
            <input class="input" type="datetime-local" id="end_${coll.id}" value="${toIsoLocal(coll.mintEndTs)}" />
          </label>
        </div>
        <div class="hint">${started ? 'Mint started — only end time can be changed.' : 'You can edit both start and end before mint starts.'}</div>
      </div>
      <label class="row center" style="gap:10px">
        <input type="checkbox" id="pause_${coll.id}" ${coll.tradingPaused ? 'checked' : ''} />
        <span>Pause buying (listings remain allowed)</span>
      </label>
      <label class="row center" style="gap:10px; margin-top:8px">
        <input type="checkbox" id="mintpause_${coll.id}" ${coll.mintPaused ? 'checked' : ''} />
        <span>Pause minting</span>
      </label>
      ${!coll.collectionMint ? `<div class="row mt" style="gap:10px">
        <button class="btn" id="enable_${coll.id}">Enable Verified Collection</button>
      </div>` : ''}
      <div class="stack mt">
        <span class="label">Whitelist (one address per line)</span>
        <textarea class="input" id="wl_${coll.id}" rows="6" placeholder="Base58 wallet addresses..."></textarea>
        <div class="row center" style="gap:10px">
          <button class="btn" id="wl_load_${coll.id}">Load Whitelist</button>
          <button class="btn" id="wl_save_${coll.id}">Save Whitelist</button>
          <span class="small muted" id="wl_status_${coll.id}">—</span>
        </div>
        <div class="hint">Only addresses listed can mint. Leave empty to allow anyone.</div>
      </div>
    </div>
    <div class="manage-actions">
      <button class="btn" id="save_${coll.id}" disabled>Save Changes</button>
    </div>
  `;

  const img = form.querySelector(`#img_${coll.id}`);
  setImgSrc(img, coll.image || coll.image_gateway);

  // Enable Verified Collection button
  const enableBtn = form.querySelector(`#enable_${coll.id}`);
  if (enableBtn && !coll.collectionMint) {
    enableBtn.addEventListener('click', async () => {
      try {
        enableBtn.disabled = true;
        enableBtn.textContent = 'Preparing…';
        const provider = getBackpackProvider();
        if (!provider) { showToast('Connect Backpack first', { title: 'Wallet', variant: 'error' }); enableBtn.disabled = false; enableBtn.textContent = 'Enable Verified Collection'; return; }
        // Pin minimal parent metadata; fallback to existing metadata if pinning not configured
        let collectionMetaGateway = null;
        try {
          const meta = {
            name: `${coll.name} Collection`,
            symbol: `${coll.symbol}`,
            description: `${coll.name} (Collection)`,
            image: coll.image || coll.image_gateway || '',
            attributes: [],
            properties: { files: [{ uri: coll.image || coll.image_gateway || '', type: 'image/png' }] },
          };
          const r = await fetchJSON('/api/pin/metadata', { method: 'POST', body: JSON.stringify(meta) });
          collectionMetaGateway = r.gateway || null;
        } catch {}
        const useMeta = collectionMetaGateway || coll.metadata_gateway || coll.metadata_uri;
        if (!useMeta) { showToast('No metadata available for parent NFT. Please set a collection image/metadata.', { title: 'Missing metadata', variant: 'error' }); enableBtn.disabled = false; enableBtn.textContent = 'Enable Verified Collection'; return; }
        // Build parent NFT tx
        enableBtn.textContent = 'Building Tx…';
        const build = await fetchJSON('/api/tx/create-collection-nft', { method: 'POST', body: JSON.stringify({ owner, name: `${coll.name} Collection`, symbol: `${coll.symbol}`, metadataUri: useMeta }) });
        const { Transaction, Connection } = await import('https://esm.sh/@solana/web3.js@1.98.0');
        const buf = Uint8Array.from(atob(build.tx), c => c.charCodeAt(0));
        const tx = Transaction.from(buf);
        const signed = await provider.signTransaction(tx);
        const { rpc } = await getConfig();
        const connection = new Connection(rpc, 'confirmed');
        enableBtn.textContent = 'Sending…';
        let sig;
        try {
          sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 20, preflightCommitment: 'confirmed' });
        } catch (e) {
          let extra = '';
          try {
            if (e && typeof e.getLogs === 'function') {
              const logs = await e.getLogs();
              if (logs && logs.length) extra = `\nLogs:\n${logs.join('\n')}`;
            } else if (e && e.logs && Array.isArray(e.logs)) {
              extra = `\nLogs:\n${e.logs.join('\n')}`;
            }
          } catch {}
          throw new Error(`${e?.message || String(e)}${extra}`);
        }
        try { await connection.confirmTransaction(sig, 'confirmed'); } catch {}
        // Save collectionMint via signed admin update
        const { nonce } = await fetchJSON(`/api/admin/nonce?addr=${encodeURIComponent(owner)}`);
        const patch = { collectionMint: build.mint };
        if (collectionMetaGateway) patch.collectionMetaGateway = collectionMetaGateway;
        const canonOrder = ['priceSol','price_lamports','mintStartTs','mintEndTs','supply','tradingPaused','mintPaused','collectionMint','collectionCoverCid','collectionCoverGateway','collectionMetaUri','collectionMetaGateway'];
        const canon = {}; canonOrder.forEach((k)=>{ if (k in patch) canon[k] = patch[k]; });
        const msg = `neoland admin\naddr:${owner}\nnonce:${nonce}\naction:update-collection\nid:${coll.id}\npatch:${JSON.stringify(canon)}`;
        const enc = new TextEncoder();
        const sigRes = await provider.signMessage(enc.encode(msg));
        const sigRaw = sigRes?.signature ?? sigRes;
        const bs58mod = (await import('https://esm.sh/bs58@6.0.0')).default;
        const sigB58 = typeof sigRaw === 'string' ? sigRaw : bs58mod.encode(new Uint8Array(sigRaw));
        const r = await fetchJSON('/api/admin/update-collection', { method: 'POST', body: JSON.stringify({ id: coll.id, addr: owner, nonce, signature: sigB58, patch }) });
        Object.assign(coll, r.collection || {});
        showToast('Verified collection enabled. You can mint again now.', { title: 'Success', variant: 'success' });
        enableBtn.remove();
      } catch (e) {
        console.error(e);
        showToast(e?.message || String(e), { title: 'Enable failed', variant: 'error' });
        enableBtn.disabled = false; enableBtn.textContent = 'Enable Verified Collection';
      }
    });
  }

  const onSave = async () => {
    const priceInput = form.querySelector(`#price_${coll.id}`);
    const priceSol = Number(priceInput.value || 0);
    if (!Number.isFinite(priceSol) || priceSol < 0) {
      priceInput.focus();
      priceInput.style.outline = '3px solid #ff6db6';
      showToast('Enter a valid non-negative price.', { title: 'Validation', variant: 'error' });
      return;
    }
    let supply = Number(form.querySelector(`#supply_${coll.id}`).value || 0);
    const sStr = form.querySelector(`#start_${coll.id}`).value;
    const eStr = form.querySelector(`#end_${coll.id}`).value;
    const startTs = sStr ? fromLocal(sStr) : null;
    const endTs = eStr ? fromLocal(eStr) : null;
    const tradingPaused = form.querySelector(`#pause_${coll.id}`).checked;
    const mintPaused = form.querySelector(`#mintpause_${coll.id}`).checked;

    const royaltyInput = form.querySelector(`#royalty_${coll.id}`);
    // sanitize royalty input
    let royaltyStr = String(royaltyInput?.value || '');
    royaltyStr = royaltyStr.replace(/[^\d.]/g, '');
    const parts = royaltyStr.split('.');
    if (parts.length > 2) royaltyStr = parts[0] + '.' + parts.slice(1).join('');
    let royaltyPct = Number(royaltyStr);
    if (!isFinite(royaltyPct) || royaltyPct < 0) royaltyPct = 0;
    if (royaltyPct > 25) royaltyPct = 25;
    royaltyInput.value = String(royaltyPct);
    const royaltyBps = Math.round(royaltyPct * 100);

    const patch = {};
    if (Math.round(priceSol * 10_000) !== Math.round((Number(coll.priceLamports||0)/1_000_000_000) * 10_000)) patch.priceSol = priceSol;
    // Clamp on client-side too
    supply = Math.max(minSupply, Math.min(maxSupply, supply));
    if (supply !== Number(coll.supply || 0)) patch.supply = supply;
    const startedNow = coll.mintStartTs != null ? (Math.floor(Date.now()/1000) >= Number(coll.mintStartTs)) : false;
    const curStart = coll.mintStartTs != null ? Number(coll.mintStartTs) : null;
    const curEnd = coll.mintEndTs != null ? Number(coll.mintEndTs) : null;
    if (!startedNow && startTs !== curStart) patch.mintStartTs = startTs;
    if (endTs !== curEnd) patch.mintEndTs = endTs;
    if (Boolean(tradingPaused) !== Boolean(coll.tradingPaused)) patch.tradingPaused = tradingPaused;
    if (royaltyBps !== Number(coll.royaltyBps || 0)) patch.royaltyBps = royaltyBps;
    if (Boolean(mintPaused) !== Boolean(coll.mintPaused)) patch.mintPaused = mintPaused;
    const keys = Object.keys(patch);
    if (!keys.length) { showToast('No changes to save.', { title: 'Nothing Changed', variant: 'info' }); return; }

    // Auth
    const provider = getBackpackProvider();
    if (!provider?.signMessage) { showToast('Backpack signMessage not available', { title: 'Wallet Error', variant: 'error' }); return; }
    try {
      // UI: show saving state
      const prevText = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      saveBtn.disabled = true;
      const { nonce } = await fetchJSON(`/api/admin/nonce?addr=${encodeURIComponent(owner)}`);
      const canon = {};
      // Keep deterministic order similar to server allowedKeys
      ['priceSol','price_lamports','mintStartTs','mintEndTs','supply','tradingPaused','mintPaused','lockNewMints','royaltyBps','collectionMint','collectionCoverCid','collectionCoverGateway','collectionMetaUri','collectionMetaGateway']
        .forEach((k) => { if (k in patch) canon[k] = patch[k]; });
      const msg = `neoland admin\naddr:${owner}\nnonce:${nonce}\naction:update-collection\nid:${coll.id}\npatch:${JSON.stringify(canon)}`;
      const enc = new TextEncoder();
      const sigRes = await provider.signMessage(enc.encode(msg));
      const sigRaw = (sigRes && sigRes.signature) ? sigRes.signature : sigRes;
      // Accept signature as Uint8Array, Buffer-like, or already base58 string
      let sigB58;
      if (typeof sigRaw === 'string') {
        sigB58 = sigRaw; // assume already base58
      } else if (sigRaw && (sigRaw instanceof Uint8Array || (typeof sigRaw.length === 'number'))) {
        const bs58 = (await import('https://esm.sh/bs58@6.0.0')).default;
        sigB58 = bs58.encode(new Uint8Array(sigRaw));
      } else {
        throw new Error('Wallet returned unexpected signature format');
      }

      const r = await fetchJSON('/api/admin/update-collection', {
        method: 'POST',
        body: JSON.stringify({ id: coll.id, addr: owner, nonce, signature: sigB58, patch }),
      });
      // Update local copy and reflect any canonical clamping from server
      Object.assign(coll, r.collection || {});
      // Normalize UI with returned values
      form.querySelector(`#price_${coll.id}`).value = (Number(coll.priceLamports||0) / 1_000_000_000).toString();
      form.querySelector(`#supply_${coll.id}`).value = String(coll.supply ?? '');
      const st = form.querySelector(`#start_${coll.id}`);
      const en = form.querySelector(`#end_${coll.id}`);
      if (st && !started) st.value = toIsoLocal(coll.mintStartTs);
      if (en) en.value = toIsoLocal(coll.mintEndTs);
      const pause = form.querySelector(`#pause_${coll.id}`);
      if (pause) pause.checked = !!coll.tradingPaused;
      const mintPauseBox = form.querySelector(`#mintpause_${coll.id}`);
      if (mintPauseBox) mintPauseBox.checked = !!coll.mintPaused;
      const royaltyBox = form.querySelector(`#royalty_${coll.id}`);
      if (royaltyBox) royaltyBox.value = (Number(coll.royaltyBps || 0) / 100).toString();
      recomputeDirty();
      showToast('Your changes have been saved.', { title: 'Saved', variant: 'success' });
    } catch (e) {
      const msg = e?.message || String(e) || 'Failed to save changes';
      showToast(msg, { title: 'Save Failed', variant: 'error' });
    } finally {
      // Restore button text; recompute will decide disabled state
      saveBtn.textContent = 'Save Changes';
      recomputeDirty();
    }
  };
  const saveBtn = form.querySelector(`#save_${coll.id}`);
  saveBtn.addEventListener('click', onSave);
  // Enable Save only when there are local changes
  const recomputeDirty = () => {
    const priceInput = form.querySelector(`#price_${coll.id}`);
    const priceSol = Number(priceInput.value || 0);
    const royaltyInput = form.querySelector(`#royalty_${coll.id}`);
    // sanitize on-the-fly
    let royaltyStr = String(royaltyInput?.value || '');
    royaltyStr = royaltyStr.replace(/[^\d.]/g, '');
    const parts = royaltyStr.split('.');
    if (parts.length > 2) royaltyStr = parts[0] + '.' + parts.slice(1).join('');
    let royaltyPct = Number(royaltyStr);
    if (!isFinite(royaltyPct) || royaltyPct < 0) royaltyPct = 0;
    if (royaltyPct > 25) royaltyPct = 25;
    royaltyInput.value = String(royaltyPct);
    const royaltyBps = Math.round(royaltyPct * 100);
    let valid = true;
    if (!Number.isFinite(priceSol) || priceSol < 0) { valid = false; }
    if (!(Number.isFinite(royaltyBps) && royaltyBps >= 0 && royaltyBps <= 2500)) { valid = false; }
    const supplyRaw = Number(form.querySelector(`#supply_${coll.id}`).value || 0);
    const sStr = form.querySelector(`#start_${coll.id}`).value;
    const eStr = form.querySelector(`#end_${coll.id}`).value;
    const startTs = sStr ? fromLocal(sStr) : null;
    const endTs = eStr ? fromLocal(eStr) : null;
    const tradingPaused = form.querySelector(`#pause_${coll.id}`).checked;
    const mintPaused = form.querySelector(`#mintpause_${coll.id}`).checked;
    const startedNow = coll.mintStartTs != null ? (Math.floor(Date.now()/1000) >= Number(coll.mintStartTs)) : false;
    const patch = {};
    if (Math.round(priceSol * 10_000) !== Math.round((Number(coll.priceLamports||0)/1_000_000_000) * 10_000)) patch.priceSol = priceSol;
    const supplyClamped = Math.max(minSupply, Math.min(maxSupply, supplyRaw));
    if (supplyClamped !== Number(coll.supply || 0)) patch.supply = supplyClamped;
    const curStart = coll.mintStartTs != null ? Number(coll.mintStartTs) : null;
    const curEnd = coll.mintEndTs != null ? Number(coll.mintEndTs) : null;
    if (!startedNow && startTs !== curStart) patch.mintStartTs = startTs;
    if (endTs !== curEnd) patch.mintEndTs = endTs;
    if (Boolean(tradingPaused) !== Boolean(coll.tradingPaused)) patch.tradingPaused = tradingPaused;
    if (Boolean(mintPaused) !== Boolean(coll.mintPaused)) patch.mintPaused = mintPaused;
    if (royaltyBps != null && royaltyBps !== Number(coll.royaltyBps || 0)) patch.royaltyBps = royaltyBps;
    const dirty = Object.keys(patch).length > 0;
    saveBtn.disabled = !(dirty && valid);
  };
  form.querySelectorAll('input').forEach((i) => i.addEventListener('input', recomputeDirty));
  recomputeDirty();

  // Whitelist handlers
  const wlArea = form.querySelector(`#wl_${coll.id}`);
  const wlStatus = form.querySelector(`#wl_status_${coll.id}`);
  const renderWlStatus = (list) => { if (wlStatus) wlStatus.textContent = `${list.length} address(es)`; };
  const parseWl = async () => {
    const raw = (wlArea?.value || '').split(/\s|,|;|\n|\r|\t/).map(s => s.trim()).filter(Boolean);
    const uniq = Array.from(new Set(raw));
    const bs58 = (await import('https://esm.sh/bs58@6.0.0')).default;
    const valid = uniq.filter((a) => { try { return bs58.decode(a).length === 32; } catch { return false; } });
    renderWlStatus(valid);
    return valid;
  };
  const loadWhitelist = async () => {
    try {
      const j = await fetchJSON(`/api/whitelist?id=${encodeURIComponent(coll.id)}`);
      const arr = Array.isArray(j.addresses) ? j.addresses : [];
      if (wlArea) wlArea.value = arr.join('\n');
      renderWlStatus(arr);
    } catch { if (wlArea) wlArea.value = ''; if (wlStatus) wlStatus.textContent = '—'; }
  };
  form.querySelector(`#wl_load_${coll.id}`)?.addEventListener('click', (e) => { e.preventDefault(); loadWhitelist().catch(console.error); });
  form.querySelector(`#wl_save_${coll.id}`)?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const list = await parseWl();
      const provider = getBackpackProvider();
      if (!provider?.signMessage) { showToast('Backpack signMessage not available', { title: 'Wallet Error', variant: 'error' }); return; }
      const { nonce } = await fetchJSON(`/api/admin/nonce?addr=${encodeURIComponent(owner)}`);
      const msg = `neoland admin\naddr:${owner}\nnonce:${nonce}\naction:update-whitelist\nid:${coll.id}\naddresses:${JSON.stringify(list)}`;
      const enc = new TextEncoder();
      const sigRes = await provider.signMessage(enc.encode(msg));
      const sigRaw = (sigRes && sigRes.signature) ? sigRes.signature : sigRes;
      const bs58 = (await import('https://esm.sh/bs58@6.0.0')).default;
      const sigB58 = typeof sigRaw === 'string' ? sigRaw : bs58.encode(new Uint8Array(sigRaw));
      await fetchJSON('/api/admin/whitelist', { method: 'POST', body: JSON.stringify({ id: coll.id, addr: owner, nonce, signature: sigB58, addresses: list }) });
      showToast('Whitelist saved', { title: 'Saved', variant: 'success' });
    } catch (e) {
      showToast(e?.message || String(e), { title: 'Save failed', variant: 'error' });
    }
  });
  // Auto load whitelist on render
  loadWhitelist().catch(console.error);
  return form;
}

async function main() {
  const { provider, publicKey } = await connectBackpack({ silent: true }) || {};
  const connectBtn = document.getElementById('connectForManage');
  const callout = document.getElementById('manageCallout');
  const ownerBadge = document.getElementById('ownerPk');
  if (publicKey) {
    ownerBadge.textContent = publicKey;
    connectBtn?.classList.add('hidden');
    callout?.classList.add('hidden');
    const list = document.getElementById('collList');
    list.innerHTML = '';
    const cols = await loadOwnerCollections(publicKey);
    if (!cols.length) {
      list.innerHTML = '<div class="muted">No collections found for this wallet.</div>';
    } else {
      cols.forEach((c) => list.appendChild(renderCard(c, publicKey)));
    }
  }
  connectBtn?.addEventListener('click', async () => { await connectBackpack(); window.location.reload(); });
}

main().catch(console.error);
