#!/usr/bin/env node
import 'dotenv/config';
import http from 'http';
import crypto from 'crypto';
import { readFile, writeFile, stat } from 'fs/promises';
import fs from 'fs';
import path from 'path';
import url from 'url';
import bs58 from 'bs58';
// Use global fetch/FormData/Blob available in Node 18+
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { tryHandleMarketRoute } from './marketplace.js';
import { getDb, getDbType } from './db.js';
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getAssociatedTokenAddress,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from '@solana/spl-token';
// We will deep-import serializers to build raw web3 instructions.
import { getCreateMetadataAccountV3InstructionDataSerializer as getMetaSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMetadataAccountV3.js';
import { getCreateMasterEditionV3InstructionDataSerializer as getMeSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMasterEditionV3.js';
import { getUpdateMetadataAccountV2InstructionDataSerializer as getUpdateMetaSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/updateMetadataAccountV2.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Config
const RPC = process.env.CARV_RPC || process.env.CARV_SVM_RPC || 'https://rpc.testnet.carv.io/rpc';
const NETWORK = process.env.CARV_NETWORK || 'carv-testnet';
const COLLECTION_PROGRAM_ID = new PublicKey(process.env.COLLECTION_PROGRAM_ID || 'COLLECT11111111111111111111111111111111111');
// Legacy JSON path retained for static file fallback only (DB layer handles persistence)
const DATA_PATH = path.resolve('./data.json');
const PORT = Number(process.env.PORT || 8080);

if (!process.env.PRIVATE_KEY_BASE58) {
  console.error('Missing PRIVATE_KEY_BASE58 in .env');
  process.exit(1);
}

const deployer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_BASE58));
const conn = new Connection(RPC, 'confirmed');

// Token Metadata Program ID (constant)
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Cached SOL price (USD) via CoinMarketCap
let __solQuote = null; // { usd, ts }
async function getSolUsd() {
  const now = Date.now();
  if (__solQuote && now - __solQuote.ts < 60_000) return __solQuote.usd;
  const key = process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=SOL&convert=USD', {
      headers: { 'X-CMC_PRO_API_KEY': key, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error('cmc http ' + r.status);
    const j = await r.json();
    const usd = j?.data?.SOL?.quote?.USD?.price;
    if (typeof usd === 'number' && isFinite(usd)) {
      __solQuote = { usd, ts: now };
      return usd;
    }
  } catch (e) {
    console.error('CMC price fetch failed:', e.message || e);
  }
  return null;
}

// All persistence now handled by db.js (SQLite or file-fallback)

function findMetadataPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}
function findMasterEditionPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from('edition')],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

