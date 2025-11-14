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
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
// We will deep-import serializers to build raw web3 instructions.
import { getCreateMetadataAccountV3InstructionDataSerializer as getMetaSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMetadataAccountV3.js';
import { getCreateMasterEditionV3InstructionDataSerializer as getMeSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMasterEditionV3.js';
import { getUpdateMetadataAccountV2InstructionDataSerializer as getUpdateMetaSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/updateMetadataAccountV2.js';
import { getVerifySizedCollectionItemInstructionDataSerializer as getVerifySizedSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/verifySizedCollectionItem.js';
import { getSetCollectionSizeInstructionDataSerializer as getSetCollectionSizeSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/setCollectionSize.js';
import { getApproveCollectionAuthorityInstructionDataSerializer as getApproveCollAuthSer } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/approveCollectionAuthority.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Config
const RPC = process.env.CARV_RPC || process.env.CARV_SVM_RPC || 'https://rpc.testnet.carv.io/rpc';
const NETWORK = process.env.CARV_NETWORK || 'carv-testnet';
const COLLECTION_PROGRAM_ID = new PublicKey(process.env.COLLECTION_PROGRAM_ID || 'COLLECT11111111111111111111111111111111111');
const OFFERS_PROGRAM_ID = new PublicKey(process.env.OFFERS_PROGRAM_ID || 'OFFERS11111111111111111111111111111111111');
// CARV token mint (defaults to provided address)
const CARV_MINT = new PublicKey(process.env.CARV_MINT || 'D7WVEw9Pkf4dfCCE3fwGikRCCTvm9ipqTYPHRENLiw3s');
// Legacy JSON path retained for static file fallback only (DB layer handles persistence)
const DATA_PATH = path.resolve('./data.json');
const PORT = Number(process.env.PORT || 8080);

if (!process.env.PRIVATE_KEY_BASE58) {
  console.error('Missing PRIVATE_KEY_BASE58 in .env');
  process.exit(1);
}

const deployer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_BASE58));
// Optional separate funder wallet for user funding
const botFunderSecret = process.env.BOT_FUNDER || null;
const botFunder = botFunderSecret ? Keypair.fromSecretKey(bs58.decode(botFunderSecret)) : null;
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

// Cached CARV price (USD)
let __carvQuote = null; // { usd, ts }
async function getCarvUsd() {
  const now = Date.now();
  if (__carvQuote && now - __carvQuote.ts < 60_000) return __carvQuote.usd;
  const key = process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=CARV&convert=USD', {
      headers: { 'X-CMC_PRO_API_KEY': key, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error('cmc http ' + r.status);
    const j = await r.json();
    const usd = j?.data?.CARV?.quote?.USD?.price;
    if (typeof usd === 'number' && isFinite(usd)) {
      __carvQuote = { usd, ts: now };
      return usd;
    }
  } catch (e) {
    console.error('CMC CARV price fetch failed:', e.message || e);
  }
  return null;
}

// All persistence now handled by db.js (SQLite or file-fallback)

// Simple in-memory admin auth nonces
const __adminNonces = new Map(); // addr -> { nonce, ts }
function _gcNonces() {
  const now = Date.now();
  for (const [k, v] of __adminNonces.entries()) {
    if (!v || (now - (v.ts || 0)) > 5 * 60_000) __adminNonces.delete(k);
  }
}
function issueNonce(addr) {
  _gcNonces();
  const nonce = crypto.randomBytes(16).toString('hex');
  __adminNonces.set(String(addr), { nonce, ts: Date.now() });
  return nonce;
}
function takeNonce(addr, nonce) {
  _gcNonces();
  const cur = __adminNonces.get(String(addr));
  if (!cur || cur.nonce !== String(nonce)) return false;
  __adminNonces.delete(String(addr));
  return true;
}

function spkiFromSolPubkey(base58) {
  const raw = bs58.decode(base58);
  if (raw.length !== 32) throw new Error('bad pubkey');
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([prefix, Buffer.from(raw)]);
}
function verifyEd25519({ addr, message, signature }) {
  try {
    const key = spkiFromSolPubkey(addr);
    const sig = Buffer.isBuffer(signature) ? signature : bs58.decode(String(signature));
    return crypto.verify(null, Buffer.from(message), { key, format: 'der', type: 'spki' }, sig);
  } catch {
    return false;
  }
}

function isValidSolAddress(addr) {
  try { const b = bs58.decode(String(addr)); return b && b.length === 32; } catch { return false; }
}

// Simple AES-256-GCM encryption for wallet secrets (stored in Supabase)
const walletEncKeyRaw = process.env.WALLET_ENC_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
const walletEncKey = walletEncKeyRaw
  ? crypto.createHash('sha256').update(walletEncKeyRaw).digest()
  : null;

function encryptWalletSecret(plain) {
  if (!walletEncKey) throw new Error('WALLET_ENC_KEY (or Supabase key) not configured for wallet encryption');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', walletEncKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptWalletSecret(ciphertext) {
  if (!walletEncKey) throw new Error('WALLET_ENC_KEY (or Supabase key) not configured for wallet decryption');
  const buf = Buffer.from(String(ciphertext), 'base64');
  if (buf.length < 28) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', walletEncKey, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

async function fundNewWalletIfNeeded(pubkeyBase58) {
  if (!botFunder) return;
  try {
    const dest = new PublicKey(pubkeyBase58);
    const lamports = Math.round(0.01 * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: botFunder.publicKey,
      toPubkey: dest,
      lamports,
    }));
    tx.feePayer = botFunder.publicKey;
    const { blockhash } = await conn.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.sign(botFunder);
    await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    console.error('Failed to fund new wallet from BOT_FUNDER:', e?.message || e);
  }
}

async function resolveOrCreateDiscordWallet(discordUserId) {
  if (!discordUserId) return null;
  const dbh = await getDb();
  if (getDbType() !== 'supabase' || !dbh || typeof dbh.getUserWallet !== 'function') {
    return null;
  }
  const platform = 'discord';
  const userId = String(discordUserId);
  const id = `${platform}:${userId}`;
  let rec = await dbh.getUserWallet({ id, platform, userId });
  if (rec && rec.ownerPubkey && rec.secretCiphertext) {
    return rec;
  }
  // Create new wallet, encrypt secret, store, and fund from BOT_FUNDER
  const kp = Keypair.generate();
  const secretBase58 = bs58.encode(kp.secretKey);
  const cipher = encryptWalletSecret(secretBase58);
  const createdAt = Math.floor(Date.now() / 1000);
  await dbh.upsertUserWallet({
    id,
    platform,
    userId,
    username: null,
    ownerPubkey: kp.publicKey.toBase58(),
    secretCiphertext: cipher,
    createdAt,
  });
  await fundNewWalletIfNeeded(kp.publicKey.toBase58());
  return {
    id,
    platform,
    userId,
    username: null,
    ownerPubkey: kp.publicKey.toBase58(),
    secretCiphertext: cipher,
    createdAt,
  };
}

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

// Build a per-mint metadata URI if a template or directory-like base is provided.
// Rules:
// - If cfg.metadata_gateway or cfg.metadata_uri contains "{mint}", replace it with mint pubkey
// - Else if it ends with '/', append '<mint>.json'
// - Else if ipfs://CID without file component, append '/<mint>.json'
// - Otherwise return as-is
function resolveMetadataUriForMint(cfg, mintStr) {
  const base = (cfg?.metadata_gateway || cfg?.metadata_uri || '').trim();
  const mint = String(mintStr || '');
  if (!base) return base;
  if (base.includes('{mint}')) return base.replaceAll('{mint}', mint);
  if (base.endsWith('/')) return base + mint + '.json';
  if (base.startsWith('ipfs://') && !base.endsWith('.json') && !base.includes('/')) {
    return base + '/' + mint + '.json';
  }
  return base;
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
async function buildMintNftTx({ payer, mintPubkey, name, symbol, metadataUri, paymentLamports = 0, paymentTo = null, finalUpdateAuthority = null, finalIsMutable = true, paymentTokenMint = null, paymentAmount = 0, royaltyBps = 500, creatorAddrs = [], collectionMint = null }) {
  const payerPk = new PublicKey(payer);
  const mintPk = new PublicKey(mintPubkey);
  const metadataPda = findMetadataPda(mintPk);
  const masterEditionPda = findMasterEditionPda(mintPk);
  const ata = await getAssociatedTokenAddress(mintPk, payerPk);

  const lamportsForMint = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);

  const ixes = [];
  // If a SOL payment is required, add it as the first instruction so it executes atomically with mint
  const lamportsToPay = Number(paymentLamports || 0);
  if (paymentTo && lamportsToPay > 0 && !paymentTokenMint) {
    const toPk = new PublicKey(paymentTo);
    // Always include the transfer, even if payer == recipient.
    // When from == to, SystemProgram.transfer still requires the payer
    // to have at least `lamportsToPay` available, enforcing the price.
    ixes.push(SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: toPk, lamports: lamportsToPay }));
  }
  // Optional SPL-token payment path (e.g., CARV): supply paymentTokenMint and paymentAmount in base units
  const paymentTokenMintStr = null; // placeholder to allow future extension via overload below
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

  // Prepare creators list: include any provided creator addresses with share split.
  // We do not set creators as verified here; verification can be done separately if needed.
  let creators = null;
  try {
    const addrs = Array.from(new Set((creatorAddrs || []).filter(Boolean).map(String)));
    if (addrs.length) {
      const shareEach = Math.floor(100 / addrs.length) || 100;
      creators = addrs.map((a, i) => ({ address: new PublicKey(a), verified: (String(a) === String(payer) ? 1 : 0), share: i === 0 ? (100 - shareEach * (addrs.length - 1)) : shareEach }));
    }
  } catch {}

  const dataV2 = {
    name,
    symbol,
    uri: metadataUri,
    sellerFeeBasisPoints: Number(royaltyBps || 0) | 0,
    creators,
    collection: collectionMint ? { verified: 0, key: new PublicKey(collectionMint) } : null,
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
            isMutable: !!finalIsMutable,
          })
        );
      }
    } catch {}
  }

  // Optionally prepend SPL-token payment (CARV)
  let needsDeployerSig = false;
  if (paymentTo && paymentTokenMint && Number(paymentAmount || 0) > 0) {
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } = await import('@solana/spl-token');
    const tokenMintPk = new PublicKey(paymentTokenMint);
    const recipientPk = new PublicKey(paymentTo);
    const recipientAta = await getAssociatedTokenAddress(tokenMintPk, recipientPk);
    const payerAta = await getAssociatedTokenAddress(tokenMintPk, payerPk);
    const front = [];
    // Ensure recipient ATA (use server deployer to fund rent if missing)
    const recipInfo = await conn.getAccountInfo(recipientAta);
    if (!recipInfo) { front.push(createAssociatedTokenAccountInstruction(deployer.publicKey, recipientAta, recipientPk, tokenMintPk)); needsDeployerSig = true; }
    // Ensure payer ATA exists (payer funds their own ATA)
    const payerInfo = await conn.getAccountInfo(payerAta);
    if (!payerInfo) { front.push(createAssociatedTokenAccountInstruction(payerPk, payerAta, payerPk, tokenMintPk)); }
    // Transfer amount from payer -> recipient
    front.push(createTransferInstruction(
      payerAta,
      recipientAta,
      payerPk,
      BigInt(Math.round(Number(paymentAmount || 0)))
    ));
    // Prepend in correct order so ATAs are created before transfer
    ixes.unshift(...front);
  }

  const tx = new Transaction();
  tx.feePayer = payerPk;
  ixes.forEach((ix) => tx.add(ix));
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;
  // If we created any ATAs for token payments, server (deployer) must co-sign
  if (needsDeployerSig) {
    tx.partialSign(deployer);
  }
  // Important: client must sign with wallet AND the mint keypair
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

