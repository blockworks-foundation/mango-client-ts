import BN from 'bn.js';
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { Order } from '@project-serum/serum/lib/market';
import { encodeMangoInstruction, NUM_TOKENS } from './layout';
import { TOKEN_PROGRAM_ID } from '@project-serum/serum/lib/token-instructions';
import { uiToNative } from './utils';

// export function makeInitMangoGroupInstruction(
//   programId: PublicKey,
//   mangoGroupPk: PublicKey,
//   signerKey: PublicKey,
//   dexProgramId: PublicKey,
//   srmVaultPk: PublicKey,
//   mintPks: PublicKey[],
//   vaultPks: PublicKey[],
//   spotMarketPks: PublicKey[],
//   oraclePks: PublicKey[],
//   signerNonce: BN,
//   maintCollRatio: number,
//   initCollRatio: number
// ): TransactionInstruction {
//
//   new BN()
//   const keys = [
//     { isSigner: false, isWritable: true, pubkey: mangoGroupPk},
//     { isSigner: true, isWritable: false,  pubkey: ownerPk },
//     { isSigner: false,  isWritable: true, pubkey: marginAccountPk },
//     { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
//     { isSigner: false, isWritable: false, pubkey: dexProgramId },
//     { isSigner: false, isWritable: true, pubkey: spotMarketPk },
//     { isSigner: false, isWritable: true, pubkey: bidsPk },
//     { isSigner: false, isWritable: true, pubkey: asksPk },
//     { isSigner: false, isWritable: true, pubkey: openOrdersPk },
//     { isSigner: false, isWritable: false, pubkey: signerKey },
//     { isSigner: false, isWritable: true, pubkey: eventQueuePk },
//   ]
//
//
// }

export function makeCancelOrderInstruction(
  programId: PublicKey,
  mangoGroupPk: PublicKey,
  ownerPk: PublicKey,
  marginAccountPk: PublicKey,
  dexProgramId: PublicKey,
  spotMarketPk: PublicKey,
  bidsPk: PublicKey,
  asksPk: PublicKey,
  openOrdersPk: PublicKey,
  signerKey: PublicKey,
  eventQueuePk: PublicKey,
  order: Order,
): TransactionInstruction {
  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroupPk },
    { isSigner: true, isWritable: false, pubkey: ownerPk },
    { isSigner: false, isWritable: true, pubkey: marginAccountPk },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    { isSigner: false, isWritable: false, pubkey: dexProgramId },
    { isSigner: false, isWritable: true, pubkey: spotMarketPk },
    { isSigner: false, isWritable: true, pubkey: bidsPk },
    { isSigner: false, isWritable: true, pubkey: asksPk },
    { isSigner: false, isWritable: true, pubkey: openOrdersPk },
    { isSigner: false, isWritable: false, pubkey: signerKey },
    { isSigner: false, isWritable: true, pubkey: eventQueuePk },
  ];

  const data = encodeMangoInstruction({
    CancelOrder: {
      side: order.side,
      orderId: order.orderId,
    },
  });
  return new TransactionInstruction({ keys, data, programId });
}

export function makeSettleFundsInstruction(
  programId: PublicKey,
  mangoGroupPk: PublicKey,
  ownerPk: PublicKey,
  marginAccountPk: PublicKey,
  dexProgramId: PublicKey,
  spotMarketPk: PublicKey,
  openOrdersPk: PublicKey,
  signerKey: PublicKey,
  spotMarketBaseVaultPk: PublicKey,
  spotMarketQuoteVaultPk: PublicKey,
  mangoBaseVaultPk: PublicKey,
  mangoQuoteVaultPk: PublicKey,
  dexSignerKey: PublicKey,
): TransactionInstruction {
  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroupPk },
    { isSigner: true, isWritable: false, pubkey: ownerPk },
    { isSigner: false, isWritable: true, pubkey: marginAccountPk },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    { isSigner: false, isWritable: false, pubkey: dexProgramId },
    { isSigner: false, isWritable: true, pubkey: spotMarketPk },
    { isSigner: false, isWritable: true, pubkey: openOrdersPk },
    { isSigner: false, isWritable: false, pubkey: signerKey },
    { isSigner: false, isWritable: true, pubkey: spotMarketBaseVaultPk },
    { isSigner: false, isWritable: true, pubkey: spotMarketQuoteVaultPk },
    { isSigner: false, isWritable: true, pubkey: mangoBaseVaultPk },
    { isSigner: false, isWritable: true, pubkey: mangoQuoteVaultPk },
    { isSigner: false, isWritable: false, pubkey: dexSignerKey },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
  ];
  const data = encodeMangoInstruction({ SettleFunds: {} });

  return new TransactionInstruction({ keys, data, programId });
}

