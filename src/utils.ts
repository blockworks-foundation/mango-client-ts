import {
  Account, Commitment,
  Connection,
  PublicKey, RpcResponseAndContext, SimulatedTransactionResponse,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
} from '@solana/web3.js';
import { publicKeyLayout, u64 } from './layout';
import BN from 'bn.js';
import { WRAPPED_SOL_MINT } from '@project-serum/serum/lib/token-instructions';
import { blob, struct, u8 } from 'buffer-layout';
import {notify} from "./notifications";


export const zeroKey = new PublicKey(new Uint8Array(32))


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

export function getMedian(submissions: number[]): number {
  const values = submissions
    .filter((s: any) => s.value != 0)
    .map((s: any) => s.value)
    .sort((a, b) => a - b)

  const len = values.length
  if (len == 0) {
    return 0
  } else if (len == 1) {
    return values[0]
  } else {
    const i = len / 2
    return len % 2 == 0 ? (values[i] + values[i-1])/2 : values[i]
  }

}

export const AggregatorLayout = struct([
  blob(4, "submitInterval"),
  u64("minSubmissionValue"),
  u64("maxSubmissionValue"),
  u8("submissionDecimals"),
  blob(32, "description"),
  u8("isInitialized"),
  publicKeyLayout('owner'),
  blob(576, "submissions")
]);

export const SubmissionLayout = struct([
  u64("time"),
  u64("value"),
  publicKeyLayout('oracle'),
]);

export function decodeAggregatorInfo(accountInfo) {
  const aggregator = AggregatorLayout.decode(accountInfo.data);
  const minSubmissionValue = aggregator.minSubmissionValue;
  const maxSubmissionValue = aggregator.maxSubmissionValue;
  const submitInterval = aggregator.submitInterval;
  const description = (aggregator.description.toString() as string).trim()

  // decode oracles
  const submissions: any[] = []
  const submissionSpace = SubmissionLayout.span
  let latestUpdateTime = new BN(0);
  const decimalAdj = Math.pow(10, aggregator.submissionDecimals)
  for (let i = 0; i < aggregator.submissions.length / submissionSpace; i++) {
    const submission = SubmissionLayout.decode(
      aggregator.submissions.slice(i*submissionSpace, (i+1)*submissionSpace)
    )

    submission.value = submission.value / decimalAdj;
    if (!submission.oracle.equals(new PublicKey(0))) {
      submissions.push(submission)
    }
    if (submission.time > latestUpdateTime) {
      latestUpdateTime = submission.time
    }
  }

  return {
    minSubmissionValue: minSubmissionValue,
    maxSubmissionValue: maxSubmissionValue,
    submissionValue: getMedian(submissions),
    submitInterval,
    description,
    oracles: submissions.map(s => s.oracle.toString()),
    latestUpdateTime: new Date(Number(latestUpdateTime)*1000),
  }
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


const DEFAULT_TIMEOUT = 15000;

export async function sendTransaction({
                                        transaction,
                                        wallet,
                                        signers = [],
                                        connection,
                                        sendingMessage = 'Sending transaction...',
                                        sentMessage = 'Transaction sent',
                                        successMessage = 'Transaction confirmed',
                                        timeout = DEFAULT_TIMEOUT,
                                      }: {
  transaction: Transaction;
  wallet: any;
  signers?: Array<Account>;
  connection: Connection;
  sendingMessage?: string;
  sentMessage?: string;
  successMessage?: string;
  timeout?: number;
}) {
  const signedTransaction = await signTransaction({
    transaction,
    wallet,
    signers,
    connection,
  });
  return await sendSignedTransaction({
    signedTransaction,
    connection,
    sendingMessage,
    sentMessage,
    successMessage,
    timeout,
  });
}

export async function signTransaction({
                                        transaction,
                                        wallet,
                                        signers = [],
                                        connection,
                                      }: {
  transaction: Transaction;
  wallet: any;
  signers?: Array<Account>;
  connection: Connection;
}) {
  transaction.recentBlockhash = (
    await connection.getRecentBlockhash('max')
  ).blockhash;
  transaction.setSigners(wallet.publicKey, ...signers.map((s) => s.publicKey));
  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }
  return await wallet.signTransaction(transaction);
}

