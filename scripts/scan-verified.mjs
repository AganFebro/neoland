#!/usr/bin/env node
// Simple on-chain scanner for NFTs in a Verified (Sized) Collection on CARV SVM testnet
// Usage:
//   node scripts/scan-verified.mjs --collection-mint <PARENT_COLLECTION_MINT> [--rpc <RPC_URL>] [--limit <N>]
//   node scripts/scan-verified.mjs --mint <NFT_MINT> [--rpc <RPC_URL>]
//   node scripts/scan-verified.mjs --owner <WALLET_ADDRESS> [--rpc <RPC_URL>] [--limit <N>]

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey } from '@metaplex-foundation/umi';
import { mplTokenMetadata, fetchDigitalAsset, fetchAllDigitalAssetByOwner } from '@metaplex-foundation/mpl-token-metadata';
import { fetchAllDigitalAssetByVerifiedCollection } from '@metaplex-foundation/mpl-token-metadata';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (name) => args.includes(`--${name}`);
  return { get, has };
}

async function main() {
  const { get } = parseArgs();
  const collectionMintStr = get('collection-mint') || get('collection') || process.env.COLLECTION_MINT;
  const mintStr = get('mint');
  const ownerStr = get('owner') || get('wallet');
  if (!collectionMintStr && !mintStr && !ownerStr) {
    console.error('Missing --collection-mint <MINT>, --mint <MINT>, or --owner <WALLET>');
    process.exit(1);
  }
  const rpc = get('rpc') || process.env.CARV_RPC || process.env.CARV_SVM_RPC || 'https://rpc.testnet.carv.io/rpc';
  const limitStr = get('limit');
  const limit = limitStr ? Math.max(1, parseInt(limitStr, 10) || 0) : 0;

  const umi = createUmi(rpc).use(mplTokenMetadata());

  let assets = [];
  if (collectionMintStr) {
    const collPk = publicKey(collectionMintStr);
    // Fetch all digital assets verified under this collection. This uses GPA filters
    // on the metadata program for the verified collection field.
    console.log(`Scanning collection: ${collectionMintStr} on ${rpc}`);
    assets = await fetchAllDigitalAssetByVerifiedCollection(umi, collPk).catch((e) => {
      console.error('Scan failed:', e?.message || e);
      console.error('Possible issues: Invalid collection mint, RPC endpoint, or no verified NFTs.');
      process.exit(1);
    });
  } else if (mintStr) {
    const mintPk = publicKey(mintStr);
    console.log(`Fetching NFT: ${mintStr} on ${rpc}`);
    const asset = await fetchDigitalAsset(umi, mintPk).catch((e) => {
      console.error('Fetch failed:', e?.message || e);
      console.error('Possible issues: Invalid mint, RPC endpoint, or NFT does not exist.');
      process.exit(1);
    });
    assets = [asset];
  } else if (ownerStr) {
    const ownerPk = publicKey(ownerStr);
    console.log(`Scanning verified NFTs in wallet: ${ownerStr} on ${rpc}`);
    const allAssets = await fetchAllDigitalAssetByOwner(umi, ownerPk).catch((e) => {
      console.error('Scan failed:', e?.message || e);
      console.error('Possible issues: Invalid wallet address, RPC endpoint, or no NFTs owned.');
      process.exit(1);
    });
    // Filter only verified NFTs (those with a verified collection)
    assets = allAssets.filter(a => a.metadata.collection?.verified === true);
  }

  const rows = assets.map((a) => ({
    mint: a.mint.publicKey.toString(),
    name: a.metadata.name,
    symbol: a.metadata.symbol,
    uri: a.metadata.uri,
    verifiedCollection: a.metadata.collection?.key?.toString() || null,
    updateAuthority: a.metadata.updateAuthority.toString(),
  }));

  const out = limit > 0 ? rows.slice(0, limit) : rows;
  console.log(JSON.stringify({ rpc, collectionMint: collectionMintStr, mint: mintStr, owner: ownerStr, total: rows.length, items: out }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

