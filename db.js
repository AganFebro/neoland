// Lightweight DB layer with SQLite (better-sqlite3) if available,
// and a safe file-based fallback with serialized writes.
// ESM module (package.json has type: module)

import fs from 'fs';
import { readFile, writeFile, rename, stat as fsStat } from 'fs/promises';
import path from 'path';

// Allow overriding paths for serverless (e.g., use /tmp on Vercel)
const DATA_JSON_PATH = path.resolve(process.env.DATA_JSON_PATH || './data.json');
const DATA_SQLITE_PATH = path.resolve(process.env.DATA_SQLITE_PATH || './data.sqlite');

function nowTs() { return Math.floor(Date.now() / 1000); }
function randId() { return Math.random().toString(36).slice(2, 10); }

async function fileExists(p) {
  try { await fsStat(p); return true; } catch { return false; }
}

class FileDB {
  constructor() {
    this._loaded = false;
    this._db = {};
    this._queue = Promise.resolve();
  }
  async _load() {
    if (this._loaded) return;
    try {
      const raw = await readFile(DATA_JSON_PATH, 'utf8');
      this._db = JSON.parse(raw);
    } catch { this._db = {}; }
    this._loaded = true;
  }
  async _save() {
    const tmp = DATA_JSON_PATH + '.tmp';
    const body = JSON.stringify(this._db, null, 2);
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, DATA_JSON_PATH);
  }
  async _mutate(fn) {
    await this._load();
    this._queue = this._queue.then(async () => {
      await fn(this._db);
      await this._save();
    }).catch(() => {});
    return this._queue;
  }
  async init() { await this._load(); }
  // Collections
  async getCollections() {
    await this._load();
    return Object.entries(this._db)
      .filter(([id, c]) => id !== 'market' && c && typeof c === 'object' && (c.collectionName || c.symbol || c.metadata_uri))
      .map(([id, c]) => ({
        id,
        owner: c.deployer_address || null,
        name: c.collectionName || 'Collection',
        symbol: c.symbol || '',
        supply: Number(c.supply || 0),
        priceLamports: Number(c.priceLamports ?? Math.round(Number(c.price || 0) * 1_000_000_000)),
        image_cid: c.image_cid || null,
        image_gateway: c.image_gateway || null,
        metadata_uri: c.metadata_uri || null,
        metadata_gateway: c.metadata_gateway || null,
        minted_count: Number(c.minted_count || 0),
        created_at: Number(c.created_at || 0),
      }));
  }
  async getCollectionById(id) {
    await this._load();
    const c = this._db[id];
    if (!c) return null;
    return {
      id,
      owner: c.deployer_address || null,
      name: c.collectionName || 'Collection',
      symbol: c.symbol || '',
      supply: Number(c.supply || 0),
      priceLamports: Number(c.priceLamports ?? Math.round(Number(c.price || 0) * 1_000_000_000)),
      image_cid: c.image_cid || null,
      image_gateway: c.image_gateway || null,
      metadata_uri: c.metadata_uri || null,
      metadata_gateway: c.metadata_gateway || null,
      minted_count: Number(c.minted_count || 0),
      created_at: Number(c.created_at || 0),
      mints: Array.isArray(c.mints) ? c.mints.slice() : [],
      mintEvents: Array.isArray(c.mintEvents) ? c.mintEvents.slice() : [],
    };
  }
  async createCollection({ name, symbol, supply, priceLamports, imageCid, metadataUri, metadataGateway, owner }) {
    const id = randId();
    await this._mutate((db) => {
      db[id] = {
        deployer_address: owner,
        collectionName: name,
        symbol,
        supply: Number(supply || 0),
        price: Number(priceLamports || 0) / 1_000_000_000,
        priceLamports: Number(priceLamports || 0),
        image_cid: imageCid || null,
        image_gateway: imageCid ? (process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud') + '/ipfs/' + imageCid : null,
        metadata_uri: metadataUri,
        metadata_gateway: metadataGateway || null,
        tokenAddress: null,
        minted_count: 0,
        mints: [],
        mintEvents: [],
        created_at: nowTs(),
      };
    });
    return id;
  }
  async getMintsForCollection(id) {
    const c = await this.getCollectionById(id);
    return { mints: c ? (c.mints || []) : [], image_gateway: c?.image_gateway || null };
  }
  async recordMint({ id, mint, minter = null, ts = nowTs() }) {
    await this._mutate((db) => {
      if (!db[id]) return;
      db[id].mints = Array.isArray(db[id].mints) ? db[id].mints : [];
      if (!db[id].mints.includes(mint)) db[id].mints.push(mint);
      db[id].mintEvents = Array.isArray(db[id].mintEvents) ? db[id].mintEvents : [];
      db[id].mintEvents.push({ mint, minter, ts: Number(ts) || nowTs() });
      db[id].minted_count = Number(db[id].minted_count || 0) + 1;
    });
    return true;
  }
  // Listings
  async getListings({ collectionId, seller, activeOnly = true }) {
    await this._load();
    const market = this._db.market || { listings: [] };
    let listings = Array.isArray(market.listings) ? market.listings.slice() : [];
    if (collectionId) listings = listings.filter((l) => l.collectionId === collectionId);
    if (seller) listings = listings.filter((l) => l.seller === seller);
    if (activeOnly) listings = listings.filter((l) => !l.cancelled && !l.soldAt);
    return listings;
  }
  async getListingById(id) {
    await this._load();
    const market = this._db.market || { listings: [] };
    return (market.listings || []).find((x) => x.id === id) || null;
  }
  async createListing({ mint, collectionId, seller, priceLamports }) {
    const id = randId();
    const createdAt = nowTs();
    await this._mutate((db) => {
      db.market = db.market || { listings: [] };
      db.market.listings = Array.isArray(db.market.listings) ? db.market.listings : [];
      db.market.listings.push({ id, mint, collectionId, seller, priceLamports: Number(priceLamports || 0), createdAt });
    });
    return { id };
  }
  async cancelListing({ listingId }) {
    const when = nowTs();
    await this._mutate((db) => {
      const arr = (((db.market || {}).listings) || []);
      const i = arr.findIndex((l) => l.id === listingId);
      if (i !== -1) arr[i].cancelled = when;
      db.market = db.market || { listings: [] };
      db.market.listings = arr;
    });
    return true;
  }
  async markSold({ listingId, buyer }) {
    const when = nowTs();
    await this._mutate((db) => {
      const arr = (((db.market || {}).listings) || []);
      const i = arr.findIndex((l) => l.id === listingId);
      if (i !== -1) { arr[i].soldAt = when; arr[i].buyer = buyer; }
      db.market = db.market || { listings: [] };
      db.market.listings = arr;
    });
    return true;
  }
  async getCollectionsWithMints() {
    await this._load();
    const out = [];
    for (const [id, c] of Object.entries(this._db)) {
      if (id === 'market') continue;
      if (!c || typeof c !== 'object') continue;
      if (!(c.collectionName || c.symbol || c.metadata_uri)) continue;
      out.push({
        id,
        name: c.collectionName || 'Collection',
        symbol: c.symbol || '',
        image_gateway: c.image_gateway || null,
        mints: Array.isArray(c.mints) ? c.mints.slice() : [],
      });
    }
    return out;
  }
}

