use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, InitializeMint2, MintTo};
use mpl_token_metadata::instructions as mpl_ix;
use mpl_token_metadata::ID as TOKEN_METADATA_ID;
use mpl_token_metadata::types::DataV2;

declare_id!("COLLECT11111111111111111111111111111111111");

#[program]
pub mod collection {
    use super::*;

    pub fn init_collection(
        ctx: Context<InitCollection>,
        name: String,
        symbol: String,
        metadata_uri: String,
        price_lamports: u64,
        supply: u32,
    ) -> Result<()> {
        require!(symbol.len() >= 2 && symbol.len() <= 10, ErrorCode::InvalidSymbol);
        require!(supply >= 1 && supply <= 100_000, ErrorCode::InvalidSupply);
        require!(name.len() <= 32, ErrorCode::NameTooLong);
        require!(metadata_uri.len() <= 200, ErrorCode::UriTooLong);

        let c = &mut ctx.accounts.collection;
        c.bump = ctx.bumps.collection;
        c.owner = ctx.accounts.owner.key();
        c.name = name;
        c.symbol = symbol;
        c.metadata_uri = metadata_uri;
        c.price_lamports = price_lamports;
        c.supply = supply;
        c.minted = 0;

        emit!(CollectionCreated { owner: c.owner, pda: c.key(), symbol: c.symbol.clone() });
        Ok(())
    }

    // Mints a 1/1 NFT to `recipient` enforcing collection config.
    // - Creates a PDA mint and ATA
    // - Creates Metadata + MasterEdition with PDA as temp update authority
    // - Immediately transfers update authority to `collection.owner`
    // - Optionally locks metadata (is_mutable = false)
    pub fn mint(
        ctx: Context<MintNft>,
        nonce: u64,
        lock_metadata: bool,
    ) -> Result<()> {
        let collection = &mut ctx.accounts.collection;

        // Enforce supply
        require!(collection.minted < collection.supply, ErrorCode::SoldOut);

        // Enforce payment if price set
        if collection.price_lamports > 0 {
            let ix = system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &collection.owner,
                collection.price_lamports,
            );
            anchor_lang::solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.owner.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Create mint PDA account
        let coll_key = collection.key();
        let nonce_le = nonce.to_le_bytes();
        let mint_seed_slices: [&[u8]; 3] = [b"mint", coll_key.as_ref(), &nonce_le];
        let (mint_pda, mint_bump) = Pubkey::find_program_address(&mint_seed_slices, ctx.program_id);
        require_keys_eq!(mint_pda, ctx.accounts.mint.key(), ErrorCode::MintSeedMismatch);
        let rent_lamports = Rent::get()?.minimum_balance(Mint::LEN);
        let mint_bump_bytes = [mint_bump];
        let mint_signer_seeds: &[&[u8]] = &[b"mint", coll_key.as_ref(), &nonce_le, &mint_bump_bytes];
        let mint_signer: &[&[&[u8]]] = &[mint_signer_seeds];
        invoke_signed(
            &system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &mint_pda,
                rent_lamports,
                Mint::LEN as u64,
                &token::ID,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            mint_signer,
        )?;

        // Initialize mint with PDA authority and 0 decimals
        let auth_seed_slices: [&[u8]; 2] = [b"auth", coll_key.as_ref()];
        let (auth_pda, auth_bump) = Pubkey::find_program_address(&auth_seed_slices, ctx.program_id);
        require_keys_eq!(auth_pda, ctx.accounts.authority.key(), ErrorCode::AuthSeedMismatch);
        // Initialize mint with PDA as both mint and freeze authority to avoid
        // downstream SetAuthority failures when Metaplex updates authorities.
        let init_ix = anchor_spl::token::spl_token::instruction::initialize_mint2(
            &token::ID,
            &mint_pda,
            &auth_pda,
            Some(&auth_pda),
            0,
        )?;
        let auth_bump_bytes = [auth_bump];
        let auth_signer_seeds: &[&[u8]] = &[b"auth", coll_key.as_ref(), &auth_bump_bytes];
        let auth_signer: &[&[&[u8]]] = &[auth_signer_seeds];
        invoke_signed(
            &init_ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            auth_signer,
        )?;

        // Create recipient ATA if needed (CPI to Associated Token Program)
        let ata_accounts = anchor_spl::associated_token::Create {
            payer: ctx.accounts.payer.to_account_info(),
            associated_token: ctx.accounts.recipient_token.to_account_info(),
            authority: ctx.accounts.recipient.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        let ata_ctx = CpiContext::new(ctx.accounts.associated_token_program.to_account_info(), ata_accounts);
        anchor_spl::associated_token::create(ata_ctx)?;

        // Mint 1 token to recipient
        let mint_to_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.recipient_token.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_to_accounts,
            auth_signer,
        );
        token::mint_to(mint_to_ctx, 1)?;

        // Derive Metaplex PDAs
        let metadata_seeds = &[
            b"metadata",
            TOKEN_METADATA_ID.as_ref(),
            mint_pda.as_ref(),
        ];
        let (metadata_pda, _mb) = Pubkey::find_program_address(metadata_seeds, &TOKEN_METADATA_ID);
        require_keys_eq!(metadata_pda, ctx.accounts.metadata.key(), ErrorCode::MetadataSeedMismatch);
        let edition_seeds = &[
            b"metadata",
            TOKEN_METADATA_ID.as_ref(),
            mint_pda.as_ref(),
            b"edition",
        ];
        let (edition_pda, _eb) = Pubkey::find_program_address(edition_seeds, &TOKEN_METADATA_ID);
        require_keys_eq!(edition_pda, ctx.accounts.master_edition.key(), ErrorCode::EditionSeedMismatch);

        // Create Metadata (update authority = PDA authority)
        let create_meta_ix = mpl_ix::CreateMetadataAccountV3 {
            metadata: metadata_pda,
            mint: mint_pda,
            mint_authority: auth_pda,
            payer: ctx.accounts.payer.key(),
            update_authority: (auth_pda, true),
            system_program: anchor_lang::solana_program::system_program::ID,
            rent: None,
        }
        .instruction(mpl_ix::CreateMetadataAccountV3InstructionArgs {
            data: DataV2 {
                name: collection.name.clone(),
                symbol: collection.symbol.clone(),
                uri: collection.metadata_uri.clone(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            is_mutable: true,
            collection_details: None,
        });
        invoke_signed(
            &create_meta_ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.token_metadata_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            auth_signer,
        )?;

        // Create Master Edition (authority = PDA)
        let create_me_ix = mpl_ix::CreateMasterEditionV3 {
            edition: edition_pda,
            mint: mint_pda,
            update_authority: auth_pda,
            mint_authority: auth_pda,
            metadata: metadata_pda,
            payer: ctx.accounts.payer.key(),
            system_program: anchor_lang::solana_program::system_program::ID,
            rent: None,
            token_program: token::ID,
        }
        .instruction(mpl_ix::CreateMasterEditionV3InstructionArgs { max_supply: Some(0) });
        invoke_signed(
            &create_me_ix,
            &[
                ctx.accounts.master_edition.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.token_metadata_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            auth_signer,
        )?;

        // Update metadata: hand over authority to collection.owner and optionally lock
        let update_ix = mpl_ix::UpdateMetadataAccountV2 {
            metadata: metadata_pda,
            update_authority: auth_pda,
        }
        .instruction(mpl_ix::UpdateMetadataAccountV2InstructionArgs {
            data: None,
            new_update_authority: Some(collection.owner),
            primary_sale_happened: None,
            is_mutable: Some(!lock_metadata),
        });
        invoke_signed(
            &update_ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.token_metadata_program.to_account_info(),
            ],
            auth_signer,
        )?;

        collection.minted = collection.minted.checked_add(1).ok_or(ErrorCode::Overflow)?;
        emit!(Minted { mint: mint_pda, recipient: ctx.accounts.recipient.key() });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(name: String, symbol: String, metadata_uri: String, price_lamports: u64, supply: u32)]
pub struct InitCollection<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Deployer / ultimate update authority
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Collection::SPACE,
        // derive PDA using owner and the provided symbol
        seeds = [b"collection", owner.key().as_ref(), symbol_hash(&symbol).as_ref()],
        bump,
    )]
    pub collection: Account<'info, Collection>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Collection {
    pub bump: u8,
    pub owner: Pubkey,
    pub price_lamports: u64,
    pub supply: u32,
    pub minted: u32,
    pub name: String,        // max 32 bytes
    pub symbol: String,      // max 10 bytes
    pub metadata_uri: String // max 200 bytes
}

