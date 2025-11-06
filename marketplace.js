import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import { getDb } from './db.js';

const RPC = process.env.CARV_RPC || process.env.CARV_SVM_RPC || 'https://rpc.testnet.carv.io/rpc';
const conn = new Connection(RPC, 'confirmed');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function getParsedBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function nowTs() { return Math.floor(Date.now() / 1000); }

function lamportsFrom(sol) {
  const n = Number(sol);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 1_000_000_000);
}

async function ownsNft(ownerStr, mintStr) {
  try {
    const owner = new PublicKey(ownerStr);
    // Validate mint format
    new PublicKey(mintStr);
    const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
    for (const { account } of resp.value) {
      try {
        const info = account.data.parsed.info;
        if (info.mint !== mintStr) continue;
        const amount = info.tokenAmount?.amount || '0';
        const decimals = Number(info.tokenAmount?.decimals ?? 0);
        if (decimals === 0 && amount === '1') return true;
      } catch {}
    }
  } catch {}
  return false;
}

async function escrowHasNft(mintStr) {
  try {
    if (!process.env.MARKET_PROGRAM_ID) return false;
    const programId = new PublicKey(process.env.MARKET_PROGRAM_ID);
    const mintPk = new PublicKey(mintStr);
    const listingPda = PublicKey.findProgramAddressSync([Buffer.from('listing'), mintPk.toBuffer()], programId)[0];
    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    const escrowAta = await getAssociatedTokenAddress(mintPk, listingPda, true);
    const acc = await conn.getParsedAccountInfo(escrowAta);
    const info = acc.value?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount || '0';
    const decimals = Number(info?.tokenAmount?.decimals ?? 0);
    return decimals === 0 && amount === '1';
  } catch {
    return false;
  }
}

// Aggregator URL helpers with env templates
function buildAggItemUrl(mint, collectionId) {
  const t = process.env.AGGREGATOR_ITEM_URL_TEMPLATE;
  if (!t) return null;
  return t
    .replaceAll('{mint}', encodeURIComponent(mint))
    .replaceAll('{collectionId}', encodeURIComponent(collectionId || ''))
    .replaceAll('{network}', encodeURIComponent(process.env.CARV_NETWORK || 'carv-testnet'));
}
function buildAggCollectionUrl(collectionId) {
  const t = process.env.AGGREGATOR_COLLECTION_URL_TEMPLATE;
  if (!t) return null;
  return t
    .replaceAll('{collectionId}', encodeURIComponent(collectionId))
    .replaceAll('{network}', encodeURIComponent(process.env.CARV_NETWORK || 'carv-testnet'));
}