export async function signTransactions({
                                         transactionsAndSigners,
                                         wallet,
                                         connection,
                                       }: {
  transactionsAndSigners: {
    transaction: Transaction;
    signers?: Array<Account>;
  }[];
  wallet: any;
  connection: Connection;
}) {
  const blockhash = (await connection.getRecentBlockhash('max')).blockhash;
  transactionsAndSigners.forEach(({ transaction, signers = [] }) => {
    transaction.recentBlockhash = blockhash;
    transaction.setSigners(
      wallet.publicKey,
      ...signers.map((s) => s.publicKey),
    );
    if (signers?.length > 0) {
      transaction.partialSign(...signers);
    }
  });
  return await wallet.signAllTransactions(
    transactionsAndSigners.map(({ transaction }) => transaction),
  );
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

export async function sendSignedTransaction({
                                              signedTransaction,
                                              connection,
                                              sendingMessage = 'Sending transaction...',
                                              sentMessage = 'Transaction sent',
                                              successMessage = 'Transaction confirmed',
                                              timeout = DEFAULT_TIMEOUT,
                                            }: {
  signedTransaction: Transaction;
  connection: Connection;
  sendingMessage?: string;
  sentMessage?: string;
  successMessage?: string;
  timeout?: number;
}): Promise<string> {
  const rawTransaction = signedTransaction.serialize();
  const startTime = getUnixTs();
  notify({ message: sendingMessage });
  const txid: TransactionSignature = await connection.sendRawTransaction(
    rawTransaction,
    {
      skipPreflight: true,
    },
  );
  notify({ message: sentMessage, type: 'success', txid });

  console.log('Started awaiting confirmation for', txid);

  let done = false;
  (async () => {
    while (!done && getUnixTs() - startTime < timeout) {
      connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      });
      await sleep(300);
    }
  })();
  try {
    await awaitTransactionSignatureConfirmation(txid, timeout, connection);
  } catch (err) {
    if (err.timeout) {
      throw new Error('Timed out awaiting confirmation on transaction');
    }
    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (
        await simulateTransaction(connection, signedTransaction, 'single')
      ).value;
    } catch (e) {}
    if (simulateResult && simulateResult.err) {
      if (simulateResult.logs) {
        for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
          const line = simulateResult.logs[i];
          if (line.startsWith('Program log: ')) {
            throw new Error(
              'Transaction failed: ' + line.slice('Program log: '.length),
            );
          }
        }
      }
      throw new Error(JSON.stringify(simulateResult.err));
    }
    throw new Error('Transaction failed');
  } finally {
    done = true;
  }
  notify({ message: successMessage, type: 'success', txid });

  console.log('Latency', txid, getUnixTs() - startTime);
  return txid;
}

async function awaitTransactionSignatureConfirmation(
  txid: TransactionSignature,
  timeout: number,
  connection: Connection,
) {
  let done = false;
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
            console.log('WS confirmed', txid, result);
            done = true;
            if (result.err) {
              reject(result.err);
            } else {
              resolve(result);
            }
          },
          'recent',
        );
        console.log('Set up WS connection', txid);
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
                console.log('REST null result for', txid, result);
              } else if (result.err) {
                console.log('REST error for', txid, result);
                done = true;
                reject(result.err);
              } else if (!result.confirmations) {
                console.log('REST no confirmations for', txid, result);
              } else {
                console.log('REST confirmation for', txid, result);
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

function mergeTransactions(transactions: (Transaction | undefined)[]) {
  const transaction = new Transaction();
  transactions
    .filter((t): t is Transaction => t !== undefined)
    .forEach((t) => {
      transaction.add(t);
    });
  return transaction;
}


export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/** Copy of Connection.simulateTransaction that takes a commitment parameter. */
async function simulateTransaction(
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