impl Collection {
    // 8 (discriminator) + 1 + 32 + 8 + 4 + 4 + (4+32) + (4+10) + (4+200)
    pub const SPACE: usize = 8 + 1 + 32 + 8 + 4 + 4 + (4+32) + (4+10) + (4+200);
}

#[event]
pub struct CollectionCreated {
    pub owner: Pubkey,
    pub pda: Pubkey,
    pub symbol: String,
}


fn symbol_hash(sym: &String) -> [u8; 32] {
    let h = hash(sym.as_bytes());
    h.to_bytes()
}

#[error_code]
pub enum ErrorCode {
    #[msg("Symbol must be 2-10 chars")] InvalidSymbol,
    #[msg("Supply out of range")] InvalidSupply,
    #[msg("Name too long")] NameTooLong,
    #[msg("URI too long")] UriTooLong,
    #[msg("Sold out")] SoldOut,
    #[msg("Math overflow")] Overflow,
    #[msg("Mint PDA mismatch")] MintSeedMismatch,
    #[msg("Authority PDA mismatch")] AuthSeedMismatch,
    #[msg("Metadata PDA mismatch")] MetadataSeedMismatch,
    #[msg("Edition PDA mismatch")] EditionSeedMismatch,
}

#[event]
pub struct Minted {
    pub mint: Pubkey,
    pub recipient: Pubkey,
}

#[derive(Accounts)]
pub struct MintNft<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Destination for optional payment; must equal collection.owner
    /// CHECK: paid via system transfer
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// Recipient of the NFT
    /// CHECK: validated via ATA derivation
    pub recipient: UncheckedAccount<'info>,
    #[account(mut, has_one = owner)]
    pub collection: Account<'info, Collection>,
    /// PDA authority used as mint/update authority
    /// CHECK: derived and checked in handler
    pub authority: UncheckedAccount<'info>,
    /// PDA Mint account
    /// CHECK: created in handler and checked
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// Metadata PDA (Metaplex)
    /// CHECK: derived and checked
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// Master Edition PDA (Metaplex)
    /// CHECK: derived and checked
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,
    /// Recipient ATA for the mint
    /// CHECK: created in handler
    #[account(mut)]
    pub recipient_token: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: program id only
    pub token_metadata_program: UncheckedAccount<'info>,
}
