-- Supabase schema for neoland app

create table if not exists public.collections (
  id text primary key,
  owner text,
  name text not null,
  symbol text not null,
  supply integer not null default 0,
  price_lamports bigint not null default 0,
  -- If true, each wallet can mint at most one NFT from this collection
  limit_one_per_wallet boolean not null default false,
  -- Creator royalty in basis points (e.g., 500 = 5%)
  royalty_bps integer not null default 0,
  mint_start_ts bigint,
  mint_end_ts bigint,
  trading_paused boolean not null default false,
  mint_paused boolean not null default false,
  -- Parent collection NFT (for Metaplex verified collections)
  collection_mint text,
  -- Default mutability for new mints
  lock_new_mints boolean not null default false,
  -- Optional whitelist as JSON array of base58 addresses
  whitelist jsonb,
  -- Optional marketplace-facing cover and metadata for the parent collection NFT
  collection_cover_cid text,
  collection_cover_gateway text,
  collection_meta_uri text,
  collection_meta_gateway text,
  image_cid text,
  image_gateway text,
  metadata_uri text,
  metadata_gateway text,
  minted_count integer not null default 0,
  created_at bigint not null,
  discord_id text,
  onchain_pda text
);

-- Backward‑compat: add royalty_bps to existing deployments
alter table if exists public.collections
  add column if not exists royalty_bps integer not null default 0;

-- Per-wallet mint limit flag
alter table if exists public.collections
  add column if not exists limit_one_per_wallet boolean not null default false;

create table if not exists public.mints (
  mint text primary key,
  collection_id text not null references public.collections(id) on delete cascade,
  minter text,
  ts bigint not null
);
create index if not exists mints_collection_id_idx on public.mints(collection_id);

create table if not exists public.market_listings (
  id text primary key,
  collection_id text not null references public.collections(id) on delete cascade,
  mint text not null,
  seller text not null,
  price_lamports bigint not null,
  currency_mint text,
  price_amount bigint,
  created_at bigint not null,
  cancelled bigint,
  sold_at bigint,
  buyer text
);
create index if not exists market_listings_active_idx on public.market_listings(collection_id, cancelled, sold_at);

-- Optional: collection-wide offers (for activity + UI)
create table if not exists public.market_offers (
  id text primary key,
  collection_id text not null references public.collections(id) on delete cascade,
  bidder text not null,
  price_lamports bigint not null,
  created_at bigint not null,
  cancelled bigint
);
create index if not exists market_offers_coll_idx on public.market_offers(collection_id);
create index if not exists market_offers_bidder_idx on public.market_offers(bidder);

-- Optional: generic activity log (offers accepted, etc.)
create table if not exists public.market_activity (
  id text primary key,
  collection_id text not null references public.collections(id) on delete cascade,
  type text not null,
  ts bigint not null,
  mint text,
  price_lamports bigint,
  actor1 text,
  actor2 text
);
create index if not exists market_activity_coll_idx on public.market_activity(collection_id, ts desc);

-- Optional helper RPCs
-- Increase minted_count
create or replace function public.inc_minted_count(p_id text)
returns void language sql as $$
  update public.collections set minted_count = minted_count + 1 where id = p_id;
$$;

-- Insert mint and inc minted_count in one call
create or replace function public.record_mint_and_inc(p_collection_id text, p_mint text, p_minter text, p_ts bigint)
returns void language plpgsql as $$
begin
  insert into public.mints(mint, collection_id, minter, ts) values (p_mint, p_collection_id, p_minter, p_ts)
  on conflict (mint) do nothing;
  update public.collections set minted_count = minted_count + 1 where id = p_collection_id;
end;
$$;