function checkDeployApiAuth(req) {
  const expected = (process.env.DEPLOY_API_KEY || '').trim();
  if (!expected) return true;
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || typeof header !== 'string') return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === expected;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
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

function borshPubkey(pk) {
  return new PublicKey(pk).toBuffer();
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
    // Special-case dynamic market/ mint collection routes
    if (/^market\/[^/]+$/.test(clean)) {
      filePath = path.join(base, 'market-collection.html');
    } else if (/^mint\/[^/]+$/.test(clean)) {
      filePath = path.join(base, 'mint-collection.html');
    } else {
      filePath = path.join(base, `${clean}.html`);
    }
  }
  function borshU8(n) { const b = Buffer.alloc(1); b.writeUInt8(Math.max(0, Math.min(255, Number(n||0)|0))); return b; }
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
      return sendJson(res, 200, { rpc: RPC, network: NETWORK, offersProgramId: OFFERS_PROGRAM_ID.toBase58(), collectionProgramId: COLLECTION_PROGRAM_ID.toBase58() });
    }
    // Internal: fetch or create a per-Discord-user wallet and return its public key.
    if (pathname === '/api/discord/wallet' && req.method === 'POST') {
      if (!checkDeployApiAuth(req)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      const body = await getParsedBody(req);
      const { discord_user_id } = body || {};
      if (!discord_user_id) return sendJson(res, 400, { error: 'discord_user_id required' });
      try {
        const wallet = await resolveOrCreateDiscordWallet(discord_user_id);
        if (!wallet || !wallet.ownerPubkey) {
          return sendJson(res, 500, { error: 'failed to resolve wallet' });
        }
        return sendJson(res, 200, { pubkey: wallet.ownerPubkey });
      } catch (e) {
        console.error('discord wallet endpoint failed:', e?.message || e);
        return sendJson(res, 500, { error: 'internal wallet error' });
      }
    }
    // Public: search collections by (partial) name, returning ids and basic info.
    if (pathname === '/api/collections/search' && req.method === 'GET') {
      const { name } = query || {};
      const q = String(name || '').trim();
      if (!q) return sendJson(res, 400, { error: 'name required' });
      const dbh = await getDb();
      try {
        let items = [];
        if (typeof dbh.searchCollectionsByName === 'function') {
          items = await dbh.searchCollectionsByName(q);
        } else if (typeof dbh.getCollections === 'function') {
          const cols = await dbh.getCollections();
          const tgt = q.toLowerCase();
          items = (cols || [])
            .filter((c) => c.name && c.name.toLowerCase().includes(tgt))
            .map((c) => ({
              id: c.id,
              name: c.name,
              symbol: c.symbol,
              image_gateway: c.image_gateway || null,
              priceLamports: c.priceLamports,
              limitOnePerWallet: !!c.limitOnePerWallet,
            }));
        }
        return sendJson(res, 200, { items });
      } catch (e) {
        console.error('collections search failed:', e?.message || e);
        return sendJson(res, 500, { error: 'search failed' });
      }
    }
    // Pre-check if a collection PDA exists for { owner, symbol }
    if (pathname === '/api/collections/check-symbol' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { owner, symbol } = body || {};
      if (!owner || !symbol) return sendJson(res, 400, { error: 'owner and symbol required' });
      try {
        const ownerPk = new PublicKey(owner);
        // PDA seeds are ['collection', owner, sha256(symbol)] — same as init route
        const seeds = [Buffer.from('collection'), ownerPk.toBuffer(), sha256Bytes(String(symbol))];
        const [collectionPda] = PublicKey.findProgramAddressSync(seeds, COLLECTION_PROGRAM_ID);
        let exists = false;
        try {
          const info = await conn.getAccountInfo(collectionPda, 'confirmed');
          exists = !!(info && info.owner && info.owner.equals(COLLECTION_PROGRAM_ID));
        } catch {}
        return sendJson(res, 200, { exists, collectionPda: collectionPda.toBase58() });
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid owner or symbol' });
      }
    }
    // Admin auth: issue nonce bound to wallet address
    if (pathname === '/api/admin/nonce' && req.method === 'GET') {
      const { addr } = query || {};
      if (!addr) return sendJson(res, 400, { error: 'addr required' });
      const nonce = issueNonce(addr);
      const msg = `neoland admin\naddr:${addr}\nnonce:${nonce}\naction:update-collection`;
      return sendJson(res, 200, { nonce, message: msg });
    }
    // Admin update endpoint (signed-message auth)
    if (pathname === '/api/admin/update-collection' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, addr, nonce, signature, patch } = body || {};
      if (!id || !addr || !nonce || !signature || !patch || typeof patch !== 'object') {
        return sendJson(res, 400, { error: 'id, addr, nonce, signature, patch required' });
      }
      // Verify nonce and signature
      if (!takeNonce(addr, nonce)) return sendJson(res, 400, { error: 'invalid or expired nonce' });
      // Normalize patch to a stable JSON for signing
      const allowedKeys = [
        'priceSol',
        'price_lamports',
        'mintStartTs',
        'mintEndTs',
        'supply',
        'tradingPaused',
        'mintPaused',
        'lockNewMints',
        'royaltyBps',
        // enable verified collection via manage flow
        'collectionMint',
        'collectionCoverCid',
        'collectionCoverGateway',
        'collectionMetaUri',
        'collectionMetaGateway',
      ];
      const canon = {};
      for (const k of allowedKeys) { if (k in patch) canon[k] = patch[k]; }
      const msg = `neoland admin\naddr:${addr}\nnonce:${nonce}\naction:update-collection\nid:${id}\npatch:${JSON.stringify(canon)}`;
      const ok = verifyEd25519({ addr, message: msg, signature });
      if (!ok) return sendJson(res, 401, { error: 'bad signature' });

      const dbh = await getDb();
      const coll = await dbh.getCollectionById(id);
      if (!coll) return sendJson(res, 404, { error: 'collection not found' });
      if (String(coll.owner) !== String(addr)) return sendJson(res, 403, { error: 'not collection owner' });

      // Build validated updates per rules
      const updates = {};
      const now = Math.floor(Date.now() / 1000);
      const start = coll.mintStartTs != null ? Number(coll.mintStartTs) : null;
      const end = coll.mintEndTs != null ? Number(coll.mintEndTs) : null;
      // Price
      if (canon.price_lamports != null || canon.priceSol != null) {
        const lamports = canon.price_lamports != null ? Number(canon.price_lamports || 0) : Math.round(Number(canon.priceSol || 0) * LAMPORTS_PER_SOL);
        updates.price_lamports = Math.max(0, lamports|0);
      }
      // Supply: clamp to [10, 100000] and cannot go below minted_count
      if (canon.supply != null) {
        const req = Number(canon.supply || 0);
        const floor = Math.max(10, Number(coll.minted_count || 0));
        const ceil = 100000;
        const clamped = Math.max(floor, Math.min(ceil, req));
        updates.supply = clamped;
      }
      // Royalty (basis points 0..10000)
      if (canon.royaltyBps != null) {
        let bps = Number(canon.royaltyBps || 0);
        if (!Number.isFinite(bps) || bps < 0) bps = 0;
        if (bps > 2500) bps = 2500; // max 25%
        updates.royalty_bps = bps;
      }
      // Mint window rules
      if ('mintStartTs' in canon || 'mintEndTs' in canon) {
        const reqStart = canon.mintStartTs != null ? Number(canon.mintStartTs) : null;
        const reqEnd = canon.mintEndTs != null ? Number(canon.mintEndTs) : null;
        // If not started yet, allow start+end edits; once started, only allow end edits
        const hasStarted = start != null ? (now >= start) : false;
        const nextStart = hasStarted ? start : (reqStart != null ? reqStart : start);
        const nextEnd = reqEnd != null ? reqEnd : end;
        if (nextStart != null && nextEnd != null && nextEnd <= nextStart) {
          return sendJson(res, 400, { error: 'end must be after start' });
        }
        if (!hasStarted && 'mintStartTs' in canon) updates.mint_start_ts = nextStart != null ? Number(nextStart) : null;
        if ('mintEndTs' in canon) updates.mint_end_ts = nextEnd != null ? Number(nextEnd) : null;
      }
      // Trading pause flag
      if ('tradingPaused' in canon) updates.trading_paused = !!canon.tradingPaused;
      if ('mintPaused' in canon) updates.mint_paused = !!canon.mintPaused;
      if ('lockNewMints' in canon) updates.lock_new_mints = !!canon.lockNewMints;
      // Optional verified collection fields
      if ('collectionMint' in canon && canon.collectionMint) updates.collection_mint = String(canon.collectionMint);
      if ('collectionCoverCid' in canon) updates.collection_cover_cid = canon.collectionCoverCid || null;
      if ('collectionCoverGateway' in canon) updates.collection_cover_gateway = canon.collectionCoverGateway || null;
      if ('collectionMetaUri' in canon) updates.collection_meta_uri = canon.collectionMetaUri || null;
      if ('collectionMetaGateway' in canon) updates.collection_meta_gateway = canon.collectionMetaGateway || null;

      // Apply
      await dbh.updateCollectionFields(id, updates);

      // Audit logs
      try {
        if ('tradingPaused' in canon) {
          await dbh.addActivity({ collectionId: id, type: canon.tradingPaused ? 'admin_pause' : 'admin_resume', ts: now, actor1: addr });
        }
        if ('supply' in canon) await dbh.addActivity({ collectionId: id, type: 'admin_supply', ts: now, actor1: addr });
        if ('price_lamports' in canon || 'priceSol' in canon) await dbh.addActivity({ collectionId: id, type: 'admin_price', ts: now, actor1: addr });
        if ('royaltyBps' in canon) await dbh.addActivity({ collectionId: id, type: 'admin_royalty', ts: now, actor1: addr });
        if ('mintStartTs' in canon || 'mintEndTs' in canon) await dbh.addActivity({ collectionId: id, type: 'admin_window', ts: now, actor1: addr });
      } catch {}

      const updated = await dbh.getCollectionById(id);
      return sendJson(res, 200, { ok: true, collection: updated });
    }
    if (pathname === '/api/sol-price' && req.method === 'GET') {
      const usd = await getSolUsd();
      return sendJson(res, 200, { usd, source: 'coinmarketcap', cached: __solQuote && (Date.now() - __solQuote.ts) < 60_000 });
    }
    if (pathname === '/api/prices' && req.method === 'GET') {
      const [solUsd, carvUsd] = await Promise.all([getSolUsd(), getCarvUsd()]);
      let carvPerSol = null;
      if (solUsd && carvUsd) carvPerSol = solUsd / carvUsd;
      return sendJson(res, 200, { solUsd, carvUsd, carvPerSol, source: 'coinmarketcap' });
    }
    // Public: fetch whitelist for a collection (addresses array)
    if (pathname === '/api/whitelist' && req.method === 'GET') {
      const { id } = query || {};
      if (!id) return sendJson(res, 400, { error: 'id required' });
      try { const dbh = await getDb(); const wl = await dbh.getWhitelist(id); return sendJson(res, 200, { addresses: wl }); } catch { return sendJson(res, 200, { addresses: [] }); }
    }
    // Admin: update whitelist with signed auth
    if (pathname === '/api/admin/whitelist' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, addr, nonce, signature, addresses } = body || {};
      if (!id || !addr || !nonce || !signature || !Array.isArray(addresses)) {
        return sendJson(res, 400, { error: 'id, addr, nonce, signature, addresses[] required' });
      }
      if (!takeNonce(addr, nonce)) return sendJson(res, 400, { error: 'invalid or expired nonce' });
      const canon = Array.from(new Set((addresses || []).filter(isValidSolAddress).map(String)));
      const msg = `neoland admin\naddr:${addr}\nnonce:${nonce}\naction:update-whitelist\nid:${id}\naddresses:${JSON.stringify(canon)}`;
      const ok = verifyEd25519({ addr, message: msg, signature });
      if (!ok) return sendJson(res, 401, { error: 'bad signature' });
      const dbh = await getDb();
      const coll = await dbh.getCollectionById(id);
      if (!coll) return sendJson(res, 404, { error: 'collection not found' });
      if (String(coll.owner) !== String(addr)) return sendJson(res, 403, { error: 'not collection owner' });
      await dbh.setWhitelist(id, canon);
      return sendJson(res, 200, { ok: true, count: canon.length });
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
        owner: c.owner || null,
        priceLamports: c.priceLamports,
        supply: c.supply,
        minted_count: c.minted_count,
        metadata_uri: c.metadata_gateway || c.metadata_uri || null,
        onchain_pda: c.onchain_pda || null,
        mintStartTs: c.mintStartTs != null ? Number(c.mintStartTs) : null,
        mintEndTs: c.mintEndTs != null ? Number(c.mintEndTs) : null,
        tradingPaused: !!c.tradingPaused,
        mintPaused: !!c.mint_paused,
        royaltyBps: (c.royaltyBps != null ? Number(c.royaltyBps || 0) : 0),
        collectionMint: c.collection_mint || null,
        lockNewMints: !!c.lock_new_mints,
        limitOnePerWallet: !!c.limitOnePerWallet,
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
      const { id, payer, mintPubkey, currencyMint } = body || {};
      if (!id || !payer || !mintPubkey) return sendJson(res, 400, { error: 'id, payer, mintPubkey required' });
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      // Whitelist enforcement
      try {
        const wl = await dbh.getWhitelist(id);
        if (Array.isArray(wl) && wl.length > 0) {
          if (!wl.includes(String(payer))) return sendJson(res, 403, { error: 'not whitelisted' });
        }
      } catch {}
      if (cfg.mint_paused) return sendJson(res, 400, { error: 'mint paused' });
      // Whitelist enforcement
      try {
        const wl = await dbh.getWhitelist(id);
        if (Array.isArray(wl) && wl.length > 0) {
          if (!wl.includes(String(payer))) return sendJson(res, 403, { error: 'not whitelisted' });
        }
      } catch {}
      // Whitelist enforcement
      try {
        const wl = await dbh.getWhitelist(id);
        if (Array.isArray(wl) && wl.length > 0) {
          if (!wl.includes(String(payer))) return sendJson(res, 403, { error: 'not whitelisted' });
        }
      } catch {}

      // Enforce mint window if configured
      const now = Math.floor(Date.now() / 1000);
      const start = cfg.mintStartTs != null ? Number(cfg.mintStartTs) : null;
      const end = cfg.mintEndTs != null ? Number(cfg.mintEndTs) : null;
      if (start != null && now < start) return sendJson(res, 400, { error: 'mint not started', start, end });
      if (end != null && now > end) return sendJson(res, 400, { error: 'mint ended', start, end });

      const maxSupply = Number(cfg.supply ?? 0);
      const mintedCount = Number(cfg.minted_count ?? 0);
      if (maxSupply && mintedCount + 1 > maxSupply) {
        return sendJson(res, 400, { error: 'sold out or insufficient remaining supply' });
      }

      // Optional per-wallet limit: if enabled, each wallet may mint at most once
      try {
        if (cfg.limitOnePerWallet && await dbh.hasMintFromMinter(id, payer)) {
          return sendJson(res, 400, { error: 'wallet already minted' });
        }
      } catch {}

      // Determine payment method
      let paymentTokenMint = null;
      let paymentAmount = 0;
      let recipientAtaExists = false;
      if (currencyMint && String(currencyMint) !== '' && String(currencyMint) !== '11111111111111111111111111111111') {
        try {
          const pk = new PublicKey(currencyMint);
          if (pk.equals(CARV_MINT)) {
            // Convert SOL price to CARV units using CMC quotes
            const [solUsd, carvUsd] = await Promise.all([getSolUsd(), getCarvUsd()]);
            if (!solUsd || !carvUsd) return sendJson(res, 400, { error: 'price quotes unavailable' });
            const solPrice = Number(cfg.priceLamports || 0) / LAMPORTS_PER_SOL;
            const usd = solPrice * solUsd;
            const carv = usd / carvUsd;
            // CARV has 9 decimals
            paymentTokenMint = CARV_MINT.toBase58();
            paymentAmount = Math.round(carv * 1_000_000_000);
            // Check if recipient (collection owner) already has ATA to avoid extra ix later
            try {
              const { getAssociatedTokenAddress } = await import('@solana/spl-token');
              const toPk = new PublicKey(cfg.owner);
              const ata = await getAssociatedTokenAddress(CARV_MINT, toPk);
              const ai = await conn.getAccountInfo(ata);
              recipientAtaExists = !!ai;
            } catch {}
          }
        } catch {}
      }

      // Compute per-mint metadata URI to help indexers group unique items
      const perMintUri = resolveMetadataUriForMint(cfg, mintPubkey);

      const royaltyBps = Number(cfg.royaltyBps || 0);
      // Prefer a stable creator (deployer/owner) over the user payer
      const creatorAddrs = [cfg.owner || null].filter(Boolean);

      const tx = await buildMintNftTx({
        payer,
        mintPubkey,
        name: cfg.name || 'CARV NFT',
        symbol: cfg.symbol || 'CARV',
        metadataUri: perMintUri || (cfg.metadata_gateway || cfg.metadata_uri),
        // If price is set, collect payment (SOL or CARV) to deployer in the same transaction
        paymentLamports: paymentTokenMint ? 0 : (Number(cfg.priceLamports || 0) || 0),
        paymentTo: cfg.owner || null,
        finalUpdateAuthority: cfg.owner || null,
        finalIsMutable: !cfg.lock_new_mints,
        paymentTokenMint,
        paymentAmount,
        royaltyBps,
        creatorAddrs,
        collectionMint: cfg.collection_mint || null,
      });
      // Append sized collection verification if configured.
      // Keep mint tx within message size: include verify when
      // - paying in SOL, or
      // - paying in SPL AND the recipient ATA already exists (no extra ix added).
      try {
        if (cfg.collection_mint && (!paymentTokenMint || (paymentTokenMint && recipientAtaExists))) {
          const itemMeta = findMetadataPda(new PublicKey(mintPubkey));
          const collMint = new PublicKey(cfg.collection_mint);
          const collMeta = findMetadataPda(collMint);
          const collEdition = findMasterEditionPda(collMint);
          const collAuthRec = PublicKey.findProgramAddressSync([
            Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), collMint.toBuffer(), Buffer.from('collection_authority'), deployer.publicKey.toBuffer()
          ], TOKEN_METADATA_PROGRAM_ID)[0];
          const data = Buffer.from(getVerifySizedSer().serialize({}));
          const keys = [
            { pubkey: itemMeta, isSigner: false, isWritable: true },
            { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
            { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
            { pubkey: collMint, isSigner: false, isWritable: false },
            { pubkey: collMeta, isSigner: false, isWritable: true },
            { pubkey: collEdition, isSigner: false, isWritable: false },
            { pubkey: collAuthRec, isSigner: false, isWritable: false },
          ];
          tx.add(new TransactionInstruction({ keys, programId: TOKEN_METADATA_PROGRAM_ID, data }));
          tx.partialSign(deployer);
        }
      } catch {}
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    // Build a batch mint transaction for multiple NFTs in a single approval.
    // Body: { id, payer, mintPubkeys: [..], currencyMint? }
    if (pathname === '/api/tx/mint-nft-batch' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, payer, mintPubkeys = [], currencyMint } = body || {};
      if (!id || !payer || !Array.isArray(mintPubkeys) || mintPubkeys.length === 0) {
        return sendJson(res, 400, { error: 'id, payer, mintPubkeys required' });
      }
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      if (cfg.mint_paused) return sendJson(res, 400, { error: 'mint paused' });
      // If collection enforces 1-per-wallet, disallow batch minting
      if (cfg.limitOnePerWallet) {
        return sendJson(res, 400, { error: 'this collection is limited to 1 mint per wallet' });
      }
      // Enforce mint window
      const now = Math.floor(Date.now() / 1000);
      const start = cfg.mintStartTs != null ? Number(cfg.mintStartTs) : null;
      const end = cfg.mintEndTs != null ? Number(cfg.mintEndTs) : null;
      if (start != null && now < start) return sendJson(res, 400, { error: 'mint not started', start, end });
      if (end != null && now > end) return sendJson(res, 400, { error: 'mint ended', start, end });
      const qty = mintPubkeys.length;
      const maxSupply = Number(cfg.supply ?? 0);
      const mintedCount = Number(cfg.minted_count ?? 0);
      if (maxSupply && mintedCount + qty > maxSupply) {
        return sendJson(res, 400, { error: 'insufficient remaining supply for requested quantity' });
      }

      const payerPk = new PublicKey(payer);
      const ixes = [];
      try { const { ComputeBudgetProgram } = await import('@solana/web3.js'); ixes.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 })); } catch {}
      let needsDeployerSig = false;

      // Aggregate payment (one transfer) to collection owner
      const priceLamportsEach = Number(cfg.priceLamports || 0) || 0;
      const paymentTo = cfg.owner || null;

      if (paymentTo && priceLamportsEach > 0) {
        if (currencyMint && String(currencyMint) !== '' && String(currencyMint) !== '11111111111111111111111111111111') {
          // SPL token (e.g., CARV) payment aggregation
          try {
            const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } = await import('@solana/spl-token');
            const tokenMintPk = new PublicKey(currencyMint);
            const recipientPk = new PublicKey(paymentTo);
            const recipientAta = await getAssociatedTokenAddress(tokenMintPk, recipientPk);
            const ai = await conn.getAccountInfo(recipientAta);
            if (!ai) { ixes.push(createAssociatedTokenAccountInstruction(deployer.publicKey, recipientAta, recipientPk, tokenMintPk)); needsDeployerSig = true; }
            // Convert SOL price -> USD -> CARV units
            const [solUsd, carvUsd] = await Promise.all([getSolUsd(), getCarvUsd()]);
            if (!solUsd || !carvUsd) return sendJson(res, 400, { error: 'price quotes unavailable' });
            const sol = priceLamportsEach / LAMPORTS_PER_SOL;
            const totalCarv = Math.round((sol * solUsd / carvUsd) * qty * 1_000_000_000);
            ixes.push(createTransferInstruction(
              await getAssociatedTokenAddress(tokenMintPk, payerPk),
              recipientAta,
              payerPk,
              BigInt(totalCarv)
            ));
          } catch (e) {
            return sendJson(res, 500, { error: 'failed to build SPL payment', details: String(e.message || e) });
          }
        } else {
          // Aggregate SOL transfer once
          const lamports = Math.round(priceLamportsEach * qty);
          ixes.push(SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: new PublicKey(paymentTo), lamports }));
        }
      }

      // Add mint instructions for each NFT (no per-item payment here)
      const royaltyBps = Number(cfg.royaltyBps || 0);
      const creatorAddrs = [cfg.owner || null].filter(Boolean);
      for (const m of mintPubkeys) {
        try {
          const txOne = await buildMintNftTx({
            payer,
            mintPubkey: m,
            name: cfg.name || 'CARV NFT',
            symbol: cfg.symbol || 'CARV',
            metadataUri: resolveMetadataUriForMint(cfg, m) || (cfg.metadata_gateway || cfg.metadata_uri),
            paymentLamports: 0,
            paymentTo: null,
            finalUpdateAuthority: cfg.owner || null,
            royaltyBps,
            creatorAddrs,
            collectionMint: cfg.collection_mint || null,
          });
          txOne.instructions.forEach((ix) => ixes.push(ix));
          // Append collection verify for this item if collection_mint configured
          try {
            if (cfg.collection_mint) {
              const itemMeta = findMetadataPda(new PublicKey(m));
              const collMint = new PublicKey(cfg.collection_mint);
              const collMeta = findMetadataPda(collMint);
              const collEdition = findMasterEditionPda(collMint);
              const collAuthRec = PublicKey.findProgramAddressSync([
                Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), collMint.toBuffer(), Buffer.from('collection_authority'), deployer.publicKey.toBuffer()
              ], TOKEN_METADATA_PROGRAM_ID)[0];
              const data = Buffer.from(getVerifySizedSer().serialize({}));
              const keys = [
                { pubkey: itemMeta, isSigner: false, isWritable: true },
                { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
                { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
                { pubkey: collMint, isSigner: false, isWritable: false },
                { pubkey: collMeta, isSigner: false, isWritable: true },
                { pubkey: collEdition, isSigner: false, isWritable: false },
                { pubkey: collAuthRec, isSigner: false, isWritable: false },
              ];
              ixes.push(new TransactionInstruction({ keys, programId: TOKEN_METADATA_PROGRAM_ID, data }));
              needsDeployerSig = true;
            }
          } catch {}
        } catch (e) {
          return sendJson(res, 500, { error: 'failed to build mint instructions', details: String(e.message || e) });
        }
      }

      const tx = new Transaction();
      tx.feePayer = payerPk;
      ixes.forEach((ix) => tx.add(ix));
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      if (needsDeployerSig) tx.partialSign(deployer);
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    // Estimate the maximum number of mints that can fit in one transaction.
    // Body: { id, payer, currencyMint?, want? }
    if (pathname === '/api/tx/mint-nft-batch-estimate' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, payer, currencyMint, want = 10 } = body || {};
      if (!id || !payer) return sendJson(res, 400, { error: 'id, payer required' });
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      const remaining = Math.max(0, Number(cfg.supply || 0) ? Number(cfg.supply || 0) - Number(cfg.minted_count || 0) : Number.MAX_SAFE_INTEGER);
      if (remaining === 0) return sendJson(res, 200, { max: 0, remaining: 0 });
      const payerPk = new PublicKey(payer);
      const upper = Math.max(1, Math.min(Number(want || 10), remaining, 20));
      let best = 0;
      for (let n = 1; n <= upper; n++) {
        try {
          const ixes = [];
          try { const { ComputeBudgetProgram } = await import('@solana/web3.js'); ixes.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 })); } catch {}
          // Aggregate payment for n items
          const priceLamportsEach = Number(cfg.priceLamports || 0) || 0;
          const paymentTo = cfg.owner || null;
          if (paymentTo && priceLamportsEach > 0) {
            if (currencyMint && String(currencyMint) !== '' && String(currencyMint) !== '11111111111111111111111111111111') {
              const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } = await import('@solana/spl-token');
              const tokenMintPk = new PublicKey(currencyMint);
              const recipientPk = new PublicKey(paymentTo);
              const recipientAta = await getAssociatedTokenAddress(tokenMintPk, recipientPk);
              const ai = await conn.getAccountInfo(recipientAta);
              if (!ai) ixes.push(createAssociatedTokenAccountInstruction(deployer.publicKey, recipientAta, recipientPk, tokenMintPk));
              const [solUsd, carvUsd] = await Promise.all([getSolUsd(), getCarvUsd()]);
              if (!solUsd || !carvUsd) throw new Error('quotes unavailable');
              const sol = priceLamportsEach / LAMPORTS_PER_SOL;
              const totalCarv = Math.round((sol * solUsd / carvUsd) * n * 1_000_000_000);
              ixes.push(createTransferInstruction(
                await getAssociatedTokenAddress(tokenMintPk, payerPk),
                recipientAta,
                payerPk,
                BigInt(totalCarv)
              ));
            } else {
              ixes.push(SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: new PublicKey(paymentTo), lamports: Math.round(priceLamportsEach * n) }));
            }
          }
          // Add n mint instruction groups
          for (let i = 0; i < n; i++) {
            const mint = Keypair.generate();
            const txOne = await buildMintNftTx({
              payer,
              mintPubkey: mint.publicKey.toBase58(),
              name: cfg.name || 'CARV NFT',
              symbol: cfg.symbol || 'CARV',
              metadataUri: resolveMetadataUriForMint(cfg, mint.publicKey.toBase58()) || (cfg.metadata_gateway || cfg.metadata_uri),
              paymentLamports: 0,
              paymentTo: null,
              finalUpdateAuthority: cfg.owner || null,
              royaltyBps: Number(cfg.royaltyBps || 0),
              creatorAddrs: [cfg.owner || null].filter(Boolean),
              collectionMint: cfg.collection_mint || null,
            });
            txOne.instructions.forEach((ix) => ixes.push(ix));
          }
          const tx = new Transaction();
          tx.feePayer = payerPk;
          ixes.forEach((ix) => tx.add(ix));
          const { blockhash } = await conn.getLatestBlockhash('finalized');
          tx.recentBlockhash = blockhash;
          // simulate compute (also effectively checks message size; if too large, serialize in simulation will throw)
          let simOk = true;
          try {
            const sim = await conn.simulateTransaction(tx, { sigVerify: false });
            if (sim?.value?.err) simOk = false;
          } catch { simOk = false; }
          if (!simOk) break;
          best = n;
        } catch { break; }
      }
      return sendJson(res, 200, { max: best, remaining });
    }

    // Discord-only helper: mint NFTs for a user by collection id and quantity.
    // Body: { id, discord_user_id, quantity?, currency? } where:
    //   - id: collection id
    //   - discord_user_id: Discord snowflake string
    //   - quantity: how many to mint (default 1)
    //   - currency: "SOL" or "CARV" (default "SOL")
    if (pathname === '/api/discord/mint' && req.method === 'POST') {
      if (!checkDeployApiAuth(req)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      const body = await getParsedBody(req);
      const { id, discord_user_id, quantity = 1, currency = 'SOL' } = body || {};
      if (!id || !discord_user_id) {
        return sendJson(res, 400, { error: 'id and discord_user_id required' });
      }
      const qty = Math.max(1, Number(quantity || 1) | 0);
      const useCarv = String(currency || 'SOL').toUpperCase() === 'CARV';
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      if (cfg.mint_paused) return sendJson(res, 400, { error: 'mint paused' });

      // Enforce mint window if configured
      const now = Math.floor(Date.now() / 1000);
      const start = cfg.mintStartTs != null ? Number(cfg.mintStartTs) : null;
      const end = cfg.mintEndTs != null ? Number(cfg.mintEndTs) : null;
      if (start != null && now < start) return sendJson(res, 400, { error: 'mint not started', start, end });
      if (end != null && now > end) return sendJson(res, 400, { error: 'mint ended', start, end });

      const maxSupply = Number(cfg.supply ?? 0);
      const mintedCount = Number(cfg.minted_count ?? 0);
      if (maxSupply && mintedCount + qty > maxSupply) {
        return sendJson(res, 400, { error: 'insufficient remaining supply for requested quantity' });
      }

      // Resolve per-user wallet and decrypt secret
      let wallet;
      try {
        wallet = await resolveOrCreateDiscordWallet(discord_user_id);
      } catch (e) {
        console.error('resolveOrCreateDiscordWallet (discord/mint) failed:', e?.message || e);
        return sendJson(res, 500, { error: 'failed to resolve wallet' });
      }
      if (!wallet || !wallet.ownerPubkey || !wallet.secretCiphertext) {
        return sendJson(res, 500, { error: 'wallet not found for discord_user_id' });
      }
      let payerSecret;
      try {
        payerSecret = decryptWalletSecret(wallet.secretCiphertext);
      } catch (e) {
        console.error('decrypt wallet failed (discord/mint):', e?.message || e);
        return sendJson(res, 500, { error: 'failed to decrypt wallet' });
      }
      let payerKp;
      try {
        let secretBytes = null;
        try {
          const arr = JSON.parse(payerSecret);
          if (Array.isArray(arr)) secretBytes = Uint8Array.from(arr);
        } catch {}
        if (!secretBytes) {
          const decoded = bs58.decode(String(payerSecret));
          secretBytes = Uint8Array.from(decoded);
        }
        payerKp = Keypair.fromSecretKey(secretBytes);
      } catch (e) {
        console.error('rebuild payer keypair failed:', e?.message || e);
        return sendJson(res, 500, { error: 'invalid stored wallet secret' });
      }
      const payerPk = payerKp.publicKey;

      // If collection enforces 1-per-wallet, disallow quantity > 1 and check prior mint
      if (cfg.limitOnePerWallet) {
        if (qty > 1) {
          return sendJson(res, 400, { error: 'this collection is limited to 1 mint per wallet' });
        }
        try {
          if (await dbh.hasMintFromMinter(id, payerPk.toBase58())) {
            return sendJson(res, 400, { error: 'wallet already minted' });
          }
        } catch {}
      }

      // Pre-compute CARV payment per mint if requested
      const priceLamportsEach = Number(cfg.priceLamports || 0) || 0;
      let paymentTokenMint = null;
      let paymentAmountPer = 0;
      if (useCarv && priceLamportsEach > 0) {
        try {
          const [solUsd, carvUsd] = await Promise.all([getSolUsd(), getCarvUsd()]);
          if (!solUsd || !carvUsd) return sendJson(res, 400, { error: 'price quotes unavailable' });
          const sol = priceLamportsEach / LAMPORTS_PER_SOL;
          const carv = sol * solUsd / carvUsd;
          paymentTokenMint = CARV_MINT.toBase58();
          paymentAmountPer = Math.round(carv * 1_000_000_000);
        } catch (e) {
          return sendJson(res, 500, { error: 'failed to compute CARV price', detail: e?.message || String(e) });
        }
      }

      const minted = [];
      for (let i = 0; i < qty; i++) {
        // Check remaining supply each loop
        const curCfg = i === 0 ? cfg : await dbh.getCollectionById(id);
        const curMinted = Number(curCfg.minted_count ?? 0);
        if (maxSupply && curMinted + 1 > maxSupply) {
          if (i === 0) return sendJson(res, 400, { error: 'sold out or insufficient remaining supply' });
          break;
        }
        // Optional per-wallet check for subsequent mints on non-limited collections
        if (cfg.limitOnePerWallet && i > 0) break;

        const mintKp = Keypair.generate();
        const perMintUri = resolveMetadataUriForMint(curCfg, mintKp.publicKey.toBase58());
        const royaltyBps = Number(curCfg.royaltyBps || 0);
        const creatorAddrs = [curCfg.owner || null].filter(Boolean);

        const tx = await buildMintNftTx({
          payer: payerPk.toBase58(),
          mintPubkey: mintKp.publicKey.toBase58(),
          name: curCfg.name || 'CARV NFT',
          symbol: curCfg.symbol || 'CARV',
          metadataUri: perMintUri || (curCfg.metadata_gateway || curCfg.metadata_uri),
          paymentLamports: useCarv ? 0 : priceLamportsEach,
          paymentTo: curCfg.owner || null,
          finalUpdateAuthority: curCfg.owner || null,
          finalIsMutable: !curCfg.lock_new_mints,
          paymentTokenMint,
          paymentAmount: paymentTokenMint ? paymentAmountPer : 0,
          royaltyBps,
          creatorAddrs,
          collectionMint: curCfg.collection_mint || null,
        });
        tx.sign(payerKp, mintKp);
        let sig;
        try {
          sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
          try { await conn.confirmTransaction(sig, 'confirmed'); } catch {}
        } catch (e) {
          console.error('discord mint send failed:', e?.message || e);
          return sendJson(res, 500, { error: 'failed to submit mint transaction', detail: e?.message || String(e) });
        }
        try {
          await dbh.recordMint({ id, mint: mintKp.publicKey.toBase58(), minter: payerPk.toBase58(), ts: nowTs() });
        } catch (e) {
          console.error('recordMint failed (discord/mint):', e?.message || e);
        }
        minted.push({ mint: mintKp.publicKey.toBase58(), signature: sig });
      }

      return sendJson(res, 200, { ok: true, minted, payer: payerPk.toBase58() });
    }

    // Atomic create-collection + build mint tx (avoids cross-request persistence issues)
    // Note: This endpoint persists the collection BEFORE the wallet signs.
    // Frontend should prefer /api/tx/mint-direct to avoid persisting on user cancel.
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
      const priceLamports = Math.max(0, Math.round(Number(price || 0) * LAMPORTS_PER_SOL));
      const id = await dbh.createCollection({ name, symbol, supply: parsedSupply, priceLamports, imageCid, metadataUri, metadataGateway, owner });
      const cfg = await dbh.getCollectionById(id);
      const tx = await buildMintNftTx({
        payer,
        mintPubkey,
        name: cfg.name || name,
        symbol: cfg.symbol || symbol,
        metadataUri: resolveMetadataUriForMint(cfg, mintPubkey) || (cfg.metadata_gateway || cfg.metadata_uri),
        paymentLamports: Number(cfg.priceLamports || 0) || 0,
        paymentTo: cfg.owner || null,
        finalUpdateAuthority: cfg.owner || null,
        royaltyBps: Number(cfg.royaltyBps || 0),
        creatorAddrs: [cfg.owner || null].filter(Boolean),
        collectionMint: cfg.collection_mint || null,
      });
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { id, tx: Buffer.from(serialized).toString('base64') });
    }

    // Build a mint NFT transaction directly without persisting any DB state.
    // This is useful for flows where we only want to create DB records after
    // the user successfully signs and the transaction is confirmed on-chain.
    // Body: { name, symbol, metadataUri, owner, payer, mintPubkey, price }
    if (pathname === '/api/tx/mint-direct' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { name, symbol, metadataUri, owner, payer, mintPubkey, price = 0 } = body || {};
      if (!name || !symbol || !metadataUri || !owner || !payer || !mintPubkey) {
        return sendJson(res, 400, { error: 'name, symbol, metadataUri, owner, payer, mintPubkey required' });
      }
      const tx = await buildMintNftTx({
        payer,
        mintPubkey,
        name,
        symbol,
        metadataUri: resolveMetadataUriForMint({ metadata_uri: metadataUri }, mintPubkey) || metadataUri,
        paymentLamports: Math.max(0, Math.round(Number(price || 0) * LAMPORTS_PER_SOL)) || 0,
        paymentTo: owner,
        finalUpdateAuthority: owner,
        royaltyBps: 0,
        creatorAddrs: [owner].filter(Boolean),
      });
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64') });
    }

    // Build an UpdateMetadata tx to change the URI, royalties, creators, and optional collection
    if (pathname === '/api/tx/update-metadata' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { mint, payer, name, symbol, metadataUri, royaltyBps: rbps, creatorAddrs = [], collectionMint = null } = body || {};
      if (!mint || !payer || !metadataUri) return sendJson(res, 400, { error: 'mint, payer, metadataUri required' });
      const mintPk = new PublicKey(mint);
      const payerPk = new PublicKey(payer);
      const metadataPda = findMetadataPda(mintPk);

      // Build creators from addresses if provided
      let creators = null;
      try {
        const addrs = Array.from(new Set((creatorAddrs || []).filter(Boolean).map(String)));
        if (addrs.length) {
          const shareEach = Math.floor(100 / addrs.length) || 100;
          creators = addrs.map((a, i) => ({ address: new PublicKey(a), verified: 0, share: i === 0 ? (100 - shareEach * (addrs.length - 1)) : shareEach }));
        }
      } catch {}

      const royaltyBps = rbps != null ? (Number(rbps) | 0) : 0;
      const dataV2 = {
        name: name || 'CARV NFT',
        symbol: symbol || 'CARV',
        uri: String(metadataUri),
        sellerFeeBasisPoints: royaltyBps,
        creators,
        collection: collectionMint ? { verified: 0, key: new PublicKey(collectionMint) } : null,
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
      let { payer, owner, name, symbol, metadataUri, price = 0, supply = 0, collectionMetaUri = null, discord_user_id } = body || {};

      // If payer/owner not provided but a Discord user is, resolve or create a per-user wallet.
      if ((!payer || !owner) && discord_user_id) {
        try {
          const wallet = await resolveOrCreateDiscordWallet(discord_user_id);
          if (wallet && wallet.ownerPubkey) {
            payer = payer || wallet.ownerPubkey;
            owner = owner || wallet.ownerPubkey;
          }
        } catch (e) {
          console.error('resolveOrCreateDiscordWallet failed:', e?.message || e);
        }
      }

      if (!payer) payer = process.env.DEPLOY_PAYER;
      if (!owner) owner = process.env.DEPLOY_OWNER;
      if (!payer || !owner || !name || !symbol || !metadataUri) {
        return sendJson(res, 400, { error: 'payer, owner, name, symbol, metadataUri required' });
      }

      const payerPk = new PublicKey(payer);
      const ownerPk = new PublicKey(owner);
      const seeds = [Buffer.from('collection'), ownerPk.toBuffer(), sha256Bytes(symbol)];
      const [collectionPda] = PublicKey.findProgramAddressSync(seeds, COLLECTION_PROGRAM_ID);

      // If PDA already exists, don't build an init tx. Return the PDA so the
      // client can proceed without attempting to re-initialize.
      try {
        const info = await conn.getAccountInfo(collectionPda, 'confirmed');
        if (info && info.owner && info.owner.equals(COLLECTION_PROGRAM_ID)) {
          return sendJson(res, 200, { already: true, collectionPda: collectionPda.toBase58() });
        }
      } catch {}

      // Build init instruction for on-chain PDA
      const initKeys = [
        { pubkey: payerPk, isSigner: true, isWritable: true },
        { pubkey: ownerPk, isSigner: true, isWritable: false },
        { pubkey: collectionPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const initData = Buffer.concat([
        anchorIxDisc('init_collection'),
        borshString(String(name)),
        borshString(String(symbol)),
        borshString(String(metadataUri)),
        borshU64(Math.round(Number(price || 0) * LAMPORTS_PER_SOL)),
        borshU32(Number(supply || 0)),
      ]);
      const initIx = new TransactionInstruction({ keys: initKeys, programId: COLLECTION_PROGRAM_ID, data: initData });

      // In the same transaction, create a parent collection NFT (sized)
      // Name/symbol clamped to MPL limits
      const nameClamped = String(name).slice(0, 32);
      const symbolClamped = String(symbol).slice(0, 10);
      const collMint = Keypair.generate();
      const lamportsForMint = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
      const ownerAta = await getAssociatedTokenAddress(collMint.publicKey, ownerPk);
      const ixes = [];
      // Mint account + init + ATA + mint 1 to owner
      ixes.push(SystemProgram.createAccount({ fromPubkey: payerPk, newAccountPubkey: collMint.publicKey, space: MINT_SIZE, lamports: lamportsForMint, programId: TOKEN_PROGRAM_ID }));
      ixes.push(createInitializeMintInstruction(collMint.publicKey, 0, ownerPk, ownerPk));
      ixes.push(createAssociatedTokenAccountInstruction(payerPk, ownerAta, ownerPk, collMint.publicKey));
      ixes.push(createMintToInstruction(collMint.publicKey, ownerAta, ownerPk, 1));
      // Metadata + master edition
      const collMetaPda = findMetadataPda(collMint.publicKey);
      const collEditionPda = findMasterEditionPda(collMint.publicKey);
      const dataV2 = {
        name: `${nameClamped} Collection`,
        symbol: symbolClamped,
        uri: String(collectionMetaUri || metadataUri),
        sellerFeeBasisPoints: 0,
        creators: [{ address: ownerPk, verified: 1, share: 100 }],
        collection: null,
        uses: null,
      };
      ixes.push(createCreateMetadataAccountV3Instruction({
        metadata: collMetaPda,
        mint: collMint.publicKey,
        mintAuthority: ownerPk,
        payer: payerPk,
        updateAuthority: ownerPk,
        data: dataV2,
        isMutable: true,
        collectionDetails: null,
      }));
      ixes.push(createCreateMasterEditionV3Instruction({
        edition: collEditionPda,
        mint: collMint.publicKey,
        updateAuthority: ownerPk,
        mintAuthority: ownerPk,
        payer: payerPk,
        metadata: collMetaPda,
        maxSupply: 0,
      }));
      // Mark as sized collection and set initial size to supply (or 0 if unknown)
      try {
        const setSizeData = Buffer.from(getSetCollectionSizeSer().serialize({ setCollectionSizeArgs: { size: BigInt(Math.max(0, Number(supply || 0))) } }));
        ixes.push(new TransactionInstruction({
          keys: [
            { pubkey: collMetaPda, isSigner: false, isWritable: true },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: collMint.publicKey, isSigner: false, isWritable: false },
          ],
          programId: TOKEN_METADATA_PROGRAM_ID,
          data: setSizeData,
        }));
      } catch {}
      // Approve server deployer as collection authority so server can verify items
      try {
        const collAuthRec = PublicKey.findProgramAddressSync([
          Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), collMint.publicKey.toBuffer(), Buffer.from('collection_authority'), deployer.publicKey.toBuffer()
        ], TOKEN_METADATA_PROGRAM_ID)[0];
        const approveData = Buffer.from(getApproveCollAuthSer().serialize({}));
        ixes.push(new TransactionInstruction({
          keys: [
            { pubkey: collAuthRec, isSigner: false, isWritable: true },
            { pubkey: deployer.publicKey, isSigner: false, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: collMetaPda, isSigner: false, isWritable: false },
            { pubkey: collMint.publicKey, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: TOKEN_METADATA_PROGRAM_ID,
          data: approveData,
        }));
      } catch {}

      // Compose transaction
      const tx = new Transaction();
      tx.feePayer = payerPk;
      tx.add(initIx);
      ixes.forEach((ix) => tx.add(ix));
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      tx.partialSign(collMint);
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), collectionPda: collectionPda.toBase58(), collectionMint: collMint.publicKey.toBase58() });
    }

    // Submit a base64-encoded transaction after client-side signing
    if (pathname === '/api/tx/submit' && req.method === 'POST') {
      const body = await getParsedBody(req);
      let { tx: txB64, secret, discord_user_id } = body || {};
      if (!txB64) return sendJson(res, 400, { error: 'tx required' });

      // For Discord flows, resolve encrypted wallet from Supabase instead of requiring raw secret.
      if (!secret && discord_user_id) {
        try {
          const wallet = await resolveOrCreateDiscordWallet(discord_user_id);
          if (!wallet || !wallet.secretCiphertext) {
            return sendJson(res, 400, { error: 'wallet not found for discord_user_id' });
          }
          secret = decryptWalletSecret(wallet.secretCiphertext);
        } catch (e) {
          console.error('resolve wallet for submit failed:', e?.message || e);
          return sendJson(res, 500, { error: 'failed to resolve wallet' });
        }
      }

      if (!secret) return sendJson(res, 400, { error: 'secret or discord_user_id required' });

      try {
        let secretBytes = null;
        if (Array.isArray(secret)) {
          secretBytes = Uint8Array.from(secret);
        } else if (typeof secret === 'string') {
          try {
            // Try JSON array string first
            const arr = JSON.parse(secret);
            if (Array.isArray(arr)) secretBytes = Uint8Array.from(arr);
          } catch {}
          if (!secretBytes) {
            // Try base58
            const decoded = bs58.decode(secret);
            secretBytes = Uint8Array.from(decoded);
          }
        }
        if (!secretBytes || secretBytes.length < 64) return sendJson(res, 400, { error: 'invalid secret' });
        const kp = Keypair.fromSecretKey(secretBytes);
        const buf = Buffer.from(String(txB64), 'base64');
        const tx = Transaction.from(buf);
        tx.partialSign(kp);
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        try { await conn.confirmTransaction(sig, 'confirmed'); } catch {}
        return sendJson(res, 200, { signature: sig });
      } catch (e) {
        console.error('submit tx failed:', e?.message || e);
        return sendJson(res, 500, { error: 'failed to submit tx', detail: e?.message || String(e) });
      }
    }

    // Build a small transaction to create an ATA for a given SPL mint for the owner if missing
    // Body: { owner, mint }
    if (pathname === '/api/tx/ensure-ata' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { owner, mint } = body || {};
      if (!owner || !mint) return sendJson(res, 400, { error: 'owner and mint required' });
      const ownerPk = new PublicKey(owner);
      const mintPk = new PublicKey(mint);
      const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
      const ata = await getAssociatedTokenAddress(mintPk, ownerPk);
      const info = await conn.getAccountInfo(ata);
      if (info) return sendJson(res, 200, { already: true, ata: ata.toBase58() });
      const tx = new Transaction();
      tx.feePayer = ownerPk;
      tx.add(createAssociatedTokenAccountInstruction(ownerPk, ata, ownerPk, mintPk));
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), ata: ata.toBase58() });
    }

    // Build tx to make an on-chain collection offer (escrows SOL in PDA)
    if (pathname === '/api/offers/tx/make' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { collectionId, bidder, priceSol } = body || {};
      if (!collectionId || !bidder) return sendJson(res, 400, { error: 'collectionId and bidder required' });
      const dbh = await getDb();
      const coll = await dbh.getCollectionById(collectionId);
      if (!coll || !coll.onchain_pda) return sendJson(res, 400, { error: 'collection not on-chain or missing PDA' });
      const priceLamports = Math.round(Number(priceSol || 0) * LAMPORTS_PER_SOL);
      if (!priceLamports || priceLamports <= 0) return sendJson(res, 400, { error: 'priceSol must be > 0' });

      const bidderPk = new PublicKey(bidder);
      const collectionPda = new PublicKey(coll.onchain_pda);
      const [offerPda] = PublicKey.findProgramAddressSync([Buffer.from('offer'), collectionPda.toBuffer(), bidderPk.toBuffer()], OFFERS_PROGRAM_ID);
      const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), collectionPda.toBuffer(), bidderPk.toBuffer()], OFFERS_PROGRAM_ID);
      let vaultForIx = vaultPda;
      try { const ai = await conn.getAccountInfo(vaultPda, 'confirmed'); if (!ai) vaultForIx = SystemProgram.programId; } catch {}
      

      const keys = [
        { pubkey: bidderPk, isSigner: true, isWritable: true },
        { pubkey: collectionPda, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: offerPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const data = Buffer.concat([anchorIxDisc('make_offer'), borshU64(priceLamports)]);
      const ix = new TransactionInstruction({ keys, programId: OFFERS_PROGRAM_ID, data });
      const tx = new Transaction();
      tx.feePayer = bidderPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), offerPda: offerPda.toBase58(), vaultPda: vaultPda.toBase58() });
    }

    // Build tx to cancel an existing on-chain offer
    if (pathname === '/api/offers/tx/cancel' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { collectionId, bidder } = body || {};
      if (!collectionId || !bidder) return sendJson(res, 400, { error: 'collectionId and bidder required' });
      const dbh = await getDb();
      const coll = await dbh.getCollectionById(collectionId);
      if (!coll || !coll.onchain_pda) return sendJson(res, 400, { error: 'collection not on-chain or missing PDA' });
      const bidderPk = new PublicKey(bidder);
      const collectionPda = new PublicKey(coll.onchain_pda);
      const [offerPda] = PublicKey.findProgramAddressSync([Buffer.from('offer'), collectionPda.toBuffer(), bidderPk.toBuffer()], OFFERS_PROGRAM_ID);
      const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), collectionPda.toBuffer(), bidderPk.toBuffer()], OFFERS_PROGRAM_ID);
      let vaultForIx = vaultPda;
      try {
        const ai = await conn.getAccountInfo(vaultPda, 'confirmed');
        if (!ai) vaultForIx = SystemProgram.programId;
      } catch {}

      const keys = [
        { pubkey: bidderPk, isSigner: true, isWritable: true },
        { pubkey: collectionPda, isSigner: false, isWritable: false },
        { pubkey: offerPda, isSigner: false, isWritable: true },
        { pubkey: vaultForIx, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const data = Buffer.concat([anchorIxDisc('cancel_offer')]);
      const ix = new TransactionInstruction({ keys, programId: OFFERS_PROGRAM_ID, data });
      const tx = new Transaction();
      tx.feePayer = bidderPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), offerPda: offerPda.toBase58(), vaultPda: vaultPda.toBase58() });
    }

    // Build tx to configure/update the Offers registry for a collection (sets accepted update_authority)
    if (pathname === '/api/offers/tx/configure' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { collectionId, admin, owner } = body || {};
      if (!collectionId || !admin || !owner) return sendJson(res, 400, { error: 'collectionId, admin, owner required' });
      const dbh = await getDb();
      const coll = await dbh.getCollectionById(collectionId);
      if (!coll || !coll.onchain_pda) return sendJson(res, 400, { error: 'collection not on-chain or missing PDA' });
      const adminPk = new PublicKey(admin);
      const collectionPda = new PublicKey(coll.onchain_pda);
      const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from('registry'), collectionPda.toBuffer()], OFFERS_PROGRAM_ID);

      const keys = [
        { pubkey: adminPk, isSigner: true, isWritable: true },
        { pubkey: collectionPda, isSigner: false, isWritable: false },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const data = Buffer.concat([anchorIxDisc('configure_collection'), borshPubkey(owner)]);
      const ix = new TransactionInstruction({ keys, programId: OFFERS_PROGRAM_ID, data });
      const tx = new Transaction();
      tx.feePayer = adminPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), registryPda: registryPda.toBase58() });
    }

    // Build tx to accept an on-chain offer; Seller signs, SOL to seller, NFT to bidder.
    if (pathname === '/api/offers/tx/accept' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { collectionId, bidder, seller, mint } = body || {};
      if (!collectionId || !bidder || !seller || !mint) return sendJson(res, 400, { error: 'collectionId, bidder, seller, mint required' });
      // Disallow accepting your own offer from the same wallet
      if (String(bidder) === String(seller)) return sendJson(res, 400, { error: 'cannot accept your own offer' });
      const dbh = await getDb();
      const coll = await dbh.getCollectionById(collectionId);
      if (!coll || !coll.onchain_pda) return sendJson(res, 400, { error: 'collection not on-chain or missing PDA' });
      const sellerPk = new PublicKey(seller);
      const bidderPk = new PublicKey(bidder);
      const collectionPda = new PublicKey(coll.onchain_pda);
      const mintPk = new PublicKey(mint);
      const [offerPda] = PublicKey.findProgramAddressSync([Buffer.from('offer'), collectionPda.toBuffer(), bidderPk.toBuffer()], OFFERS_PROGRAM_ID);
      const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), collectionPda.toBuffer(), bidderPk.toBuffer()], OFFERS_PROGRAM_ID);

      const [collectionAuth] = PublicKey.findProgramAddressSync([Buffer.from('auth'), collectionPda.toBuffer()], COLLECTION_PROGRAM_ID);
      const sellerAta = await getAssociatedTokenAddress(mintPk, sellerPk);
      const bidderAta = await getAssociatedTokenAddress(mintPk, bidderPk);
      const metadataPda = findMetadataPda(mintPk);
      const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from('registry'), collectionPda.toBuffer()], OFFERS_PROGRAM_ID);

      // Build a transaction that first configures the registry owner (idempotent),
      // then accepts the offer. This avoids the common failure where the on-chain
      // program rejects with MintNotFromCollection due to missing registry.owner.
      // We set owner = collection deployer stored in DB (also the update authority
      // for mints created by our collection program).
      const tx = new Transaction();
      tx.feePayer = sellerPk;

      // Prepend configure instruction to set/update registry.owner (no admin check in program)
      if (coll.owner) {
        const cfgKeys = [
          { pubkey: sellerPk, isSigner: true, isWritable: true },
          { pubkey: collectionPda, isSigner: false, isWritable: false },
          { pubkey: registryPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ];
        const cfgData = Buffer.concat([anchorIxDisc('configure_collection'), borshPubkey(coll.owner)]);
        const cfgIx = new TransactionInstruction({ keys: cfgKeys, programId: OFFERS_PROGRAM_ID, data: cfgData });
        tx.add(cfgIx);
      }

      const keys = [
        { pubkey: sellerPk, isSigner: true, isWritable: true },
        { pubkey: COLLECTION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: collectionAuth, isSigner: false, isWritable: false },
        { pubkey: collectionPda, isSigner: false, isWritable: false },
        { pubkey: offerPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: bidderPk, isSigner: false, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: metadataPda, isSigner: false, isWritable: false },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: bidderAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const data = Buffer.concat([anchorIxDisc('accept_offer')]);
      const ix = new TransactionInstruction({ keys, programId: OFFERS_PROGRAM_ID, data });
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), offerPda: offerPda.toBase58(), vaultPda: vaultPda.toBase58() });
    }

    // Program mint (Anchor) — mints via on-chain program with locked metadata
    if (pathname === '/api/tx/program-mint' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { id, payer, recipient, nonce, lock = true } = body || {};
      if (!id || !payer) return sendJson(res, 400, { error: 'id, payer required' });
      const dbh = await getDb();
      const cfg = await dbh.getCollectionById(id);
      if (!cfg) return sendJson(res, 404, { error: 'collection not found' });
      // Enforce mint window
      const now = Math.floor(Date.now() / 1000);
      const start = cfg.mintStartTs != null ? Number(cfg.mintStartTs) : null;
      const end = cfg.mintEndTs != null ? Number(cfg.mintEndTs) : null;
      if (start != null && now < start) return sendJson(res, 400, { error: 'mint not started', start, end });
      if (end != null && now > end) return sendJson(res, 400, { error: 'mint ended', start, end });
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
      const perMintUri = resolveMetadataUriForMint(cfg, mintPda.toBase58()) || (cfg.metadata_gateway || cfg.metadata_uri);
      const royaltyBps = 0;
      const shouldLock = !!(cfg.lock_new_mints || lock);
      const buildMintDataV2 = () => {
        const uriBytes = Buffer.from(String(perMintUri || ''));
        const uriLen = Buffer.alloc(4); uriLen.writeUInt32LE(uriBytes.length);
        return Buffer.concat([
          anchorIxDisc('mint_v2'),
          (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(nonceU64); return b; })(),
          Buffer.from([0]), // keep mutable for post-mint updates
          (() => { const b=Buffer.alloc(2); b.writeUInt16LE(royaltyBps); return b; })(),
          uriLen,
          uriBytes,
        ]);
      };
      const buildMintDataV1 = () => Buffer.concat([
        anchorIxDisc('mint'),
        (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(nonceU64); return b; })(),
        Buffer.from([0]), // keep mutable for post-mint updates
      ]);
      // Try v2 first; if simulation fails, fall back to v1 for older program versions
      let data = buildMintDataV2();
      try {
        const simTx = new Transaction();
        simTx.feePayer = payerPk; simTx.add(new TransactionInstruction({ keys, programId: COLLECTION_PROGRAM_ID, data }));
        const { blockhash } = await conn.getLatestBlockhash('finalized');
        simTx.recentBlockhash = blockhash;
        await conn.simulateTransaction(simTx, { sigVerify: false });
      } catch {
        data = buildMintDataV1();
      }
      const ix = new TransactionInstruction({ keys, programId: COLLECTION_PROGRAM_ID, data });
      const tx = new Transaction();
      tx.feePayer = payerPk;
      tx.add(ix);
      const { blockhash } = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = blockhash;
      // Always append a post-mint metadata update signed by the owner (deployer)
      // so older on-chain programs (v1) end up with correct URI/royalty/creators.
      try {
        const perMintUri2 = resolveMetadataUriForMint(cfg, mintPda.toBase58()) || (cfg.metadata_gateway || cfg.metadata_uri);
        const royaltyBps2 = 0;
        const creators2 = [ { address: new PublicKey(cfg.owner), verified: 0, share: 100 } ];
        const dataV2b = {
          name: cfg.name || 'CARV NFT',
          symbol: cfg.symbol || 'CARV',
          uri: perMintUri2,
          sellerFeeBasisPoints: royaltyBps2,
          creators: creators2,
          collection: null,
          uses: null,
        };
        const updIx2 = createUpdateMetadataAccountV2Instruction({
          metadata: metadataPda,
          updateAuthority: deployer.publicKey,
          data: dataV2b,
          newUpdateAuthority: null,
          primarySaleHappened: null,
          isMutable: true,
        });
        tx.add(updIx2);
        tx.partialSign(deployer);
      } catch {}

      // If the collection policy wants locked metadata, perform a final lock after updates
      try {
        if (shouldLock) {
          const lockIx = createUpdateMetadataAccountV2Instruction({
            metadata: metadataPda,
            updateAuthority: deployer.publicKey,
            data: null,
            newUpdateAuthority: null,
            primarySaleHappened: null,
            isMutable: false,
          });
          tx.add(lockIx);
          tx.partialSign(deployer);
        }
      } catch {}
      // Append set_and_verify_sized if collection mint configured
      try {
        if (cfg.collection_mint) {
          const collMint = new PublicKey(cfg.collection_mint);
          const collMeta = findMetadataPda(collMint);
          const collEdition = findMasterEditionPda(collMint);
          const collAuthRec = PublicKey.findProgramAddressSync([
            Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), collMint.toBuffer(), Buffer.from('collection_authority'), deployer.publicKey.toBuffer()
          ], TOKEN_METADATA_PROGRAM_ID)[0];
          const data2 = Buffer.from(getVerifySizedSer().serialize({}));
          const keys2 = [
            { pubkey: metadataPda, isSigner: false, isWritable: true },
            { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
            { pubkey: payerPk, isSigner: true, isWritable: true },
            { pubkey: collMint, isSigner: false, isWritable: false },
            { pubkey: collMeta, isSigner: false, isWritable: true },
            { pubkey: collEdition, isSigner: false, isWritable: false },
            { pubkey: collAuthRec, isSigner: false, isWritable: false },
          ];
          tx.add(new TransactionInstruction({ keys: keys2, programId: TOKEN_METADATA_PROGRAM_ID, data: data2 }));
          tx.partialSign(deployer);
        }
      } catch {}
      const serialized = tx.serialize({ requireAllSignatures: false });
      return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), mint: mintPda.toBase58() });
    }

    // Program mint (direct) — build tx using a provided collection PDA (no DB read)
    if (pathname === '/api/tx/program-mint-direct' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { payer, owner, recipient, collectionPda: collStr, nonce, lock = true } = body || {};
      if (!payer || !owner || !collStr) return sendJson(res, 400, { error: 'payer, owner, collectionPda required' });
      const payerPk = new PublicKey(payer);
      const ownerPk = new PublicKey(owner);
      const recPk = new PublicKey(recipient || payer);
      const collectionPda = new PublicKey(collStr);

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
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      ];
      // Default URI/royalty for v2; client could update metadata later if desired
      const royaltyBps = 0;
      const buildV2 = () => {
        const uriBytes = Buffer.from('');
        const uriLen = Buffer.alloc(4); uriLen.writeUInt32LE(uriBytes.length);
        return Buffer.concat([
          anchorIxDisc('mint_v2'),
          (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(nonceU64); return b; })(),
          Buffer.from([lock ? 1 : 0]),
          (() => { const b=Buffer.alloc(2); b.writeUInt16LE(royaltyBps); return b; })(),
          uriLen,
          uriBytes,
        ]);
      };
      const buildV1 = () => Buffer.concat([
        anchorIxDisc('mint'),
        (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(nonceU64); return b; })(),
        Buffer.from([lock ? 1 : 0]),
      ]);
      let data = buildV2();
      try {
        const simTx = new Transaction();
        simTx.feePayer = payerPk; simTx.add(new TransactionInstruction({ keys, programId: COLLECTION_PROGRAM_ID, data }));
        const { blockhash } = await conn.getLatestBlockhash('finalized');
        simTx.recentBlockhash = blockhash;
        await conn.simulateTransaction(simTx, { sigVerify: false });
      } catch { data = buildV1(); }
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
      let { name, symbol, supply = 0, price = 0, imageCid, metadataUri, metadataGateway, owner, onchainPda, mintStartTs = null, mintEndTs = null, royaltyBps = null, limitOnePerWallet = false, discord_user_id } = body || {};
      if (!name || !symbol || !metadataUri) {
        return sendJson(res, 400, { error: 'name, symbol, metadataUri required' });
      }
      // If we have a Discord user id, resolve or create a per-user wallet and prefer it as owner
      if (discord_user_id) {
        try {
          const wallet = await resolveOrCreateDiscordWallet(discord_user_id);
          if (wallet && wallet.ownerPubkey) {
            owner = wallet.ownerPubkey;
          }
        } catch (e) {
          console.error('resolveOrCreateDiscordWallet (deploy/config) failed:', e?.message || e);
        }
      }
      if (!owner) {
        return sendJson(res, 400, { error: 'owner required' });
      }
      const parsedSupply = Number(supply);
      if (!Number.isInteger(parsedSupply) || parsedSupply < 10 || parsedSupply > 100000) {
        return sendJson(res, 400, { error: 'supply must be an integer between 10 and 100000' });
      }
      const dbh = await getDb();
      const priceLamports = Math.max(0, Math.round(Number(price || 0) * LAMPORTS_PER_SOL));
      // Clamp royalty to 0..2500 bps (max 25%)
      const rb = royaltyBps != null ? Math.max(0, Math.min(2500, Number(royaltyBps) | 0)) : 0;
      // Accept optional verified-collection related fields
      const {
        lockNewMints = false,
        collectionMint = null,
        collectionCoverCid = null,
        collectionCoverGateway = null,
        collectionMetaUri = null,
        collectionMetaGateway = null,
      } = body || {};
      const id = await dbh.createCollection({
        name,
        symbol,
        supply: parsedSupply,
        priceLamports,
        imageCid,
        metadataUri,
        metadataGateway,
        owner,
        onchainPda,
        mintStartTs,
        mintEndTs,
        collectionMint,
        lockNewMints,
        collectionCoverCid,
        collectionCoverGateway,
        collectionMetaUri,
        collectionMetaGateway,
        royaltyBps: rb,
        limitOnePerWallet: !!limitOnePerWallet,
      });
      return sendJson(res, 200, { id });
    }

    // Build a parent collection NFT for Verified (Sized) Collections and delegate collection authority to server deployer.
    if (pathname === '/api/tx/create-collection-nft' && req.method === 'POST') {
      const body = await getParsedBody(req);
      const { owner, name, symbol, metadataUri } = body || {};
      if (!owner || !name || !symbol || !metadataUri) return sendJson(res, 400, { error: 'owner, name, symbol, metadataUri required' });
      try {
        const ownerPk = new PublicKey(owner);
        // Clamp to Metaplex constraints: name <= 32, symbol <= 10
        const nameClamped = String(name).slice(0, 32);
        const symbolClamped = String(symbol).slice(0, 10);
        const mint = Keypair.generate();
        const lamportsForMint = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
        const ata = await getAssociatedTokenAddress(mint.publicKey, ownerPk);
        const ixes = [];
        ixes.push(SystemProgram.createAccount({ fromPubkey: ownerPk, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports: lamportsForMint, programId: TOKEN_PROGRAM_ID }));
        ixes.push(createInitializeMintInstruction(mint.publicKey, 0, ownerPk, ownerPk));
        ixes.push(createAssociatedTokenAccountInstruction(ownerPk, ata, ownerPk, mint.publicKey));
        ixes.push(createMintToInstruction(mint.publicKey, ata, ownerPk, 1));
        const metaPda = findMetadataPda(mint.publicKey);
        const editionPda = findMasterEditionPda(mint.publicKey);
        const dataV2 = { name: nameClamped, symbol: symbolClamped, uri: metadataUri, sellerFeeBasisPoints: 0, creators: [{ address: ownerPk, verified: 1, share: 100 }], collection: null, uses: null };
        ixes.push(new TransactionInstruction({
          keys: [
            { pubkey: metaPda, isSigner: false, isWritable: true },
            { pubkey: mint.publicKey, isSigner: false, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: ownerPk, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ], programId: TOKEN_METADATA_PROGRAM_ID, data: Buffer.from(getMetaSer().serialize({ data: dataV2, isMutable: true, collectionDetails: null }))
        }));
        ixes.push(new TransactionInstruction({
          keys: [
            { pubkey: editionPda, isSigner: false, isWritable: true },
            { pubkey: mint.publicKey, isSigner: false, isWritable: true },
            { pubkey: ownerPk, isSigner: true, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: metaPda, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ], programId: TOKEN_METADATA_PROGRAM_ID, data: Buffer.from(getMeSer().serialize({ maxSupply: 0 }))
        }));
        // Set collection size to 0 (mark as sized). Only update authority must sign.
        // Do NOT include a collectionAuthorityRecord when the signer is the update authority.
        const setSizeData = Buffer.from(getSetCollectionSizeSer().serialize({ setCollectionSizeArgs: { size: BigInt(0) } }));
        ixes.push(new TransactionInstruction({
          keys: [
            { pubkey: metaPda, isSigner: false, isWritable: true },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          ], programId: TOKEN_METADATA_PROGRAM_ID, data: setSizeData
        }));
        // Approve server deployer as collection authority
        const collAuthRec = PublicKey.findProgramAddressSync([
          Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer(), Buffer.from('collection_authority'), deployer.publicKey.toBuffer()
        ], TOKEN_METADATA_PROGRAM_ID)[0];
        const approveData = Buffer.from(getApproveCollAuthSer().serialize({}));
        ixes.push(new TransactionInstruction({
          keys: [
            { pubkey: collAuthRec, isSigner: false, isWritable: true },
            { pubkey: deployer.publicKey, isSigner: false, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: metaPda, isSigner: false, isWritable: false },
            { pubkey: mint.publicKey, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ], programId: TOKEN_METADATA_PROGRAM_ID, data: approveData
        }));
        const tx = new Transaction();
        tx.feePayer = ownerPk;
        ixes.forEach(ix => tx.add(ix));
        const { blockhash } = await conn.getLatestBlockhash('finalized');
        tx.recentBlockhash = blockhash;
        tx.partialSign(mint);
        const serialized = tx.serialize({ requireAllSignatures: false });
        return sendJson(res, 200, { tx: Buffer.from(serialized).toString('base64'), mint: mint.publicKey.toBase58() });
      } catch (e) {
        return sendJson(res, 500, { error: 'failed to build collection NFT tx' });
      }
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
