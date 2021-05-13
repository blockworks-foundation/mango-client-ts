import {
  Account,
  AccountInfo, Commitment,
  Connection,
  PublicKey, RpcResponseAndContext, SimulatedTransactionResponse,
  SystemProgram, Transaction, TransactionConfirmationStatus,
  TransactionInstruction,
  TransactionSignature,
} from '@solana/web3.js';
import BN from 'bn.js';
import { WRAPPED_SOL_MINT } from '@project-serum/serum/lib/token-instructions';
import { bits, blob, struct, u8, u32, nu64 } from 'buffer-layout';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AccountLayout } from './layout';

import {
  accountFlagsLayout,
  publicKeyLayout,
  u128,
  u64,
  zeros,
} from '@project-serum/serum/lib/layout';

export const zeroKey = new PublicKey(new Uint8Array(32))

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  commitment: Commitment,
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  // @ts-ignore
  transaction.recentBlockhash = await connection._recentBlockhash(
    // @ts-ignore
    connection._disableBlockhashCaching,
  );

  const signData = transaction.serializeMessage();
  // @ts-ignore
  const wireTransaction = transaction._serialize(signData);
  const encodedTransaction = wireTransaction.toString('base64');
  const config: any = { encoding: 'base64', commitment };
  const args = [encodedTransaction, config];

  // @ts-ignore
  const res = await connection._rpcRequest('simulateTransaction', args);
  if (res.error) {
    throw new Error('failed to simulate transaction: ' + res.error.message);
  }
  return res.result;
}

export async function awaitTransactionSignatureConfirmation(
  txid: TransactionSignature,
  timeout: number,
  connection: Connection,
  confirmLevel: TransactionConfirmationStatus
) {
  let done = false;

  const confirmLevels: (TransactionConfirmationStatus | null)[] = ['finalized']
  if (confirmLevel === 'confirmed') {
    confirmLevels.push('confirmed')
  } else if (confirmLevel === 'processed') {
    confirmLevels.push('confirmed')
    confirmLevels.push('processed')
  }

  const result = await new Promise((resolve, reject) => {
    (async () => {
      setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        console.log('Timed out for txid', txid);
        reject({ timeout: true });
      }, timeout);
      try {
        connection.onSignature(
          txid,
          (result) => {
            // console.log('WS confirmed', txid, result);
            done = true;
            if (result.err) {
              reject(result.err);
            } else {
              resolve(result);
            }
          },
          'singleGossip',
        );
        // console.log('Set up WS connection', txid);
      } catch (e) {
        done = true;
        console.log('WS error in setup', txid, e);
      }
      while (!done) {
        // eslint-disable-next-line no-loop-func
        (async () => {
          try {
            const signatureStatuses = await connection.getSignatureStatuses([
              txid,
            ]);
            const result = signatureStatuses && signatureStatuses.value[0];
            if (!done) {
              if (!result) {
                // console.log('REST null result for', txid, result);
              } else if (result.err) {
                console.log('REST error for', txid, result);
                done = true;
                reject(result.err);
              } else if (!(result.confirmations || confirmLevels.includes(result.confirmationStatus))) {
                console.log('REST not confirmed', txid, result);
              } else {
                console.log('REST confirmed', txid, result);
                done = true;
                resolve(result);
              }
            }
          } catch (e) {
            if (!done) {
              console.log('REST connection error: txid', txid, e);
            }
          }
        })();
        await sleep(300);
      }
    })();
  });
  done = true;
  return result;
}


export async function createAccountInstruction(
  connection: Connection,
  payer: PublicKey,
  space: number,
  owner: PublicKey,
  lamports?: number
): Promise<{ account: Account, instruction: TransactionInstruction }> {
  const account = new Account();
  const instruction = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: account.publicKey,
    lamports: lamports ? lamports : await connection.getMinimumBalanceForRentExemption(space),
    space,
    programId: owner
  })

  return { account, instruction };
}


const MINT_LAYOUT = struct([blob(44), u8('decimals'), blob(37)]);

export async function getMintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number> {
  if (mint.equals(WRAPPED_SOL_MINT)) {
    return 9;
  }
  const { data } = throwIfNull(
    await connection.getAccountInfo(mint),
    'mint not found',
  );
  const { decimals } = MINT_LAYOUT.decode(data);
  return decimals;
}

function throwIfNull<T>(value: T | null, message = 'account not found'): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}


export function uiToNative(amount: number, decimals: number): BN {
  return new BN(Math.round(amount * Math.pow(10, decimals)))
}

export function nativeToUi(amount: number, decimals: number): number {
  return amount / Math.pow(10, decimals)
}