function createCreateMetadataAccountV3Instruction({ metadata, mint, mintAuthority, payer, updateAuthority, data, isMutable = true, collectionDetails = null }) {
  const keys = [
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: mintAuthority, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: updateAuthority, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  const dataBuf = Buffer.from(
    getMetaSer().serialize({ data, isMutable, collectionDetails })
  );
  return new TransactionInstruction({ keys, programId: TOKEN_METADATA_PROGRAM_ID, data: dataBuf });
}

function createCreateMasterEditionV3Instruction({ edition, mint, updateAuthority, mintAuthority, payer, metadata, maxSupply = 0 }) {
  const keys = [
    { pubkey: edition, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: updateAuthority, isSigner: true, isWritable: false },
    { pubkey: mintAuthority, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  const dataBuf = Buffer.from(
    getMeSer().serialize({ maxSupply })
  );
  return new TransactionInstruction({ keys, programId: TOKEN_METADATA_PROGRAM_ID, data: dataBuf });
}

function createUpdateMetadataAccountV2Instruction({ metadata, updateAuthority, data, newUpdateAuthority = null, primarySaleHappened = null, isMutable = null }) {
  const keys = [
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: updateAuthority, isSigner: true, isWritable: false },
  ];
  const dataBuf = Buffer.from(
    getUpdateMetaSer().serialize({ updateMetadataAccountArgsV2: { data, updateAuthority: newUpdateAuthority, primarySaleHappened, isMutable } })
  );
  return new TransactionInstruction({ keys, programId: TOKEN_METADATA_PROGRAM_ID, data: dataBuf });
}

// Build a client-signable transaction to mint a 1/1 NFT to `payer`.
// Optionally prepends a SOL payment to `paymentTo` for `paymentLamports`.
// After creating the Master Edition, we transfer metadata update authority
// to `finalUpdateAuthority` (usually the collection owner) so that minters
// are NOT the update authority.
async function buildMintNftTx({ payer, mintPubkey, name, symbol, metadataUri, paymentLamports = 0, paymentTo = null, finalUpdateAuthority = null }) {
  const payerPk = new PublicKey(payer);
  const mintPk = new PublicKey(mintPubkey);
  const metadataPda = findMetadataPda(mintPk);
  const masterEditionPda = findMasterEditionPda(mintPk);
  const ata = await getAssociatedTokenAddress(mintPk, payerPk);

  const lamportsForMint = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);

  const ixes = [];
  // If a payment is required, add it as the first instruction so it executes atomically with mint
  const lamportsToPay = Number(paymentLamports || 0);
  if (paymentTo && lamportsToPay > 0) {
    const toPk = new PublicKey(paymentTo);
    // Always include the transfer, even if payer == recipient.
    // When from == to, SystemProgram.transfer still requires the payer
    // to have at least `lamportsToPay` available, enforcing the price.
    ixes.push(SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: toPk, lamports: lamportsToPay }));
  }
  ixes.push(SystemProgram.createAccount({
    fromPubkey: payerPk,
    newAccountPubkey: mintPk,
    space: MINT_SIZE,
    lamports: lamportsForMint,
    programId: TOKEN_PROGRAM_ID,
  }));
  ixes.push(createInitializeMintInstruction(mintPk, 0, payerPk, payerPk));
  ixes.push(createAssociatedTokenAccountInstruction(payerPk, ata, payerPk, mintPk));
  ixes.push(createMintToInstruction(mintPk, ata, payerPk, 1));

  const dataV2 = {
    name,
    symbol,
    uri: metadataUri,
    sellerFeeBasisPoints: 0,
    creators: null,
    collection: null,
    uses: null,
  };
  ixes.push(
    createCreateMetadataAccountV3Instruction({
      metadata: metadataPda,
      mint: mintPk,
      mintAuthority: payerPk,
      payer: payerPk,
      // Set temporary update authority to payer so they can sign follow-up ops
      updateAuthority: payerPk,
      data: dataV2,
      isMutable: true,
      collectionDetails: null,
    })
  );
  ixes.push(
    createCreateMasterEditionV3Instruction({
      edition: masterEditionPda,
      mint: mintPk,
      // Master edition creation expects current update authority; still payer
      updateAuthority: payerPk,
      mintAuthority: payerPk,
      payer: payerPk,
      metadata: metadataPda,
      maxSupply: 0,
    })
  );

  // If a final update authority is provided and differs from payer,
  // hand over authority within the same transaction.
  if (finalUpdateAuthority) {
    try {
      const newAuth = new PublicKey(finalUpdateAuthority);
      if (!newAuth.equals(payerPk)) {
        ixes.push(
          createUpdateMetadataAccountV2Instruction({
            metadata: metadataPda,
            updateAuthority: payerPk, // current authority (signer)
            data: null,               // keep metadata unchanged
            newUpdateAuthority: newAuth,
            primarySaleHappened: null,
            isMutable: true,
          })
        );
      }
    } catch {}
  }

  const tx = new Transaction();
  tx.feePayer = payerPk;
  ixes.forEach((ix) => tx.add(ix));
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;
  // Important: server does not sign; client must sign with wallet AND the mint keypair
  return tx;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end(body);
}

// Anchor-style discriminator for "global:init_collection"
function anchorIxDisc(name) {
  const ns = `global:${name}`;
  const h = crypto.createHash('sha256').update(ns).digest();
  return h.subarray(0, 8);
}

function borshString(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

function borshU64(n) {
  const buf = Buffer.alloc(8);
  const bn = BigInt(Math.round(Number(n || 0)));
  buf.writeBigUInt64LE(bn);
  return buf;
}

function borshU32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Math.max(0, Math.min(0xffffffff, Number(n || 0)|0)));
  return buf;
}

