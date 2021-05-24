import { MangoClient, MangoGroup, MarginAccount } from '../src/client';
import { Account, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionSignature, TransferParams } from '@solana/web3.js';
import { Market, TokenInstructions, OpenOrders, Orderbook } from '@project-serum/serum';
import { token } from '@project-serum/common';
import { u64, NATIVE_MINT } from "@solana/spl-token";
import { sleep } from '../src/utils';
import fs from 'fs';
console.log = function () {}; // NOTE: Disable all unnecessary logging

const FAUCET_PROGRAM_ID = new PublicKey(
  "4bXpkKSV8swHSnwqtzuboGPaPDeEgAn4Vt8GfarV5rZt"
);

const getPDA = () => {
  return PublicKey.findProgramAddress([Buffer.from("faucet")], FAUCET_PROGRAM_ID);
}

export async function _sendTransaction (
  connection: Connection,
  transaction: Transaction,
  signers: Account[],
): Promise<TransactionSignature> {
  const signature = await connection.sendTransaction(transaction, signers);
  try {
    await connection.confirmTransaction(signature);
  } catch (e) {
    console.info("Error while confirming, trying again");
    await connection.confirmTransaction(signature);
  }
  return signature;
}

export async function createTokenAccountInstrs (
  connection: Connection,
  newAccountPubkey: PublicKey,
  mint: PublicKey,
  ownerPk: PublicKey,
  lamports?: number,
): Promise<TransactionInstruction[]> {
  if (lamports === undefined) lamports = await connection.getMinimumBalanceForRentExemption(165);
  return [
    SystemProgram.createAccount({
      fromPubkey: ownerPk,
      newAccountPubkey,
      space: 165,
      lamports,
      programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }),
    TokenInstructions.initializeAccount({
      account: newAccountPubkey,
      mint,
      owner: ownerPk,
    }),
  ];
}

export async function createWrappedNativeAccount (
  connection: Connection,
  owner: Account,
  amount: number
): Promise<PublicKey> {
  // Allocate memory for the account
  const balanceNeeded = await connection.getMinimumBalanceForRentExemption(165);
  const newAccount = new Account();
  const tx = new Transaction();
  tx.add(SystemProgram.createAccount({
    fromPubkey: owner.publicKey,
    newAccountPubkey: newAccount.publicKey,
    lamports: balanceNeeded,
    space: 165,
    programId: TokenInstructions.TOKEN_PROGRAM_ID,
  })); // Send lamports to it (these will be wrapped into native tokens by the token program)
  tx.add(SystemProgram.transfer({
    fromPubkey: owner.publicKey,
    toPubkey: newAccount.publicKey,
    lamports: amount
  })); // Assign the new account to the native token mint.
  // the account will be initialized with a balance equal to the native token balance.
  // (i.e. amount)
  tx.add(TokenInstructions.initializeAccount({
    account: newAccount.publicKey,
    mint: NATIVE_MINT,
    owner: owner.publicKey,
  }));
  const signers = [owner, newAccount];
  const signerPks = signers.map(x => x.publicKey);
  tx.setSigners(...signerPks);
  await _sendTransaction(connection, tx, signers);
  return newAccount.publicKey;
}

export async function createTokenAccount (
  connection: Connection,
  mint: PublicKey,
  owner: Account
): Promise<PublicKey> {
  const newAccount = new Account();
  const tx = new Transaction();
  const signers = [owner, newAccount];
  const signerPks = signers.map(x => x.publicKey);
  tx.add(...(await createTokenAccountInstrs(connection, newAccount.publicKey, mint, owner.publicKey)));
  tx.setSigners(...signerPks);
  await _sendTransaction(connection, tx, signers);
  return newAccount.publicKey;
}

export async function createWalletAndRequestAirdrop(
  connection: Connection,
  amount: number
): Promise<Account> {
  console.info("Creating a new wallet");
  const owner = new Account();
  if (amount < 1) throw new Error("SOL is needed for gas fees so at least 1 SOL is required");
  await airdropSol(connection, owner, amount);
  return owner;
}

export async function createMangoGroupSymbolMappings (
  connection: Connection,
  mangoGroupIds: any,
): Promise<any> {
  const mangoGroupTokenMappings = {};
  const mangoGroupSymbols: [string, string][] = Object.entries(mangoGroupIds.symbols);
  for (let [tokenName, tokenMint] of mangoGroupSymbols) {
    const tokenSupply = await connection.getTokenSupply(new PublicKey(tokenMint));
    mangoGroupTokenMappings[tokenMint] = { tokenMint: new PublicKey(tokenMint), tokenName, decimals: tokenSupply.value.decimals };
  }
  return mangoGroupTokenMappings;
}