export async function tryHandleMarketRoute(req, res, pathname, query) {
  try {
    // Aggregator helpers (optional; safe to leave if not used)
    if (pathname === '/api/market/agg/item-link' && req.method === 'GET') {
      const { mint, collectionId } = query || {};
      if (!mint) return sendJson(res, 400, { error: 'mint required' });
      const url = buildAggItemUrl(mint, collectionId);
      if (!url) return sendJson(res, 501, { error: 'Aggregator item URL template not configured' });
      return sendJson(res, 200, { url });
    }
    if (pathname === '/api/market/agg/collection-link' && req.method === 'GET') {
      const { collectionId } = query || {};
      if (!collectionId) return sendJson(res, 400, { error: 'collectionId required' });
      const url = buildAggCollectionUrl(collectionId);
      if (!url) return sendJson(res, 501, { error: 'Aggregator collection URL template not configured' });
      return sendJson(res, 200, { url });
    }

    // GET /api/market/listings
    if (pathname === '/api/market/listings' && req.method === 'GET') {
      const { collectionId, seller } = query || {};
      const dbh = await getDb();
      const listings = await dbh.getListings({ collectionId, seller, activeOnly: true });
      return sendJson(res, 200, { listings });
    }

    // GET /api/market/activity?collectionId=
    if (pathname === '/api/market/activity' && req.method === 'GET') {
      const { collectionId } = query || {};
      if (!collectionId) return sendJson(res, 400, { error: 'collectionId required' });
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(collectionId);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      const all = await dbh.getListings({ collectionId, activeOnly: false });
      const sales = all
        .filter((l) => l.soldAt && !l.cancelled)
        .map((l) => ({ type: 'sale', ts: Number(l.soldAt) || 0, mint: l.mint, priceLamports: Number(l.priceLamports || 0), seller: l.seller || null, buyer: l.buyer || null }));
      const mints = Array.isArray(cfg.mints)
        ? cfg.mints.map((m) => ({ type: 'mint', ts: 0, mint: m, minter: null }))
        : [];
      const events = [...(Array.isArray(cfg.mintEvents) ? cfg.mintEvents.map((m) => ({ type: 'mint', ts: Number(m.ts) || 0, mint: m.mint, minter: m.minter || null })) : mints), ...sales]
        .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
      return sendJson(res, 200, { events });
    }

    // GET /api/market/stats?collectionId=
    if (pathname === '/api/market/stats' && req.method === 'GET') {
      const { collectionId } = query || {};
      if (!collectionId) return sendJson(res, 400, { error: 'collectionId required' });
      const dbh = await getDb();
      const all = await dbh.getListings({ collectionId, activeOnly: false });
      const active = all.filter((l) => !l.cancelled && !l.soldAt);
      const sold = all.filter((l) => l.soldAt && !l.cancelled);
      const floorLamports = active.length ? active.reduce((m, l) => Math.min(m, Number(l.priceLamports || 0)), Number.MAX_SAFE_INTEGER) : null;
      const totalVolumeLamports = sold.reduce((sum, l) => sum + Number(l.priceLamports || 0), 0);
      const since = nowTs() - 86400;
      const vol24hLamports = sold.filter((l) => Number(l.soldAt || 0) >= since).reduce((s, l) => s + Number(l.priceLamports || 0), 0);
      return sendJson(res, 200, {
        floorLamports: floorLamports === null || floorLamports === Number.MAX_SAFE_INTEGER ? null : floorLamports,
        vol24hLamports,
        totalVolumeLamports,
      });
    }

    // POST /api/market/list  { mint, collectionId, seller, priceSol }
    if (pathname === '/api/market/list' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { mint, collectionId, seller, priceSol } = body || {};
      if (!mint || !collectionId || !seller) return sendJson(res, 400, { error: 'mint, collectionId, seller required' });
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(collectionId);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      const minted = new Set((cfg.mints || []));
      if (!minted.has(mint)) return sendJson(res, 400, { error: 'mint not part of this collection' });
      let ok = await ownsNft(seller, mint);
      if (!ok) {
        // If the NFT moved to escrow (after on-chain list), allow indexing
        const inEscrow = await escrowHasNft(mint);
        if (!inEscrow) return sendJson(res, 400, { error: 'seller does not own this NFT' });
      }
      const priceLamports = priceSol != null ? lamportsFrom(priceSol) : 0;
      const { id } = await dbh.createListing({ mint, collectionId, seller, priceLamports });
      const listing = { id, mint, collectionId, seller, priceLamports, createdAt: nowTs() };
      return sendJson(res, 200, { id, listing });
    }

    // Build on-chain transactions for the custom program (list/buy/cancel)
    if (pathname === '/api/market/tx/list' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { mint, seller, priceSol } = body || {};
      if (!process.env.MARKET_PROGRAM_ID) return sendJson(res, 400, { error: 'MARKET_PROGRAM_ID not set' });
      if (!mint || !seller) return sendJson(res, 400, { error: 'mint and seller required' });
      const programId = new PublicKey(process.env.MARKET_PROGRAM_ID);
      const mintPk = new PublicKey(mint);
      const sellerPk = new PublicKey(seller);
      const listingPda = PublicKey.findProgramAddressSync([Buffer.from('listing'), mintPk.toBuffer()], programId)[0];
      const { getAssociatedTokenAddress } = await import('@solana/spl-token');
      const sellerAta = await getAssociatedTokenAddress(mintPk, sellerPk);
      const escrowAta = await getAssociatedTokenAddress(mintPk, listingPda, true);
      const priceLamports = Math.round(Number(priceSol || 0) * 1_000_000_000);

      // Anchor discriminator for global:list + u64 price
      const disc = createHash('sha256').update('global:list').digest().subarray(0,8);
      const data = Buffer.alloc(8 + 8);
      disc.copy(data, 0);
      data.writeBigUInt64LE(BigInt(priceLamports), 8);

      const keys = [
        { pubkey: sellerPk, isSigner: true, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: listingPda, isSigner: false, isWritable: true },
        { pubkey: escrowAta, isSigner: false, isWritable: true },
        { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
        { pubkey: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      ];
      const { Transaction } = await import('@solana/web3.js');
      const ix = new (await import('@solana/web3.js')).TransactionInstruction({ programId, keys, data });
      const tx = new Transaction();
      tx.feePayer = sellerPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    if (pathname === '/api/market/tx/cancel' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { mint, seller } = body || {};
      if (!process.env.MARKET_PROGRAM_ID) return sendJson(res, 400, { error: 'MARKET_PROGRAM_ID not set' });
      if (!mint || !seller) return sendJson(res, 400, { error: 'mint and seller required' });
      const programId = new PublicKey(process.env.MARKET_PROGRAM_ID);
      const mintPk = new PublicKey(mint);
      const sellerPk = new PublicKey(seller);
      const listingPda = PublicKey.findProgramAddressSync([Buffer.from('listing'), mintPk.toBuffer()], programId)[0];
      const { getAssociatedTokenAddress } = await import('@solana/spl-token');
      const sellerAta = await getAssociatedTokenAddress(mintPk, sellerPk);
      const escrowAta = await getAssociatedTokenAddress(mintPk, listingPda, true);

      // Anchor discriminator for global:cancel
      const data = createHash('sha256').update('global:cancel').digest().subarray(0,8);

      const keys = [
        { pubkey: sellerPk, isSigner: true, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: listingPda, isSigner: false, isWritable: true },
        { pubkey: escrowAta, isSigner: false, isWritable: true },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
      ];
      const { Transaction } = await import('@solana/web3.js');
      const ix = new (await import('@solana/web3.js')).TransactionInstruction({ programId, keys, data });
      const tx = new Transaction();
      tx.feePayer = sellerPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    if (pathname === '/api/market/tx/buy' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { listingId, buyer } = body || {};
      if (!process.env.MARKET_PROGRAM_ID) return sendJson(res, 400, { error: 'MARKET_PROGRAM_ID not set' });
      if (!listingId || !buyer) return sendJson(res, 400, { error: 'listingId and buyer required' });
      const dbh = await getDb();
      const listing = await dbh.getListingById(listingId);
      if (!listing) return sendJson(res, 404, { error: 'listing not found or inactive' });
      if (listing.cancelled || listing.soldAt) return sendJson(res, 404, { error: 'listing not found or inactive' });
      if (String(listing.seller) === String(buyer)) return sendJson(res, 400, { error: 'buyer cannot be the seller' });

      const programId = new PublicKey(process.env.MARKET_PROGRAM_ID);
      const mintPk = new PublicKey(listing.mint);
      const sellerPk = new PublicKey(listing.seller);
      const buyerPk = new PublicKey(buyer);
      // Ensure NFT still sits in escrow before building tx
      const stillAvailable = await escrowHasNft(listing.mint);
      if (!stillAvailable) return sendJson(res, 410, { error: 'listing no longer available' });
      const listingPda = PublicKey.findProgramAddressSync([Buffer.from('listing'), mintPk.toBuffer()], programId)[0];
      const { getAssociatedTokenAddress } = await import('@solana/spl-token');
      const buyerAta = await getAssociatedTokenAddress(mintPk, buyerPk);
      const escrowAta = await getAssociatedTokenAddress(mintPk, listingPda, true);

      // Anchor discriminator for global:buy
      const data = createHash('sha256').update('global:buy').digest().subarray(0,8);
      const keys = [
        { pubkey: buyerPk, isSigner: true, isWritable: true },
        { pubkey: sellerPk, isSigner: false, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: listingPda, isSigner: false, isWritable: true },
        { pubkey: escrowAta, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
        { pubkey: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      ];
      const { Transaction } = await import('@solana/web3.js');
      const ix = new (await import('@solana/web3.js')).TransactionInstruction({ programId, keys, data });
      const tx = new Transaction();
      tx.feePayer = buyerPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    // POST /api/market/sold { listingId, buyer }
    if (pathname === '/api/market/sold' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { listingId, buyer } = body || {};
      if (!listingId || !buyer) return sendJson(res, 400, { error: 'listingId and buyer required' });
      const dbh = await getDb();
      const l = await dbh.getListingById(listingId);
      if (!l || l.cancelled || l.soldAt) return sendJson(res, 404, { error: 'listing not found or inactive' });
      if (String(l.seller) === String(buyer)) return sendJson(res, 400, { error: 'buyer cannot be the seller' });

      // Basic verification: escrow no longer holds the NFT, or buyer now holds it
      const escrowEmpty = !(await escrowHasNft(l.mint));
      const buyerOwns = await ownsNft(buyer, l.mint);
      if (!escrowEmpty && !buyerOwns) {
        return sendJson(res, 400, { error: 'sale not observed on-chain yet' });
      }

      await dbh.markSold({ listingId, buyer });
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/market/cancel { listingId, seller }
    if (pathname === '/api/market/cancel' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { listingId, seller } = body || {};
      if (!listingId || !seller) return sendJson(res, 400, { error: 'listingId and seller required' });
      const dbh = await getDb();
      const l = await dbh.getListingById(listingId);
      if (!l) return sendJson(res, 404, { error: 'listing not found' });
      if (l.seller !== seller) return sendJson(res, 403, { error: 'only seller can cancel' });
      await dbh.cancelListing({ listingId });
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/market/buy-link?listingId=
    if (pathname === '/api/market/buy-link' && req.method === 'GET') {
      const { listingId } = query || {};
      if (!listingId) return sendJson(res, 400, { error: 'listingId required' });
      const dbh = await getDb();
      const l = await dbh.getListingById(listingId);
      if (!l) return sendJson(res, 404, { error: 'listing not found or inactive' });
      if (l.cancelled || l.soldAt) return sendJson(res, 404, { error: 'listing not found or inactive' });
      const url = buildAggItemUrl(l.mint, l.collectionId);
      if (!url) return sendJson(res, 501, { error: 'Aggregator item URL template not configured' });
      return sendJson(res, 200, { url });
    }

    return false; // not handled
  } catch (e) {
    console.error('market route error:', e);
    return sendJson(res, 500, { error: 'market error' });
  }
}