export function makeSettleBorrowInstruction(
  programId: PublicKey,
  mangoGroupPk: PublicKey,
  marginAccountPk: PublicKey,
  walletPk: PublicKey,
  tokenIndex: number,
  nativeQuantity: BN,
): TransactionInstruction {
  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroupPk },
    { isSigner: false, isWritable: true, pubkey: marginAccountPk },
    { isSigner: true, isWritable: false, pubkey: walletPk },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
  ];
  const data = encodeMangoInstruction({
    SettleBorrow: { tokenIndex: new BN(tokenIndex), quantity: nativeQuantity },
  });
  return new TransactionInstruction({ keys, data, programId });
}

export function makeForceCancelOrdersInstruction(
  programId: PublicKey,
  mangoGroup: PublicKey,
  liqor: PublicKey,
  liqeeMarginAccount: PublicKey,
  baseVault: PublicKey,
  quoteVault: PublicKey,
  spotMarket: PublicKey,
  bids: PublicKey,
  asks: PublicKey,
  signerKey: PublicKey,
  dexEventQueue: PublicKey,
  dexBaseVault: PublicKey,
  dexQuoteVault: PublicKey,
  dexSigner: PublicKey,
  dexProgramId: PublicKey,
  openOrders: PublicKey[],
  oracles: PublicKey[]
): TransactionInstruction {

  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup},
    { isSigner: true, isWritable: false, pubkey: liqor },
    { isSigner: false,  isWritable: true, pubkey: liqeeMarginAccount },
    { isSigner: false,  isWritable: true, pubkey: baseVault },
    { isSigner: false,  isWritable: true, pubkey: quoteVault },
    { isSigner: false,  isWritable: true, pubkey: spotMarket },
    { isSigner: false,  isWritable: true, pubkey: bids },
    { isSigner: false,  isWritable: true, pubkey: asks },
    { isSigner: false,  isWritable: false, pubkey: signerKey },
    { isSigner: false,  isWritable: true, pubkey: dexEventQueue },
    { isSigner: false, isWritable: true, pubkey: dexBaseVault },
    { isSigner: false, isWritable: true, pubkey: dexQuoteVault },
    { isSigner: false, isWritable: false, pubkey: dexSigner },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: dexProgramId },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    ...openOrders.map( (pubkey) => ( { isSigner: false, isWritable: true, pubkey })),
    ...oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
  ]

  const data = encodeMangoInstruction({ForceCancelOrders: {}})
  return new TransactionInstruction( { keys, data, programId })
}

export function makePartialLiquidateInstruction(
  programId: PublicKey,
  mangoGroup: PublicKey,
  liqor: PublicKey,
  liqorInTokenWallet: PublicKey,
  liqorOutTokenWallet: PublicKey,
  liqeeMarginAccount: PublicKey,
  inTokenVault: PublicKey,
  outTokenVault: PublicKey,
  signerKey: PublicKey,
  openOrders: PublicKey[],
  oracles: PublicKey[],
  maxDeposit: BN
): TransactionInstruction {
  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup },
    { isSigner: true, isWritable: false, pubkey: liqor },
    { isSigner: false, isWritable: true, pubkey: liqorInTokenWallet },
    { isSigner: false, isWritable: true, pubkey: liqorOutTokenWallet },
    { isSigner: false,  isWritable: true, pubkey: liqeeMarginAccount },
    { isSigner: false, isWritable: true, pubkey: inTokenVault },
    { isSigner: false, isWritable: true, pubkey: outTokenVault },
    { isSigner: false, isWritable: false, pubkey: signerKey },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    ...openOrders.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
    ...oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
  ]
  const data = encodeMangoInstruction({PartialLiquidate: { maxDeposit }})

  return new TransactionInstruction( { keys, data, programId })
}