export async function getFilteredProgramAccounts(
  connection: Connection,
  programId: PublicKey,
  filters,
): Promise<{ publicKey: PublicKey; accountInfo: AccountInfo<Buffer> }[]> {
  // @ts-ignore
  const resp = await connection._rpcRequest('getProgramAccounts', [
    programId.toBase58(),
    {
      commitment: connection.commitment,
      filters,
      encoding: 'base64',
    },
  ]);
  if (resp.error) {
    throw new Error(resp.error.message);
  }
  return resp.result.map(
    ({ pubkey, account: { data, executable, owner, lamports } }) => ({
      publicKey: new PublicKey(pubkey),
      accountInfo: {
        data: Buffer.from(data[0], 'base64'),
        executable,
        owner: new PublicKey(owner),
        lamports,
      },
    }),
  );
}

export async function promiseUndef(): Promise<undefined> {
  return undefined
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
}


export const ACCOUNT_LAYOUT = struct([
  blob(32, 'mint'),
  blob(32, 'owner'),
  nu64('amount'),
  blob(93)
]);

export function parseTokenAccountData(
  data: Buffer,
): { mint: PublicKey; owner: PublicKey; amount: number } {
  let { mint, owner, amount } = ACCOUNT_LAYOUT.decode(data);
  return {
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount,
  };
}

export function parseTokenAccount(
  data: Buffer
): { mint: PublicKey; owner: PublicKey; amount: BN } {

  const decoded = AccountLayout.decode(data)
  return {
    mint: decoded.mint,
    owner: decoded.owner,
    amount: decoded.amount
  }
}

export async function getMultipleAccounts(
  connection: Connection,
  publicKeys: PublicKey[],
  commitment?: Commitment
): Promise<{ publicKey: PublicKey; accountInfo: AccountInfo<Buffer> }[]> {
  const publickKeyStrs = publicKeys.map((pk) => (pk.toBase58()));

  const args = commitment ? [publickKeyStrs, {commitment}] : [publickKeyStrs];
  // @ts-ignore
  const resp = await connection._rpcRequest('getMultipleAccounts', args);
  if (resp.error) {
    throw new Error(resp.error.message);
  }
  return resp.result.value.map(
    ({ data, executable, lamports, owner } , i) => ({
      publicKey: publicKeys[i],
      accountInfo: {
        data: Buffer.from(data[0], 'base64'),
        executable,
        owner: new PublicKey(owner),
        lamports,
      },
    }),
  );
}


export async function findLargestTokenAccountForOwner(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ publicKey: PublicKey; tokenAccount: { mint: PublicKey; owner: PublicKey; amount: number} }> {

  const response = await connection.getTokenAccountsByOwner(owner, {mint, programId: TOKEN_PROGRAM_ID}, connection.commitment)
  let max = -1;
  let maxTokenAccount: null | { mint: PublicKey; owner: PublicKey; amount: number} = null
  let maxPubkey: null | PublicKey = null
  for (const { pubkey, account } of response.value) {

    const tokenAccount = parseTokenAccountData(account.data)
    if (tokenAccount.amount > max) {
      maxTokenAccount = tokenAccount
      max = tokenAccount.amount
      maxPubkey = pubkey
    }
  }

  if (maxPubkey && maxTokenAccount) {
    return {publicKey: maxPubkey, tokenAccount: maxTokenAccount}
  } else {
    throw new Error("No accounts for this token")
  }
}

const EVENT_QUEUE_HEADER = struct([
  blob(5),

  accountFlagsLayout('accountFlags'),
  u32('head'),
  zeros(4),
  u32('count'),
  zeros(4),
  u32('seqNum'),
  zeros(4),
]);

const EVENT_FLAGS = bits(u8(), false, 'eventFlags');
EVENT_FLAGS.addBoolean('fill');
EVENT_FLAGS.addBoolean('out');
EVENT_FLAGS.addBoolean('bid');
EVENT_FLAGS.addBoolean('maker');

const EVENT = struct([
  EVENT_FLAGS,
  u8('openOrdersSlot'),
  u8('feeTier'),
  blob(5),
  u64('nativeQuantityReleased'), // Amount the user received
  u64('nativeQuantityPaid'), // Amount the user paid
  u64('nativeFeeOrRebate'),
  u128('orderId'),
  publicKeyLayout('openOrders'),
  u64('clientOrderId'),
]);


export function decodeRecentEvents(
  buffer: Buffer,
  lastSeenSeqNum?: number,
) {
  const header = EVENT_QUEUE_HEADER.decode(buffer);
  const nodes: any[] = [];

  if (lastSeenSeqNum !== undefined) {
    const allocLen = Math.floor(
      (buffer.length - EVENT_QUEUE_HEADER.span) / EVENT.span,
    );

    const newEventsCount = header.seqNum - lastSeenSeqNum

    for (let i = newEventsCount; i > 0; --i) {
      const nodeIndex = (header.head + header.count + allocLen - i) % allocLen
      const decodedItem = EVENT.decode(buffer, EVENT_QUEUE_HEADER.span + nodeIndex * EVENT.span)
      nodes.push(decodedItem)
    }
  }

  return { header, nodes };
}