export async function getOwnedTokenAccounts(
  connection: Connection,
  owner: Account,
): Promise<any[]> {
  const ownedTokenAccounts = await token.getOwnedTokenAccounts(connection, owner.publicKey);
  return ownedTokenAccounts;
}

export async function updateMarginTokenAccountsAndDeposits(
  connection: Connection,
  owner: Account,
  client: MangoClient,
  mangoGroup: MangoGroup,
  marginAccountPk: PublicKey | null,
  state: any,
  dexProgramId: PublicKey,
): Promise<void>{
  state.ownedTokenAccounts = await token.getOwnedTokenAccounts(connection, owner.publicKey);
  state.marginAccount = (marginAccountPk) ? await client.getMarginAccount(connection, marginAccountPk, dexProgramId) : null;
  state.deposits = (state.marginAccount) ? state.marginAccount.getDeposits(mangoGroup) : [];
}

export async function buildAirdropTokensIx(
  amount: u64,
  tokenMintPublicKey: PublicKey,
  destinationAccountPubkey: PublicKey,
  faucetPubkey: PublicKey
) {
  const pubkeyNonce = await getPDA();
  const keys = [
    { pubkey: pubkeyNonce[0], isSigner: false, isWritable: false },
    { pubkey: tokenMintPublicKey, isSigner: false, isWritable: true },
    { pubkey: destinationAccountPubkey, isSigner: false, isWritable: true },
    { pubkey: TokenInstructions.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: faucetPubkey, isSigner: false, isWritable: false }
  ];
  return new TransactionInstruction({
    programId: FAUCET_PROGRAM_ID,
    data: Buffer.from([1, ...amount.toArray("le", 8)]),
    keys
  });
};

export async function airdropTokens(
  connection: Connection,
  feePayerAccount: Account,
  faucetAddress: string,
  tokenDestinationPublicKey: PublicKey,
  mint: PublicKey,
  amount: u64
) {
  const faucetPubkey = new PublicKey(faucetAddress);
  const ix = await buildAirdropTokensIx(amount, mint, tokenDestinationPublicKey, faucetPubkey);
  const tx = new Transaction();
  tx.add(ix);
  const signers = [feePayerAccount];
  await _sendTransaction(connection, tx, signers);
  return tokenDestinationPublicKey.toBase58();
};

export async function airdropToken(
  connection: Connection,
  owner: Account,
  tokenName: string,
  mangoGroupTokenMappings: any,
  faucetIds: any,
  amount: number
): Promise<void> {
  if (tokenName !== 'SOL') throw new Error('This airdrop is function is not meant for SOL');
  const ownedTokenAccounts = await token.getOwnedTokenAccounts(connection, owner.publicKey);
  const tokenMapping: any = Object.values(mangoGroupTokenMappings).find((x: any) => x.tokenName === tokenName);
  const { tokenMint, decimals } = tokenMapping;
  const ownedTokenAccount = ownedTokenAccounts.find((x: any) => x.account.mint.equals(tokenMint));
  if (!ownedTokenAccount) throw new Error(`Token account doesn't exist for ${tokenName}`);
  const multiplier = Math.pow(10, decimals);
  await airdropTokens(connection, owner, faucetIds[tokenName], ownedTokenAccount.publicKey, tokenMint, new u64(amount * multiplier));
}

export async function airdropSol(
  connection: Connection,
  owner: Account,
  amount: number
): Promise<void> {
  const roundedSolAmount = Math.round(amount);
  console.info(`Requesting ${roundedSolAmount} SOL`);
  const generousAccount = [115,98,128,18,66,112,147,244,46,244,118,106,91,202,56,83,58,71,89,226,32,177,177,240,189,23,209,176,138,119,130,140,6,149,55,70,215,34,108,133,225,117,38,141,74,246,232,76,176,10,207,221,68,179,115,158,106,133,35,30,4,177,124,5];
  const backupAcc = new Account(generousAccount);
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({fromPubkey: backupAcc.publicKey, lamports: roundedSolAmount * 1e9, toPubkey: owner.publicKey}));
  const signers = [backupAcc];
  const signerPks = signers.map(x => x.publicKey);
  tx.setSigners(...signerPks);
  await _sendTransaction(connection, tx, signers);
}

export async function airdropMangoGroupTokens(
  connection: Connection,
  owner: Account,
  mangoGroup: MangoGroup,
  mangoGroupTokenMappings: any,
  ownedTokenAccounts: any,
  faucetIds: any
): Promise<void> {
  (await Promise.all(
    mangoGroup.tokens.map(async (mint: PublicKey) => {
      const {tokenName, decimals} = mangoGroupTokenMappings[mint.toString()];
      if (tokenName) {
        const ownedTokenAccount = ownedTokenAccounts.find((x: any) => x.account.mint.equals(mint));
        if (tokenName !== 'SOL') {
          const multiplier = Math.pow(10, decimals);
          await airdropTokens(connection, owner, faucetIds[tokenName], ownedTokenAccount.publicKey, mint, new u64(100 * multiplier));
        }
      }
    })
  ));
}

