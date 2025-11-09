#!/usr/bin/env node
// Migrate local data.json into Upstash REST KV used by the app.
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
//   node scripts/migrate-to-kv.mjs --file ./data.json --key bang:db

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const file = getArg('file', './data.json');
const key = getArg('key', process.env.KV_KEY || 'bang:db');
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('Missing KV REST envs. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
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

const endpoint = `${url.replace(/\/?$/, '')}/set/${encodeURIComponent(key)}`;
const body = { value: JSON.stringify(json) };

const r = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
if (!r.ok) {
  const t = await r.text().catch(() => '');
  console.error('KV set failed:', r.status, t);
  process.exit(1);
}
console.log('KV updated key', key, 'from', full);

