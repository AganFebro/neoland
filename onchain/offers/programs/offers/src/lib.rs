use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction, program_option::COption};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer as SplTransfer};
use mpl_token_metadata::ID as TOKEN_METADATA_PROGRAM_ID;
use mpl_token_metadata::accounts::Metadata as MetaAccount;

declare_id!("OFFERS11111111111111111111111111111111111");

#[program]
pub mod offers {
    use super::*;

    // Create an on-chain offer by escrowing SOL in the offer PDA account.
    pub fn make_offer(ctx: Context<MakeOffer>, price_lamports: u64) -> Result<()> {
        require!(price_lamports > 0, OfferError::InvalidPrice);
        let offer = &mut ctx.accounts.offer;
        offer.collection = ctx.accounts.collection.key();
        offer.bidder = ctx.accounts.bidder.key();
        offer.price = price_lamports;
        offer.bump = ctx.bumps.offer;
        // Create a zero-data vault PDA and fund it with the offer price
        // so we can later transfer via SystemProgram using program-derived
        // signing. Keeping zero data avoids the "from must not carry data"
        // constraint on SystemProgram::Transfer.
        let bidder = &ctx.accounts.bidder;
        let vault = &ctx.accounts.vault;
        let coll_key = ctx.accounts.collection.key();
        let seeds: [&[u8]; 3] = [b"vault", coll_key.as_ref(), bidder.key.as_ref()];
        let (_vault_pda, vault_bump) = Pubkey::find_program_address(&seeds, ctx.program_id);
        require_keys_eq!(_vault_pda, vault.key(), OfferError::InvalidVaultPda);
        let bump_bytes = [vault_bump];
        let signer_seeds: &[&[u8]] = &[b"vault", coll_key.as_ref(), bidder.key.as_ref(), &bump_bytes];
        let signer = &[signer_seeds];
        // Create the vault account with 0 space, owned by SystemProgram; fund with price
        let create_ix = system_instruction::create_account(
            &bidder.key(),
            &vault.key(),
            price_lamports,
            0,
            &anchor_lang::solana_program::system_program::ID,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &create_ix,
            &[
                bidder.to_account_info(),
                vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;
        Ok(())
    }

    // Cancel an offer; refunds escrow + rent to bidder.
    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        // Refund escrowed lamports from the zero-data vault to the bidder.
        let bidder = &ctx.accounts.bidder;
        let coll_key = ctx.accounts.collection.key();
        let vault = &ctx.accounts.vault;
        let (expected_vault, bump) = Pubkey::find_program_address(&[b"vault", coll_key.as_ref(), bidder.key.as_ref()], ctx.program_id);
        // If a matching vault exists, refund its balance. If not, skip (back-compat for
        // offers created before vaults were introduced; close will return offer rent+escrow).
        if vault.key() == expected_vault {
            let amount = **vault.to_account_info().lamports.borrow();
            if amount > 0 {
                let bumpb = [bump];
                let signer_seeds: &[&[u8]] = &[b"vault", coll_key.as_ref(), bidder.key.as_ref(), &bumpb];
                let signer = &[signer_seeds];
                let ix = system_instruction::transfer(&vault.key(), &bidder.key(), amount);
                anchor_lang::solana_program::program::invoke_signed(
                    &ix,
                    &[
                        vault.to_account_info(),
                        bidder.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                    signer,
                )?;
            }
        }
        // Offer account closed to bidder via close = bidder
        Ok(())
    }

    // Configure or update the registry owner for a collection.
    // This allows accepting offers for NFTs whose metadata.update_authority equals `owner`.
    pub fn configure_collection(ctx: Context<ConfigureCollection>, owner: Pubkey) -> Result<()> {
        let reg = &mut ctx.accounts.registry;
        reg.collection = ctx.accounts.collection.key();
        reg.owner = owner;
        reg.bump = ctx.bumps.registry;
        Ok(())
    }

    // Accept an offer: transfers SOL escrow to seller and moves the NFT to the bidder.
    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        let offer = &mut ctx.accounts.offer;

        // Verify the mint belongs to the provided collection.
        // Mode A (original): mint.mint_authority == PDA(["auth", collection], collection_program)
        let coll_key = offer.collection;
        let seeds = [b"auth".as_ref(), coll_key.as_ref()];
        let (auth_pda, _bump) = Pubkey::find_program_address(&seeds, &ctx.accounts.collection_program.key());
        require_keys_eq!(auth_pda, ctx.accounts.collection_authority.key(), OfferError::InvalidCollectionAuthority);
        let mut eligible = ctx.accounts.mint.mint_authority == COption::Some(auth_pda);

        // Mode B (new): metadata.update_authority == registry.owner
        if !eligible {
            // Verify metadata PDA is correct for this mint
            let mint_key = ctx.accounts.mint.key();
            let meta_prog = TOKEN_METADATA_PROGRAM_ID;
            let meta_seeds = [
                b"metadata".as_ref(),
                meta_prog.as_ref(),
                mint_key.as_ref(),
            ];
            let (expected_meta, _mb) = Pubkey::find_program_address(&meta_seeds, &TOKEN_METADATA_PROGRAM_ID);
            require_keys_eq!(expected_meta, ctx.accounts.metadata.key(), OfferError::InvalidMetadataPda);
            // Deserialize and compare update authority
            let meta = MetaAccount::try_from(&ctx.accounts.metadata.to_account_info())
                .map_err(|_| error!(OfferError::InvalidMetadataPda))?;
            if meta.update_authority == ctx.accounts.registry.owner {
                eligible = true;
            }
        }
        require!(eligible, OfferError::MintNotFromCollection);

        // Move escrowed SOL to seller from zero-data vault PDA via SystemProgram
        let coll_key = offer.collection;
        let bidder_key = offer.bidder;
        let vault_ai = ctx.accounts.vault.to_account_info();
        let escrow_balance = **vault_ai.lamports.borrow();
        require!(escrow_balance >= offer.price, OfferError::EscrowUnderfunded);
        let ix = system_instruction::transfer(&vault_ai.key(), &ctx.accounts.seller.key(), offer.price);
        // sign as the vault PDA
        let (expected_vault, vault_bump) = Pubkey::find_program_address(&[b"vault", coll_key.as_ref(), bidder_key.as_ref()], ctx.program_id);
        require_keys_eq!(expected_vault, vault_ai.key(), OfferError::InvalidVaultPda);
        let bump_bytes = [vault_bump];
        let signer_seeds: &[&[u8]] = &[b"vault", coll_key.as_ref(), bidder_key.as_ref(), &bump_bytes];
        let signer = &[signer_seeds];
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                vault_ai.clone(),
                ctx.accounts.seller.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;

        // Transfer NFT from seller to bidder
        let cpi_accounts = SplTransfer {
            from: ctx.accounts.seller_token.to_account_info(),
            to: ctx.accounts.bidder_token.to_account_info(),
            authority: ctx.accounts.seller.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, 1)?;

        // Close offer account, sending remaining lamports (rent) to bidder (via close constraint)
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(price_lamports: u64)]
pub struct MakeOffer<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    /// Offer is scoped to a collection PDA (unchecked; validated on accept)
    /// CHECK: validated via mint authority relation in accept
    pub collection: UncheckedAccount<'info>,
    /// Zero-data vault PDA that holds the escrow lamports
    /// CHECK: created via CPI; PDA verified in handler
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = bidder,
        space = Offer::SPACE,
        seeds = [b"offer", collection.key().as_ref(), bidder.key().as_ref()],
        bump,
    )]
    pub offer: Account<'info, Offer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    /// CHECK: only used as PDA seed check
    pub collection: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"offer", collection.key().as_ref(), bidder.key().as_ref()],
        bump = offer.bump,
        close = bidder,
        constraint = offer.bidder == bidder.key(),
        constraint = offer.collection == collection.key(),
    )]
    pub offer: Account<'info, Offer>,
    /// Zero-data vault PDA holding escrowed lamports
    /// CHECK: PDA derived in handler
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: only for seeds check with collection program
    pub collection_program: UncheckedAccount<'info>,
    /// CHECK: PDA derived by the collection program ["auth", collection]
    pub collection_authority: UncheckedAccount<'info>,
    /// The collection PDA; used only as a seed reference
    /// CHECK: PDA value carried inside offer
    pub collection: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"offer", collection.key().as_ref(), bidder.key().as_ref()],
        bump = offer.bump,
        // ensure offer targets this collection
        constraint = offer.collection == collection.key(),
        close = bidder,
    )]
    pub offer: Account<'info, Offer>,
    /// Zero-data vault PDA holding escrowed lamports
    /// CHECK: PDA verified in handler; emptied during accept
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: rent recipient on close; must match offer.bidder
    #[account(mut, constraint = bidder.key() == offer.bidder)]
    pub bidder: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    /// Metaplex metadata account for the mint
    /// CHECK: PDA verified in handler
    pub metadata: UncheckedAccount<'info>,
    /// Registry that declares which update authority is allowed for the collection
    #[account(
        init_if_needed,
        payer = seller,
        space = Registry::SPACE,
        seeds = [b"registry", collection.key().as_ref()],
        bump,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        constraint = seller_token.mint == mint.key(),
        constraint = seller_token.owner == seller.key(),
    )]
    pub seller_token: Account<'info, TokenAccount>,
    /// Token account of the bidder (created if needed)
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = bidder,
    )]
    pub bidder_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Offer {
    pub collection: Pubkey,
    pub bidder: Pubkey,
    pub price: u64,
    pub bump: u8,
}
impl Offer { pub const SPACE: usize = 8 + 32 + 32 + 8 + 1; }

#[account]
pub struct Registry {
    pub collection: Pubkey,
    pub owner: Pubkey,
    pub bump: u8,
}
impl Registry { pub const SPACE: usize = 8 + 32 + 32 + 1; }

#[error_code]
pub enum OfferError {
    #[msg("invalid price")] InvalidPrice,
    #[msg("escrow underfunded")] EscrowUnderfunded,
    #[msg("mint not from this collection")] MintNotFromCollection,
    #[msg("invalid collection authority")] InvalidCollectionAuthority,
    #[msg("invalid metadata pda")] InvalidMetadataPda,
    #[msg("invalid vault pda")] InvalidVaultPda,
}

#[derive(Accounts)]
pub struct ConfigureCollection<'info> {
    /// Admin configuring the registry; typically the collection owner wallet
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: PDA for the collection (from your collection program)
    pub collection: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = Registry::SPACE,
        seeds = [b"registry", collection.key().as_ref()],
        bump,
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}
