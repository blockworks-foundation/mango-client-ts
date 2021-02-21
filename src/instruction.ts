import { PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { Order } from '@project-serum/serum/lib/market';
import { encodeMangoInstruction } from './layout';
import { TOKEN_PROGRAM_ID } from '@project-serum/serum/lib/token-instructions';
import BN from 'bn.js';

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
  order: Order
): TransactionInstruction {
  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroupPk},
    { isSigner: true, isWritable: false,  pubkey: ownerPk },
    { isSigner: false,  isWritable: true, pubkey: marginAccountPk },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    { isSigner: false, isWritable: false, pubkey: dexProgramId },
    { isSigner: false, isWritable: true, pubkey: spotMarketPk },
    { isSigner: false, isWritable: true, pubkey: bidsPk },
    { isSigner: false, isWritable: true, pubkey: asksPk },
    { isSigner: false, isWritable: true, pubkey: openOrdersPk },
    { isSigner: false, isWritable: false, pubkey: signerKey },
    { isSigner: false, isWritable: true, pubkey: eventQueuePk },
  ]

  const data = encodeMangoInstruction({
    CancelOrder: {
      side: order.side,
      orderId: order.orderId,
    }
  })
  return  new TransactionInstruction( { keys, data, programId })
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
    { isSigner: false, isWritable: true, pubkey: mangoGroupPk},
    { isSigner: true, isWritable: false,  pubkey: ownerPk },
    { isSigner: false,  isWritable: true, pubkey: marginAccountPk },
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
  ]
  const data = encodeMangoInstruction( {SettleFunds: {}} )

  return new TransactionInstruction( { keys, data, programId })
}