// Simple KV-backed DB for Vercel KV / Upstash Redis REST API
class KVDB {
  constructor({ url, token, key = 'bang:db' }) {
    this.url = url.replace(/\/?$/, '');
    this.token = token;
    this.key = key;
    this._loaded = false;
    this._db = {};
  }
  async _kvGet() {
    const r = await fetch(`${this.url}/get/${encodeURIComponent(this.key)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    if (!j || j.result == null) return null;
    try { return JSON.parse(j.result); } catch { return null; }
  }
  async _kvSet(val) {
    const body = { value: JSON.stringify(val) };
    const r = await fetch(`${this.url}/set/${encodeURIComponent(this.key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('kv set failed: ' + r.status);
    return true;
  }
  async _load() {
    if (this._loaded) return;
    try {
      const j = await this._kvGet();
      this._db = j && typeof j === 'object' ? j : {};
    } catch { this._db = {}; }
    this._loaded = true;
  }
  async _save() { await this._kvSet(this._db); }
  async init() { await this._load(); }
  // Collections
  async getCollections() {
    await this._load();
    return Object.entries(this._db)
      .filter(([id, c]) => id !== 'market' && c && typeof c === 'object' && (c.collectionName || c.symbol || c.metadata_uri))
      .map(([id, c]) => ({
        id,
        owner: c.deployer_address || null,
        name: c.collectionName || 'Collection',
        symbol: c.symbol || '',
        supply: Number(c.supply || 0),
        priceLamports: Number(c.priceLamports ?? Math.round(Number(c.price || 0) * 1_000_000_000)),
        image_cid: c.image_cid || null,
        image_gateway: c.image_gateway || null,
        metadata_uri: c.metadata_uri || null,
        metadata_gateway: c.metadata_gateway || null,
        minted_count: Number(c.minted_count || 0),
        created_at: Number(c.created_at || 0),
      }));
  }
  async getCollectionById(id) {
    await this._load();
    const c = this._db[id];
    if (!c) return null;
    return {
      id,
      owner: c.deployer_address || null,
      name: c.collectionName || 'Collection',
      symbol: c.symbol || '',
      supply: Number(c.supply || 0),
      priceLamports: Number(c.priceLamports ?? Math.round(Number(c.price || 0) * 1_000_000_000)),
      image_cid: c.image_cid || null,
      image_gateway: c.image_gateway || null,
      metadata_uri: c.metadata_uri || null,
      metadata_gateway: c.metadata_gateway || null,
      minted_count: Number(c.minted_count || 0),
      created_at: Number(c.created_at || 0),
      mints: Array.isArray(c.mints) ? c.mints.slice() : [],
      mintEvents: Array.isArray(c.mintEvents) ? c.mintEvents.slice() : [],
    };
  }
  async createCollection({ name, symbol, supply, priceLamports, imageCid, metadataUri, metadataGateway, owner }) {
    await this._load();
    const id = randId();
    const now = nowTs();
    this._db[id] = {
      deployer_address: owner,
      collectionName: name,
      symbol,
      supply: Number(supply || 0),
      price: Number(priceLamports || 0) / 1_000_000_000,
      priceLamports: Number(priceLamports || 0),
      image_cid: imageCid || null,
      image_gateway: imageCid ? (process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud') + '/ipfs/' + imageCid : null,
      metadata_uri: metadataUri,
      metadata_gateway: metadataGateway || null,
      tokenAddress: null,
      minted_count: 0,
      mints: [],
      mintEvents: [],
      created_at: now,
    };
    await this._save();
    return id;
  }
  async getMintsForCollection(id) {
    const c = await this.getCollectionById(id);
    return { mints: c ? (c.mints || []) : [], image_gateway: c?.image_gateway || null };
  }
  async recordMint({ id, mint, minter = null, ts = nowTs() }) {
    await this._load();
    if (!this._db[id]) return false;
    const coll = this._db[id];
    coll.mints = Array.isArray(coll.mints) ? coll.mints : [];
    if (!coll.mints.includes(mint)) coll.mints.push(mint);
    coll.mintEvents = Array.isArray(coll.mintEvents) ? coll.mintEvents : [];
    coll.mintEvents.push({ mint, minter, ts: Number(ts) || nowTs() });
    coll.minted_count = Number(coll.minted_count || 0) + 1;
    await this._save();
    return true;
  }
  // Listings
  async getListings({ collectionId, seller, activeOnly = true }) {
    await this._load();
    const market = this._db.market || { listings: [] };
    let listings = Array.isArray(market.listings) ? market.listings.slice() : [];
    if (collectionId) listings = listings.filter((l) => l.collectionId === collectionId);
    if (seller) listings = listings.filter((l) => l.seller === seller);
    if (activeOnly) listings = listings.filter((l) => !l.cancelled && !l.soldAt);
    return listings;
  }
  async getListingById(id) {
    await this._load();
    const market = this._db.market || { listings: [] };
    const listings = Array.isArray(market.listings) ? market.listings : [];
    return listings.find((l) => l.id === id) || null;
  }
  async createListing({ mint, collectionId, seller, priceLamports }) {
    await this._load();
    const id = randId();
    const createdAt = nowTs();
    if (!this._db.market) this._db.market = { listings: [] };
    this._db.market.listings.push({ id, mint, collectionId, seller, priceLamports: Number(priceLamports || 0), createdAt });
    await this._save();
    return { id };
  }
  async cancelListing({ listingId }) {
    await this._load();
    const l = await this.getListingById(listingId);
    if (l) { l.cancelled = nowTs(); await this._save(); }
    return true;
  }
  async markSold({ listingId, buyer }) {
    await this._load();
    const l = await this.getListingById(listingId);
    if (l) { l.soldAt = nowTs(); l.buyer = buyer || null; await this._save(); }
    return true;
  }
  async getCollectionsWithMints() {
    const cols = await this.getCollections();
    return cols.map((c) => ({ id: c.id, name: c.name, symbol: c.symbol, image_gateway: c.image_gateway, mints: (this._db[c.id]?.mints || []).slice() }));
  }
}

class SQLiteDB {
  constructor(Database) {
    this.db = new Database(DATA_SQLITE_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._writes = 0;
    this._prepare();
  }
  _prepare() {
    // If any part of schema setup fails, surface error to trigger fallback.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        owner TEXT,
        name TEXT,
        symbol TEXT,
        supply INTEGER,
        price_lamports INTEGER,
        image_cid TEXT,
        image_gateway TEXT,
        metadata_uri TEXT,
        metadata_gateway TEXT,
        minted_count INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mints (
        mint TEXT PRIMARY KEY,
        collection_id TEXT,
        minter TEXT,
        ts INTEGER,
        FOREIGN KEY(collection_id) REFERENCES collections(id)
      );
      CREATE TABLE IF NOT EXISTS market_listings (
        id TEXT PRIMARY KEY,
        collection_id TEXT,
        mint TEXT,
        seller TEXT,
        price_lamports INTEGER,
        created_at INTEGER,
        cancelled INTEGER,
        sold_at INTEGER,
        buyer TEXT,
        FOREIGN KEY(collection_id) REFERENCES collections(id)
      );
      CREATE INDEX IF NOT EXISTS idx_mints_coll ON mints(collection_id);
      CREATE INDEX IF NOT EXISTS idx_listings_coll ON market_listings(collection_id);
      CREATE INDEX IF NOT EXISTS idx_listings_seller ON market_listings(seller);
    `);
    this.stmts = {
      insColl: this.db.prepare(`INSERT INTO collections (id, owner, name, symbol, supply, price_lamports, image_cid, image_gateway, metadata_uri, metadata_gateway, minted_count, created_at) VALUES (@id, @owner, @name, @symbol, @supply, @price_lamports, @image_cid, @image_gateway, @metadata_uri, @metadata_gateway, @minted_count, @created_at)`),
      selAllColl: this.db.prepare(`SELECT * FROM collections`),
      selColl: this.db.prepare(`SELECT * FROM collections WHERE id = ?`),
      updCollMinted: this.db.prepare(`UPDATE collections SET minted_count = minted_count + 1 WHERE id = ?`),
      insMint: this.db.prepare(`INSERT OR IGNORE INTO mints (mint, collection_id, minter, ts) VALUES (?, ?, ?, ?)`),
      selMints: this.db.prepare(`SELECT mint FROM mints WHERE collection_id = ?`),
      selListings: this.db.prepare(`SELECT * FROM market_listings`),
      insListing: this.db.prepare(`INSERT INTO market_listings (id, collection_id, mint, seller, price_lamports, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      selListingById: this.db.prepare(`SELECT * FROM market_listings WHERE id = ?`),
      cancelListing: this.db.prepare(`UPDATE market_listings SET cancelled = ? WHERE id = ?`),
      soldListing: this.db.prepare(`UPDATE market_listings SET sold_at = ?, buyer = ? WHERE id = ?`),
      countColl: this.db.prepare(`SELECT COUNT(1) as c FROM collections`),
    };
  }
  async init() {
    // Migrate from data.json if DB empty
    if (!this.stmts) throw new Error('SQLite statements not prepared');
    const c = this.stmts.countColl.get().c;
    if (c === 0 && await fileExists(DATA_JSON_PATH)) {
      try {
        const raw = await readFile(DATA_JSON_PATH, 'utf8');
        const j = JSON.parse(raw);
        const tx = this.db.transaction(() => {
          for (const [id, v] of Object.entries(j)) {
            if (id === 'market') continue;
            if (!v || typeof v !== 'object') continue;
            const row = {
              id,
              owner: v.deployer_address || null,
              name: v.collectionName || 'Collection',
              symbol: v.symbol || '',
              supply: Number(v.supply || 0),
              price_lamports: Number(v.priceLamports ?? Math.round(Number(v.price || 0) * 1_000_000_000)),
              image_cid: v.image_cid || null,
              image_gateway: v.image_gateway || null,
              metadata_uri: v.metadata_uri || null,
              metadata_gateway: v.metadata_gateway || null,
              minted_count: Number(v.minted_count || 0),
              created_at: Number(v.created_at || nowTs()),
            };
            this.stmts.insColl.run(row);
            const mints = Array.isArray(v.mints) ? v.mints : [];
            mints.forEach((m) => this.stmts.insMint.run(m, id, null, 0));
          }
          const market = (j.market || {}).listings || [];
          market.forEach((l) => {
            this.stmts.insListing.run(l.id, l.collectionId, l.mint, l.seller, Number(l.priceLamports || 0), Number(l.createdAt || nowTs()));
            if (l.cancelled) this.stmts.cancelListing.run(Number(l.cancelled), l.id);
            if (l.soldAt) this.stmts.soldListing.run(Number(l.soldAt), l.buyer || null, l.id);
          });
        });
        tx();
      } catch {}
    }
  }
  async getCollections() { return this.stmts.selAllColl.all().map((r) => this._mapColl(r)); }
  async getCollectionById(id) { const r = this.stmts.selColl.get(id); return r ? this._mapColl(r, true) : null; }
  _mapColl(r, withArrays = false) {
    const mapped = {
      id: r.id,
      owner: r.owner,
      name: r.name,
      symbol: r.symbol,
      supply: Number(r.supply || 0),
      priceLamports: Number(r.price_lamports || 0),
      image_cid: r.image_cid || null,
      image_gateway: r.image_gateway || null,
      metadata_uri: r.metadata_uri || null,
      metadata_gateway: r.metadata_gateway || null,
      minted_count: Number(r.minted_count || 0),
      created_at: Number(r.created_at || 0),
    };
    if (withArrays) {
      mapped.mints = this.stmts.selMints.all(r.id).map((x) => x.mint);
    }
    return mapped;
  }
  async createCollection({ name, symbol, supply, priceLamports, imageCid, metadataUri, metadataGateway, owner }) {
    const id = randId();
    this.stmts.insColl.run({ id, owner, name, symbol, supply: Number(supply || 0), price_lamports: Number(priceLamports || 0), image_cid: imageCid || null, image_gateway: imageCid ? (process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud') + '/ipfs/' + imageCid : null, metadata_uri: metadataUri, metadata_gateway: metadataGateway || null, minted_count: 0, created_at: nowTs() });
    this._maybeCheckpoint();
    return id;
  }
  async getMintsForCollection(id) {
    const coll = await this.getCollectionById(id);
    const mints = this.stmts.selMints.all(id).map((x) => x.mint);
    return { mints, image_gateway: coll?.image_gateway || null };
  }
  async recordMint({ id, mint, minter = null, ts = nowTs() }) {
    const tx = this.db.transaction((id, mint, minter, ts) => {
      this.stmts.insMint.run(mint, id, minter, Number(ts || nowTs()));
      this.stmts.updCollMinted.run(id);
    });
    tx(id, mint, minter, ts);
    this._maybeCheckpoint();
    return true;
  }
  async getListings({ collectionId, seller, activeOnly = true }) {
    let rows = this.stmts.selListings.all();
    if (collectionId) rows = rows.filter((r) => r.collection_id === collectionId);
    if (seller) rows = rows.filter((r) => r.seller === seller);
    if (activeOnly) rows = rows.filter((r) => !r.cancelled && !r.sold_at);
    return rows.map((r) => ({ id: r.id, collectionId: r.collection_id, mint: r.mint, seller: r.seller, priceLamports: Number(r.price_lamports || 0), createdAt: Number(r.created_at || 0), cancelled: r.cancelled || null, soldAt: r.sold_at || null, buyer: r.buyer || null }));
  }
  async getListingById(id) {
    const r = this.stmts.selListingById.get(id);
    if (!r) return null;
    return { id: r.id, collectionId: r.collection_id, mint: r.mint, seller: r.seller, priceLamports: Number(r.price_lamports || 0), createdAt: Number(r.created_at || 0), cancelled: r.cancelled || null, soldAt: r.sold_at || null, buyer: r.buyer || null };
  }
  async createListing({ mint, collectionId, seller, priceLamports }) {
    const id = randId();
    this.stmts.insListing.run(id, collectionId, mint, seller, Number(priceLamports || 0), nowTs());
    this._maybeCheckpoint();
    return { id };
  }
  async cancelListing({ listingId }) { this.stmts.cancelListing.run(nowTs(), listingId); this._maybeCheckpoint(); return true; }
  async markSold({ listingId, buyer }) { this.stmts.soldListing.run(nowTs(), buyer, listingId); this._maybeCheckpoint(); return true; }
  async getCollectionsWithMints() {
    const cols = await this.getCollections();
    return cols.map((c) => ({ id: c.id, name: c.name, symbol: c.symbol, image_gateway: c.image_gateway, mints: this.stmts.selMints.all(c.id).map((x) => x.mint) }));
  }
  _maybeCheckpoint() {
    try {
      this._writes = (this._writes || 0) + 1;
      if (this._writes >= 10) {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        this._writes = 0;
      }
    } catch {}
  }
}

let impl = null;
export async function initDb() {
  if (impl) return impl;
  // Prefer KV if configured (works on Vercel serverless)
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (kvUrl && kvToken) {
    try {
      impl = new KVDB({ url: kvUrl, token: kvToken, key: process.env.KV_KEY || 'bang:db' });
      await impl.init();
      return impl;
    } catch (e) {
      console.warn('[db] KV init failed, attempting SQLite/file fallback:', e?.message || e);
      impl = null;
    }
  }
  let sqliteMod = null;
  try {
    sqliteMod = await import('better-sqlite3');
  } catch (e) {
    sqliteMod = null;
  }
  if (sqliteMod) {
    const Database = sqliteMod.default || sqliteMod;
    try {
      impl = new SQLiteDB(Database);
      await impl.init();
      return impl;
    } catch (e) {
      console.warn('[db] SQLite init failed, falling back to file DB:', e?.message || e);
      impl = null;
    }
  }
  impl = new FileDB();
  await impl.init();
  console.warn('[db] better-sqlite3 not available; using file-based DB with serialized writes.');
  return impl;
}

export async function getDb() { return await initDb(); }
