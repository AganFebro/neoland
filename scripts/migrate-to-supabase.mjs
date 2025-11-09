#!/usr/bin/env node
// Migrate local data.json into Supabase Postgres used by the app.
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/migrate-to-supabase.mjs --file ./data.json

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const file = getArg('file', './data.json');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!url || !key) {
  console.error('Missing Supabase envs. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const full = path.resolve(file);
if (!fs.existsSync(full)) {
  console.error('File not found:', full);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(fs.readFileSync(full, 'utf8'));
} catch (e) {
  console.error('Failed to read/parse JSON:', e.message || e);
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

// Basic upsert logic
for (const [id, v] of Object.entries(json)) {
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
    created_at: Number(v.created_at || Math.floor(Date.now()/1000)),
  };
  const { error: e1 } = await sb.from('collections').upsert(row, { onConflict: 'id' });
  if (e1) { console.error('collections upsert failed for', id, e1.message || e1); process.exit(1); }
  const mints = Array.isArray(v.mints) ? v.mints : [];
  for (const m of mints) {
    const { error: e2 } = await sb.from('mints').upsert({ mint: m, collection_id: id, minter: null, ts: 0 }, { onConflict: 'mint' });
    if (e2) { console.error('mints upsert failed for', m, e2.message || e2); process.exit(1); }
  }
}

const market = (json.market || {}).listings || [];
for (const l of market) {
  const row = {
    id: l.id,
    collection_id: l.collectionId,
    mint: l.mint,
    seller: l.seller,
    price_lamports: Number(l.priceLamports || 0),
    created_at: Number(l.createdAt || Math.floor(Date.now()/1000)),
    cancelled: l.cancelled || null,
    sold_at: l.soldAt || null,
    buyer: l.buyer || null,
  };
  const { error } = await sb.from('market_listings').upsert(row, { onConflict: 'id' });
  if (error) { console.error('listings upsert failed for', l.id, error.message || error); process.exit(1); }
}

console.log('Supabase migration complete from', full);