function sha256Bytes(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

async function getParsedBody(req, limitBytes = 1_000_000) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limitBytes) {
        try { req.destroy(); } catch {}
        reject(new Error('request too large'));
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const base = path.join(__dirname, 'public');
  let filePath = path.join(base, pathname);
  let fallbackTried = false;
  if (pathname === '/') {
    filePath = path.join(base, 'index.html');
  } else if (!path.extname(pathname)) {
    // Map clean routes to html files, e.g. /deploy -> /public/deploy.html
    const clean = pathname.replace(/^\/+/, '');
    // Special-case dynamic market collection route: /market/<slug>
    if (/^market\/[^/]+$/.test(clean)) {
      filePath = path.join(base, 'market-collection.html');
    } else {
      filePath = path.join(base, `${clean}.html`);
    }
  }
  while (true) {
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
      const ext = path.extname(filePath).toLowerCase();
      const type = ext === '.html' ? 'text/html' :
        ext === '.css' ? 'text/css' :
        ext === '.js' ? 'application/javascript' :
        ext === '.png' ? 'image/png' :
        (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
      const headers = { 'Content-Type': type };
      // Basic CSP for HTML responses
      if (ext === '.html') {
        headers['Content-Security-Policy'] = [
          "default-src 'self'",
          "script-src 'self' https://esm.sh",
          "style-src 'self' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com data:",
          "img-src 'self' data: https:",
          "connect-src 'self' https:",
          "object-src 'none'",
          "base-uri 'self'",
          "frame-ancestors 'self'",
        ].join('; ');
      }
      // Modest caching for static assets (not HTML)
      if (ext !== '.html') {
        headers['Cache-Control'] = 'public, max-age=3600';
      } else {
        headers['Cache-Control'] = 'no-cache';
      }
      fs.createReadStream(filePath)
        .once('error', () => sendJson(res, 404, { error: 'Not found' }))
        .once('open', () => res.writeHead(200, headers))
        .pipe(res);
      return;
    } catch {
      // Security: restrict any fallback to a tiny whitelist of known assets
      const allowed = new Set(['/polos.jpg', '/poke.jpg']);
      if (!fallbackTried && allowed.has(pathname)) {
        const rootPath = path.join(__dirname, pathname);
        try {
          const st2 = await stat(rootPath);
          const ext2 = path.extname(rootPath).toLowerCase();
          const type2 = (ext2 === '.jpg' || ext2 === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
          fs.createReadStream(rootPath)
            .once('error', () => sendJson(res, 404, { error: 'Not found' }))
            .once('open', () => res.writeHead(200, { 'Content-Type': type2, 'Cache-Control': 'public, max-age=3600' }))
            .pipe(res);
          return;
        } catch {}
      }
      return sendJson(res, 404, { error: 'Not found' });
    }
  }
}

export async function handleRequest(req, res) {
  try {
    const parsed = url.parse(req.url, true);
    const { pathname, query } = parsed;

    // API routes
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, { rpc: RPC, network: NETWORK });
    }
    if (pathname === '/api/sol-price' && req.method === 'GET') {
      const usd = await getSolUsd();
      return sendJson(res, 200, { usd, source: 'coinmarketcap', cached: __solQuote && (Date.now() - __solQuote.ts) < 60_000 });
    }
    if (pathname === '/api/debug/db' && req.method === 'GET') {
      // Returns which DB backend is active
      await getDb();
      return sendJson(res, 200, { backend: getDbType() });
    }
    // Marketplace routes (delegated to a separate module to avoid clutter)
    const maybeHandled = await tryHandleMarketRoute(req, res, pathname, query);
    if (maybeHandled !== false) return; // responded
    if (pathname === '/api/collections' && req.method === 'GET') {
      const dbh = await getDb();
      const rows = await dbh.getCollections();
      const list = rows.map((c) => ({
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        image: c.image_gateway || null,
        priceLamports: c.priceLamports,
        supply: c.supply,
        minted_count: c.minted_count,
        metadata_uri: c.metadata_gateway || c.metadata_uri || null,
      }));
      return sendJson(res, 200, { collections: list });
    }

    if (pathname === '/api/minted' && req.method === 'GET') {
      const { id } = query || {};
      if (!id) return sendJson(res, 400, { error: 'id required' });
      const dbh = await getDb();
      const { mints, image_gateway } = await dbh.getMintsForCollection(id);
      if (!mints) return sendJson(res, 404, { error: 'collection not found' });
      return sendJson(res, 200, { minted: mints || [], image: image_gateway || null });
    }

    if (pathname === '/api/holdings' && req.method === 'GET') {
      const { owner: ownerStr, id } = query || {};
      if (!ownerStr || !id) return sendJson(res, 400, { error: 'owner and id required' });
      const owner = new PublicKey(ownerStr);
      const dbh = await getDb();
      const { mints, image_gateway } = await dbh.getMintsForCollection(id);
      if (!mints) return sendJson(res, 404, { error: 'collection not found' });
      const mintedMints = new Set(mints || []);
      if (mintedMints.size === 0) return sendJson(res, 200, { items: [] });
      const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
      const items = [];
      for (const { account } of resp.value) {
        try {
          const info = account.data.parsed.info;
          const mint = info.mint;
          const amount = info.tokenAmount?.amount || '0';
          const decimals = Number(info.tokenAmount?.decimals ?? 0);
          if (decimals === 0 && amount === '1' && mintedMints.has(mint)) {
            items.push({ mint, image: image_gateway || null });
          }
        } catch {}
      }
      return sendJson(res, 200, { items });
    }

    if (pathname === '/api/holdings-all' && req.method === 'GET') {
      const { owner: ownerStr } = query || {};
      if (!ownerStr) return sendJson(res, 400, { error: 'owner required' });
      const owner = new PublicKey(ownerStr);
      const dbh = await getDb();

      // Build set of mint addresses held by owner (0-decimal NFTs, amount == 1)
      const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
      const held = new Set();
      for (const { account } of resp.value) {
        try {
          const info = account.data.parsed.info;
          const mint = info.mint;
          const amount = info.tokenAmount?.amount || '0';
          const decimals = Number(info.tokenAmount?.decimals ?? 0);
          if (decimals === 0 && amount === '1') held.add(mint);
        } catch {}
      }

      const items = [];
      const cols = await dbh.getCollectionsWithMints();
      for (const c of cols) {
        for (const mint of c.mints) {
          if (held.has(mint)) items.push({ mint, collectionId: c.id, name: c.name, symbol: c.symbol, image: c.image_gateway || null });
        }
      }
      return sendJson(res, 200, { items });
    }

    if (pathname === '/api/tx/mint-nft' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, payer, mintPubkey } = body || {};
      if (!id || !payer || !mintPubkey) return sendJson(res, 400, { error: 'id, payer, mintPubkey required' });
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });

      const maxSupply = Number(cfg.supply ?? 0);
      const mintedCount = Number(cfg.minted_count ?? 0);
      if (maxSupply && mintedCount + 1 > maxSupply) {
        return sendJson(res, 400, { error: 'sold out or insufficient remaining supply' });
      }

      const tx = await buildMintNftTx({
        payer,
        mintPubkey,
        name: cfg.name || 'CARV NFT',
        symbol: cfg.symbol || 'CARV',
        metadataUri: cfg.metadata_gateway || cfg.metadata_uri,
        // If price is set, collect SOL to deployer in the same transaction
        paymentLamports: Number(cfg.priceLamports || 0) || 0,
        paymentTo: cfg.owner || null,
        finalUpdateAuthority: cfg.owner || null,
      });
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    // Atomic create-collection + build mint tx (avoids cross-request persistence issues)
    if (pathname === '/api/deploy-and-mint' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { name, symbol, supply = 0, price = 0, imageCid, metadataUri, metadataGateway, owner, payer, mintPubkey } = body || {};
      if (!name || !symbol || !metadataUri || !owner || !payer || !mintPubkey) {
        return sendJson(res, 400, { error: 'name, symbol, metadataUri, owner, payer, mintPubkey required' });
      }
      const parsedSupply = Number(supply);
      if (!Number.isInteger(parsedSupply) || parsedSupply < 10 || parsedSupply > 100000) {
        return sendJson(res, 400, { error: 'supply must be an integer between 10 and 100000' });
      }
      const dbh = await getDb();
      const id = await dbh.createCollection({ name, symbol, supply: parsedSupply, priceLamports: Math.round(Number(price || 0) * LAMPORTS_PER_SOL), imageCid, metadataUri, metadataGateway, owner });
      const cfg = await dbh.getCollectionById(id);
      const tx = await buildMintNftTx({
        payer,
        mintPubkey,
        name: cfg.name || name,
        symbol: cfg.symbol || symbol,
        metadataUri: cfg.metadata_gateway || cfg.metadata_uri,
        paymentLamports: Number(cfg.priceLamports || 0) || 0,
        paymentTo: cfg.owner || null,
        finalUpdateAuthority: cfg.owner || null,
      });
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { id, tx: Buffer.from(serialized).toString('base64') });
    }

    // Build an UpdateMetadata tx to change the URI (e.g., to a gateway URL)
    if (pathname === '/api/tx/update-metadata' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { mint, payer, name, symbol, metadataUri } = body || {};
      if (!mint || !payer || !metadataUri) return sendJson(res, 400, { error: 'mint, payer, metadataUri required' });
      const mintPk = new PublicKey(mint);
      const payerPk = new PublicKey(payer);
      const metadataPda = findMetadataPda(mintPk);

      const dataV2 = {
        name: name || 'CARV NFT',
        symbol: symbol || 'CARV',
        uri: metadataUri,
        sellerFeeBasisPoints: 0,
        creators: null,
        collection: null,
        uses: null,
      };

      const ix = createUpdateMetadataAccountV2Instruction({
        metadata: metadataPda,
        updateAuthority: payerPk,
        data: dataV2,
        newUpdateAuthority: null,
        primarySaleHappened: null,
        isMutable: true,
      });

      const tx = new Transaction();
      tx.feePayer = payerPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    // Build tx to initialize on-chain collection PDA via our Anchor program
    if (pathname === '/api/tx/init-collection' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { payer, owner, name, symbol, metadataUri, price = 0, supply = 0 } = body || {};
      if (!payer || !owner || !name || !symbol || !metadataUri) return sendJson(res, 400, { error: 'payer, owner, name, symbol, metadataUri required' });

      const payerPk = new PublicKey(payer);
      const ownerPk = new PublicKey(owner);
      const seeds = [Buffer.from('collection'), ownerPk.toBuffer(), sha256Bytes(symbol)];
      const [collectionPda] = PublicKey.findProgramAddressSync(seeds, COLLECTION_PROGRAM_ID);

      const keys = [
        { pubkey: payerPk, isSigner: true, isWritable: true },
        { pubkey: ownerPk, isSigner: true, isWritable: false },
        { pubkey: collectionPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const data = Buffer.concat([
        anchorIxDisc('init_collection'),
        borshString(String(name)),
        borshString(String(symbol)),
        borshString(String(metadataUri)),
        borshU64(Math.round(Number(price || 0) * LAMPORTS_PER_SOL)),
        borshU32(Number(supply || 0)),
      ]);
      const ix = new TransactionInstruction({ keys, programId: COLLECTION_PROGRAM_ID, data });
      const tx = new Transaction();
      tx.feePayer = payerPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), collectionPda: collectionPda.toBase58() });
    }

    // Program mint (Anchor) — mints via on-chain program with locked metadata
    if (pathname === '/api/tx/program-mint' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, payer, recipient, nonce, lock = true } = body || {};
      if (!id || !payer) return sendJson(res, 400, { error: 'id, payer required' });
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      const payerPk = new PublicKey(payer);
      const ownerPk = new PublicKey(cfg.owner);
      const recPk = new PublicKey(recipient || payer);
      const priceLamports = Number(cfg.priceLamports || 0) || 0;

      // Derive collection PDA: ["collection", owner, sha256(symbol)]
      const seeds = [Buffer.from('collection'), ownerPk.toBuffer(), sha256Bytes(cfg.symbol)];
      const [collectionPda] = PublicKey.findProgramAddressSync(seeds, COLLECTION_PROGRAM_ID);

      // Derive authority PDA ["auth", collectionPda]
      const [authorityPda] = PublicKey.findProgramAddressSync([Buffer.from('auth'), collectionPda.toBuffer()], COLLECTION_PROGRAM_ID);

      // Derive mint PDA using client-provided nonce
      const nonceU64 = BigInt(Math.max(1, Number(nonce || Date.now() % 2**31)));
      const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(nonceU64);
      const [mintPda] = PublicKey.findProgramAddressSync([Buffer.from('mint'), collectionPda.toBuffer(), nonceBuf], COLLECTION_PROGRAM_ID);

      // Metaplex PDAs
      const [metadataPda] = PublicKey.findProgramAddressSync([
        Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPda.toBuffer()
      ], TOKEN_METADATA_PROGRAM_ID);
      const [editionPda] = PublicKey.findProgramAddressSync([
        Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPda.toBuffer(), Buffer.from('edition')
      ], TOKEN_METADATA_PROGRAM_ID);

      // Recipient ATA
      const ata = await getAssociatedTokenAddress(mintPda, recPk);

      const keys = [
        { pubkey: payerPk, isSigner: true, isWritable: true },
        { pubkey: ownerPk, isSigner: false, isWritable: true },
        { pubkey: recPk, isSigner: false, isWritable: false },
        { pubkey: collectionPda, isSigner: false, isWritable: true },
        { pubkey: authorityPda, isSigner: false, isWritable: false },
        { pubkey: mintPda, isSigner: false, isWritable: true },
        { pubkey: metadataPda, isSigner: false, isWritable: true },
        { pubkey: editionPda, isSigner: false, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      ];
      const data = Buffer.concat([
        anchorIxDisc('mint'),
        (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(nonceU64); return b; })(),
        Buffer.from([lock ? 1 : 0]),
      ]);
      const ix = new TransactionInstruction({ keys, programId: COLLECTION_PROGRAM_ID, data });
      const tx = new Transaction();
      tx.feePayer = payerPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), mint: mintPda.toBase58() });
    }

    // Convenience: fix-image for a collection mint — pins metadata with HTTPS image and builds update tx
    if (pathname === '/api/tx/fix-image' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, mint, payer } = body || {};
      if (!id || !mint || !payer) return sendJson(res, 400, { error: 'id, mint, payer required' });
      const db = await loadDB();
      const cfg = db[id];
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      if (!process.env.PINATA_JWT) return sendJson(res, 400, { error: 'PINATA_JWT not configured' });

      // Pin a fresh metadata JSON using gateway image URL
      const metaBody = {
        name: cfg.collectionName || 'CARV NFT',
        symbol: cfg.symbol || 'CARV',
        description: `${cfg.collectionName || 'Collection'} NFT`,
        image: cfg.image_gateway,
        attributes: [],
        properties: { files: [{ uri: cfg.image_gateway, type: 'image/png' }] },
      };
      const r = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PINATA_JWT}` },
        body: JSON.stringify({ pinataContent: metaBody, pinataMetadata: { name: metaBody?.name || 'metadata' } }),
      });
      if (!r.ok) return sendJson(res, 500, { error: `pinJSON failed: ${r.status}` });
      const j = await r.json();
      const cid = j.IpfsHash;
      const gateway = `${process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'}/ipfs/${cid}`;

      // Return a tx that updates the on-chain metadata URI to the gateway JSON
      const { tx } = await (async () => {
        const mintPk = new PublicKey(mint);
        const payerPk = new PublicKey(payer);
        const metadataPda = findMetadataPda(mintPk);
        const dataV2 = {
          name: cfg.collectionName || 'CARV NFT',
          symbol: cfg.symbol || 'CARV',
          uri: gateway,
          sellerFeeBasisPoints: 0,
          creators: null,
          collection: null,
          uses: null,
        };
        const ix = createUpdateMetadataAccountV2Instruction({ metadata: metadataPda, updateAuthority: payerPk, data: dataV2, isMutable: true });
        const t = new Transaction();
        t.feePayer = payerPk;
        t.add(ix);
        const { blockhash } = await conn.getLatestBlockhash('finalized');
        t.recentBlockhash = blockhash;
        const serialized = t.serialize({ requireAllSignatures: false });
        return { tx: Buffer.from(serialized).toString('base64') };
      })();

      return sendJson(res, 200, { tx, metadataGateway: gateway });
    }

    if (pathname === '/api/record-mint' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, mint, minter, ts } = body || {};
      if (!id || !mint) return sendJson(res, 400, { error: 'id and mint required' });
      const dbh = await getDb();
      const coll = await dbh.getCollectionById(id);
      if (!coll) return sendJson(res, 404, { error: 'collection not found' });
      await dbh.recordMint({ id, mint, minter, ts });
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/pin/image' && req.method === 'POST') {
      // Allow larger payload for base64 data (up to ~15MB)
      const body = await getParsedBody(req, 15_000_000);
      const { filename, contentType, dataBase64, nameTag } = body || {};
      if (!process.env.PINATA_JWT) return sendJson(res, 400, { error: 'PINATA_JWT not configured' });
      if (!dataBase64) return sendJson(res, 400, { error: 'dataBase64 required' });
      const form = new FormData();
      const blob = new Blob([Buffer.from(dataBase64, 'base64')], { type: contentType || 'application/octet-stream' });
      form.append('file', blob, filename || 'image');
      form.append('pinataMetadata', JSON.stringify({ name: nameTag || filename || 'image' }));
      const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
        body: form,
      });
      if (!r.ok) {
        let bodyText = '';
        try { bodyText = await r.text(); } catch {}
        return sendJson(res, 500, { error: `pinFile failed: ${r.status}`, body: bodyText });
      }
      const j = await r.json();
      const cid = j.IpfsHash;
      return sendJson(res, 200, { imageCid: cid, imageUri: `ipfs://${cid}`, gateway: `${process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'}/ipfs/${cid}` });
    }

    if (pathname === '/api/pin/metadata' && req.method === 'POST') {
      const body = await getParsedBody(req, 2_000_000);
      if (!process.env.PINATA_JWT) return sendJson(res, 400, { error: 'PINATA_JWT not configured' });
      const r = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PINATA_JWT}` },
        body: JSON.stringify({ pinataContent: body, pinataMetadata: { name: body?.name || 'metadata' } }),
      });
      if (!r.ok) return sendJson(res, 500, { error: `pinJSON failed: ${r.status}` });
      const j = await r.json();
      const cid = j.IpfsHash;
      const gateway = `${process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'}/ipfs/${cid}`;
      return sendJson(res, 200, { metadataCid: cid, metadataUri: `ipfs://${cid}`, gateway });
    }

    if (pathname === '/api/deploy/config' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { name, symbol, supply = 0, price = 0, imageCid, metadataUri, metadataGateway, owner, onchainPda } = body || {};
      if (!name || !symbol || !metadataUri || !owner) return sendJson(res, 400, { error: 'name, symbol, metadataUri, owner required' });
      const parsedSupply = Number(supply);
      if (!Number.isInteger(parsedSupply) || parsedSupply < 10 || parsedSupply > 100000) {
        return sendJson(res, 400, { error: 'supply must be an integer between 10 and 100000' });
      }
      const dbh = await getDb();
      const id = await dbh.createCollection({ name, symbol, supply: parsedSupply, priceLamports: Math.round(Number(price || 0) * LAMPORTS_PER_SOL), imageCid, metadataUri, metadataGateway, owner, onchainPda });
      return sendJson(res, 200, { id });
    }

    if (pathname === '/api/holdings' && req.method === 'GET') {
      const { owner: ownerStr, id } = query || {};
      if (!ownerStr || !id) return sendJson(res, 400, { error: 'owner and id required' });
      const owner = new PublicKey(ownerStr);
      const db = await getDb();
      const cfg = await db.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });

      const mintedMints = new Set((cfg.mints || []));
      if (mintedMints.size === 0) return sendJson(res, 200, { items: [] });

      const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
      const items = [];
      for (const { account } of resp.value) {
        try {
          const info = account.data.parsed.info;
          const mint = info.mint;
          const amount = info.tokenAmount?.amount || '0';
          const decimals = Number(info.tokenAmount?.decimals ?? 0);
          if (decimals === 0 && amount === '1' && mintedMints.has(mint)) {
            items.push({ mint, image: cfg.image_gateway || null });
          }
        } catch {}
      }
      return sendJson(res, 200, { items });
    }

    // static files
    return await serveStatic(req, res, pathname);
  } catch (e) {
    console.error('Server error:', e);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

// Local dev server; Vercel provides its own server runtime
if (!process.env.VERCEL) {
  const server = http.createServer((req, res) => void handleRequest(req, res));
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
