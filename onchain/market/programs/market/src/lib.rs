use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("MARKET111111111111111111111111111111111111");

#[program]
pub mod market {
    use super::*;

    pub fn list(ctx: Context<List>, price: u64, payment_mint: Pubkey) -> Result<()> {
        let listing = &mut ctx.accounts.listing;
        listing.seller = ctx.accounts.seller.key();
        listing.mint = ctx.accounts.mint.key();
        listing.price = price;
        listing.bump = ctx.bumps.listing;
        listing.payment_mint = payment_mint; // Pubkey::default() (all zeros) means SOL

        // Transfer NFT into escrow (listing-owned ATA)
        let cpi_accounts = Transfer {
            from: ctx.accounts.seller_token.to_account_info(),
            to: ctx.accounts.escrow_token.to_account_info(),
            authority: ctx.accounts.seller.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, 1)?;
        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        // Transfer NFT back to seller
        let mint_key = ctx.accounts.mint.key();
        let bump = [ctx.accounts.listing.bump];
        let seeds: [&[u8]; 3] = [b"listing".as_ref(), mint_key.as_ref(), bump.as_ref()];
        let signer = &[&seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token.to_account_info(),
            to: ctx.accounts.seller_token.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer);
        token::transfer(cpi_ctx, 1)?;

        // Close escrow token account (rent to seller)
        let close_acc = CloseAccount {
            account: ctx.accounts.escrow_token.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), close_acc, signer);
        token::close_account(close_ctx)?;

        Ok(())
    }

    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        let price = ctx.accounts.listing.price;
        // Only allow SOL path when payment_mint is default (all zeros)
        require!(ctx.accounts.listing.payment_mint == Pubkey::default(), MarketError::WrongCurrency);

        // Transfer SOL from buyer to seller
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.buyer.key(),
            &ctx.accounts.seller.key(),
            price,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[ctx.accounts.buyer.to_account_info(), ctx.accounts.seller.to_account_info(), ctx.accounts.system_program.to_account_info()],
        )?;

        // Transfer NFT from escrow to buyer
        let mint_key = ctx.accounts.mint.key();
        let bump = [ctx.accounts.listing.bump];
        let seeds: [&[u8]; 3] = [b"listing".as_ref(), mint_key.as_ref(), bump.as_ref()];
        let signer = &[&seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token.to_account_info(),
            to: ctx.accounts.buyer_token.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer);
        token::transfer(cpi_ctx, 1)?;

        // Close escrow token account (rent to seller) and let seller keep rent
        let close_acc = CloseAccount {
            account: ctx.accounts.escrow_token.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), close_acc, signer);
        token::close_account(close_ctx)?;

        Ok(())
    }

    // SPL-token settlement path (e.g., CARV). Transfers `listing.price` base units of
    // `payment_mint` from buyer -> seller, then moves the NFT from escrow to buyer.
    pub fn buy_spl(ctx: Context<BuySpl>) -> Result<()> {
        // Validate currency matches listing
        require!(ctx.accounts.listing.payment_mint == ctx.accounts.payment_mint.key(), MarketError::WrongCurrency);

        // Transfer SPL payment from buyer to seller (amount stored in `price` field)
        let pay_accounts = Transfer {
            from: ctx.accounts.buyer_payment_token.to_account_info(),
            to: ctx.accounts.seller_payment_token.to_account_info(),
            authority: ctx.accounts.buyer.to_account_info(),
        };
        let pay_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), pay_accounts);
        token::transfer(pay_ctx, ctx.accounts.listing.price)?;

        // Transfer NFT from escrow to buyer
        let mint_key = ctx.accounts.mint.key();
        let bump = [ctx.accounts.listing.bump];
        let seeds: [&[u8]; 3] = [b"listing".as_ref(), mint_key.as_ref(), bump.as_ref()];
        let signer = &[&seeds[..]];
        let nft_accounts = Transfer {
            from: ctx.accounts.escrow_token.to_account_info(),
            to: ctx.accounts.buyer_token.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        };
        let nft_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), nft_accounts, signer);
        token::transfer(nft_ctx, 1)?;

        // Close escrow token account (rent to seller)
        let close_acc = CloseAccount {
            account: ctx.accounts.escrow_token.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), close_acc, signer);
        token::close_account(close_ctx)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct List<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = seller_token.mint == mint.key(),
        constraint = seller_token.owner == seller.key(),
    )]
    pub seller_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = seller,
        seeds = [b"listing", mint.key().as_ref()],
        bump,
        // Discriminator + seller + mint + price + bump + payment_mint
        space = 8 + 32 + 32 + 8 + 1 + 32,
    )]
    pub listing: Account<'info, Listing>,
    /// Escrow ATA owned by the listing PDA
    #[account(
        init,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = listing,
    )]
    pub escrow_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"listing", mint.key().as_ref()],
        bump = listing.bump,
        constraint = listing.seller == seller.key(),
        close = seller,
    )]
    pub listing: Account<'info, Listing>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = listing,
    )]
    pub escrow_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
    )]
    pub seller_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: paid via system transfer
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"listing", mint.key().as_ref()],
        bump = listing.bump,
        constraint = listing.seller == seller.key(),
        close = seller,
    )]
    pub listing: Account<'info, Listing>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = listing,
    )]
    pub escrow_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuySpl<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: paid via token transfer
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"listing", mint.key().as_ref()],
        bump = listing.bump,
        constraint = listing.seller == seller.key(),
        close = seller,
    )]
    pub listing: Account<'info, Listing>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = listing,
    )]
    pub escrow_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    // Payment mint and token accounts
    pub payment_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = payment_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_payment_token: Account<'info, TokenAccount>,
    #[account(
        associated_token::mint = payment_mint,
        associated_token::authority = seller,
    )]
    pub seller_payment_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Listing {
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub bump: u8,
    pub payment_mint: Pubkey, // Pubkey::default() means SOL
}

#[error_code]
pub enum MarketError {
    #[msg("wrong currency for this listing")] WrongCurrency,
}