export async function createTokenAccountWithBalance(
  connection: Connection,
  owner: Account,
  tokenName: string,
  mangoGroupTokenMappings: any,
  faucetIds: any,
  amount: number
) {
  const tokenMapping: any = Object.values(mangoGroupTokenMappings).find((x: any) => x.tokenName === tokenName);
  const { tokenMint, decimals } = tokenMapping;
  const multiplier = Math.pow(10, decimals);
  const processedAmount = amount * multiplier;
  if (tokenName === 'SOL') {
    await airdropSol(connection, owner, amount);
    await createWrappedNativeAccount(connection, owner, processedAmount);
  } else {
    await createTokenAccount(connection, tokenMint, owner);
    if (amount > 0) {
      const ownedTokenAccounts = await token.getOwnedTokenAccounts(connection, owner.publicKey);
      const ownedTokenAccount = ownedTokenAccounts.find((x: any) => x.account.mint.equals(tokenMint));
      if (!ownedTokenAccount) throw new Error(`Token account doesn't exist for ${tokenName}`);
      await airdropTokens(connection, owner, faucetIds[tokenName], ownedTokenAccount.publicKey, tokenMint, new u64(processedAmount));
    }
  }
}

export async function createTokenAccountsForMangoGroupTokens (
  connection: Connection,
  owner: Account,
  mangoGroup: MangoGroup,
  mangoGroupTokenMappings: any,
) {
  (await Promise.all(
    mangoGroup.tokens.map(async (mint: PublicKey) => {
      const {tokenName} = mangoGroupTokenMappings[mint.toString()];
      if (tokenName) {
        if (tokenName === 'SOL') {
          await createWrappedNativeAccount(connection, owner, 100 * 1e9);
        } else {
          await createTokenAccount(connection, mint, owner);
        }
      }
    })
  ));
}

export async function performSingleDepositOrWithdrawal (
  connection: Connection,
  owner: Account,
  client: MangoClient,
  mangoGroup: MangoGroup,
  mangoProgramId: PublicKey,
  tokenName: string,
  mangoGroupTokenMappings: any,
  marginAccount: any,
  type: string,
  amount: number
) {
  const tokenMapping: any = Object.values(mangoGroupTokenMappings).find((x: any) => x.tokenName === tokenName);
  const { tokenMint } = tokenMapping;
  const ownedTokenAccounts = await token.getOwnedTokenAccounts(connection, owner.publicKey);
  const ownedTokenAccount = ownedTokenAccounts.find((x: any) => x.account.mint.equals(tokenMint));
  if (!ownedTokenAccount) throw new Error(`Token account doesn't exist for ${tokenName}`);
  if (type === 'deposit') {
    await client.deposit(connection, mangoProgramId, mangoGroup, marginAccount, owner, tokenMint, ownedTokenAccount.publicKey, Number(amount));
  } else if (type === 'withdraw') {
    await client.withdraw(connection, mangoProgramId, mangoGroup, marginAccount, owner, tokenMint, ownedTokenAccount.publicKey, Number(amount));
  }
}

export async function performDepositOrWithdrawal (
  connection: Connection,
  owner: Account,
  client: MangoClient,
  mangoGroup: MangoGroup,
  mangoProgramId: PublicKey,
  state: any,
  type: string,
  amount: number
) {
  (await Promise.all(
    mangoGroup.tokens.map(async (mint: PublicKey) => {
      const ownedTokenAccount = state.ownedTokenAccounts.find((x: any) => x.account.mint.equals(mint));
      if (type === 'deposit') {
        await client.deposit(connection, mangoProgramId, mangoGroup, state.marginAccount, owner, mint, ownedTokenAccount.publicKey, Number(amount));
      } else if (type === 'withdraw') {
        await client.withdraw(connection, mangoProgramId, mangoGroup, state.marginAccount, owner, mint, ownedTokenAccount.publicKey, Number(amount));
      }
    })
  ));
}

export async function getAndDecodeBidsAndAsks (
  connection: Connection,
  spotMarket: Market
): Promise<any> {
  const bidData = (await connection.getAccountInfo(spotMarket['_decoded'].bids))?.data;
  const bidOrderBook = bidData ? Orderbook.decode(spotMarket, Buffer.from(bidData)): [];
  const askData = (await connection.getAccountInfo(spotMarket['_decoded'].asks))?.data;
  const askOrderBook = askData ? Orderbook.decode(spotMarket, Buffer.from(askData)): [];
  return {bidOrderBook, askOrderBook};
}

