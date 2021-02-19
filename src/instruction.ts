import { PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { Order } from '@project-serum/serum/lib/market';
import { encodeMangoInstruction } from './layout';

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