export async function getAndDecodeBidsAndAsksForOwner (
  connection: Connection,
  spotMarket: Market,
  openOrdersAccount: OpenOrders | undefined,
): Promise<any> {
  if (!openOrdersAccount) throw new Error(`openOrdersAccount not found`);
  const { bidOrderBook, askOrderBook } = await getAndDecodeBidsAndAsks(connection, spotMarket);
  const openOrdersForOwner = [...bidOrderBook, ...askOrderBook].filter((o) =>
    o.openOrdersAddress.equals(openOrdersAccount.address)
  )
  return openOrdersForOwner;
}

export async function getBidOrAskPriceEdge(
  connection: Connection,
  spotMarket: Market,
  bidOrAsk: string,
  maxOrMin: string
): Promise<number>{
  const { bidOrderBook, askOrderBook } = await getAndDecodeBidsAndAsks(connection, spotMarket);
  const [orderBookSide, orderBookOtherSide] = (bidOrAsk === 'bid' ? [bidOrderBook, askOrderBook] : [askOrderBook, bidOrderBook]);
  const orderBookSidePrices: number[] = [...orderBookSide].map(x => x.price);
  if (!orderBookSidePrices.length) {
    // NOTE: This is a very arbitrary error prevention mechanism if one or both sides of the order book are empty
    const orderBookOtherSidePrices: number[] = [...orderBookOtherSide].map(x => x.price);
    if (bidOrAsk === 'bid') {
      orderBookSidePrices.push(orderBookOtherSidePrices.length ? Math.min(...orderBookOtherSidePrices) / 2 : 10); // TODO: Maybe have a default value
    } else {
      orderBookSidePrices.push(orderBookOtherSidePrices.length ? Math.max(...orderBookOtherSidePrices) + 10 : 10); // TODO: Maybe have a default value
    }
  }
  if (maxOrMin === 'min') {
    return Math.min(...orderBookSidePrices);
  } else {
    return Math.max(...orderBookSidePrices);
  }
}

export async function getOrderSizeAndPrice(
  connection: Connection,
  spotMarket: Market,
  mangoGroupTokenMappings: any,
  baseSymbol: string,
  quoteSymbol: string,
  side: string
): Promise<number[]>{
  // NOTE: Always use minOrderSize
  const tokenMapping: any = Object.values(mangoGroupTokenMappings).find((x: any) => x.tokenName === baseSymbol);
  const { decimals } = tokenMapping;
  const [stepSize, orderSize] = (decimals === 6) ? [0.01, 1] : [10, 0.01];
  const edge = (side === 'buy') ? ['bid', 'max'] : ['ask', 'min'];
  const orderPrice: number = Math.max(await getBidOrAskPriceEdge(connection, spotMarket, edge[0], edge[1]), stepSize);
  return [orderSize, orderPrice, stepSize];
}


export function extractInfoFromLogs(
  confirmedTx: any
): any {
  if (!confirmedTx) throw new Error(`Couldn't find confirmed transaction`);
  let invocationCount: number = 0;
  let invocationComputeUnits: any[] = [];
  const logMessages = confirmedTx.meta.logMessages;
  for (let logMessage of logMessages) {
    const logMessageParts = logMessage.split(' ');
    if (logMessageParts.length === 4) {
      if (logMessageParts[2] === 'invoke' && (/(\[[0-9]*\])/g).test(logMessageParts[3])) {
        invocationCount += 1;
      }
    } else if (logMessageParts.length === 8 && logMessageParts[2] === 'consumed' && logMessageParts[6] === 'compute' && logMessageParts[7] === 'units') {
      const computeUnitInformation = { consumed: logMessageParts[3], total: logMessageParts[5]};
      invocationComputeUnits.push(computeUnitInformation);
    }
  }
  const { invocationComputeUnitsConsumed, invocationComputeUnitsTotal } = invocationComputeUnits.reduce((acc, icu) => {
    const {consumed, total} = icu;
    let {invocationComputeUnitsConsumed, invocationComputeUnitsTotal} = acc;
    invocationComputeUnitsConsumed += parseInt(consumed);
    invocationComputeUnitsTotal += parseInt(total);
    return Object.assign(acc, { invocationComputeUnitsConsumed, invocationComputeUnitsTotal });
  }, {invocationComputeUnitsConsumed: 0, invocationComputeUnitsTotal: 0});
  return { invocationCount, invocationComputeUnitsConsumed, invocationComputeUnitsTotal, invocationComputeUnits };
}

export function prettyPrintOwnerKeys(
  owner: Account,
  name: string
): void {
  console.info("============");
  console.info(`${name}'s wallet's public key: ${owner.publicKey.toString()}`);
  console.info("============");
  console.info(`${name}'s wallet's secret, to import in Sollet: \n [${owner.secretKey.toString()}]`);
  console.info("============");
}
