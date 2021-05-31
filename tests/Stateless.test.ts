import { MangoClient, MangoGroup, MarginAccount } from '../src/client';
import { findLargestTokenAccountForOwner } from '../src/utils';
import IDS from '../src/ids.json';
import { Account, Connection, PublicKey } from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { expect } from 'chai';
import { spawn } from 'child_process';
import { blob, struct, u8, nu64 } from 'buffer-layout';
import { sleep } from '../src/utils';
import dotenv from 'dotenv';

dotenv.config()

if (!process.env.AGGREGATOR_PATH) {
  console.info("You have not set the AGGREGATOR_PATH in .env, some tests will fail");
}

import {
  _sendTransaction,
  createWalletAndRequestAirdrop,
  createMangoGroupSymbolMappings,
  createTokenAccountWithBalance,
  getOwnedTokenAccounts,
  getAndDecodeBidsAndAsksForOwner,
  performSingleDepositOrWithdrawal,
  getAndDecodeBidsAndAsks,
  getOrderSizeAndPrice,
  extractInfoFromLogs,
  prettyPrintOwnerKeys
} from './test_utils';

console.log = function () {}; // NOTE: Disable all unnecessary logging

let cluster = "devnet";
const client = new MangoClient();
const clusterIds = IDS[cluster];
const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
const dexProgramId = new PublicKey(clusterIds.dex_program_id);
let connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip');

let mainnetCluster = "mainnet-beta";
const mainnetClusterIds = IDS[mainnetCluster];
const mainnetMangoProgramId = new PublicKey(mainnetClusterIds.mango_program_id);
const mainnetDexProgramId = new PublicKey(mainnetClusterIds.dex_program_id);
let mainnetConnection = new Connection(IDS.cluster_urls[mainnetCluster], 'singleGossip');

function chunkOrders(orders: any[], chunkSize: number) {
  return orders.reduce((resultArray: any[], item, index) => {
    const chunkIndex = Math.floor(index/chunkSize)
    if(!resultArray[chunkIndex]) {
      resultArray[chunkIndex] = []
    }
    resultArray[chunkIndex].push(item)
    return resultArray;
  }, []);
}

async function initAccountsWithBalances(neededBalances: number[]) {
  const owner = await createWalletAndRequestAirdrop(connection, 5);
  const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
  await Promise.all(neededBalances.map(async (x, i) => {
    if (x > 0) {
      const baseSymbol = mangoGroupSymbols[i];
      await createTokenAccountWithBalance(connection, owner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, x);
    }
  }));
  prettyPrintOwnerKeys(owner, "Account");
}

async function getSpotMarketDetails(mangoGroupSpotMarket: any): Promise<any> {
  const [spotMarketSymbol, spotMarketAddress] = mangoGroupSpotMarket;
  const [baseSymbol, quoteSymbol] = spotMarketSymbol.split('/');
  const spotMarket = await Market.load(connection, new PublicKey(spotMarketAddress), { skipPreflight: true, commitment: 'singleGossip'}, dexProgramId);
  return { spotMarket, baseSymbol, quoteSymbol };
}

async function requestPriceChange(mangoGroup: MangoGroup, requiredPrice: number, baseSymbol: string) {
  let prices = await mangoGroup.getPrices(connection);
  while (prices[0].toFixed(2) !== requiredPrice.toFixed(2)) {
    console.info("Running oracle to change price");
    await performPriceChange(Math.round( requiredPrice * 1e2 ) / 1e2, baseSymbol.toLowerCase());
    console.info("Finished running oracle to change price");
    try {
      prices = await mangoGroup.getPrices(connection);
    } catch (e) {
      console.info("Error, trying to reset connection");
      connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip');
      prices = await mangoGroup.getPrices(connection);
    }
  }
  return prices;
}

function performPriceChange(requiredPrice: number, baseSymbol: string): Promise<void> {
  return new Promise(function(resolve, _){
    const priceChangerOracle = spawn('yarn', ['solink', 'oracle', (requiredPrice * 100).toString()], {cwd: process.env.AGGREGATOR_PATH});
    priceChangerOracle.stdout.on("data", data => {
      if (data.includes(`Submit OK {"aggregator":"${baseSymbol}:usd"`)) {
        priceChangerOracle.kill();
        resolve();
      }
    });
  })
}

async function cleanOrderBook(mangoGroupSpotMarket: any) {
  console.info("Cleaning order book, this will take a while...");
  const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(mangoGroupSpotMarket);
  let bna = await getAndDecodeBidsAndAsks(connection, spotMarket);
  let allAsks: any[] = [...bna.askOrderBook].map(x => ({ price: x.price, size: x.size })).reverse();
  let allBids: any[] = [...bna.bidOrderBook].map(x => ({ price: x.price, size: x.size })).reverse();
  if (allAsks.length || allBids.length) {
    const owner = await createWalletAndRequestAirdrop(connection, 5);
    try {
      const marginAccountPk = await client.initMarginAccount(connection, mangoProgramId, mangoGroup, owner);
      let marginAccount = await client.getMarginAccount(connection, marginAccountPk, dexProgramId);
      const amountNeededToClearAsks: number = Math.ceil(allAsks.reduce((acc, ask) => acc + (ask.price * ask.size), 0) + 10);
      await createTokenAccountWithBalance(connection, owner, quoteSymbol, mangoGroupTokenMappings, clusterIds.faucets, amountNeededToClearAsks);
      await performSingleDepositOrWithdrawal(connection, owner, client, mangoGroup, mangoProgramId, quoteSymbol, mangoGroupTokenMappings, marginAccount, 'deposit', amountNeededToClearAsks);
      const chunkedAsks = chunkOrders(allAsks, 15);
      for (let ask of chunkedAsks) {
        marginAccount = await client.getMarginAccount(connection, marginAccountPk, dexProgramId);
        const price: number = Math.max(...ask.map((x: any) => x.price));
        const size: number = ask.reduce(( a: any, b: any ) => a + b.size, 0);
        const roundedSize = Math.round( size * 1e2 ) / 1e2;
        await client.placeAndSettle(connection, mangoProgramId, mangoGroup, marginAccount, spotMarket, owner, 'buy', price, roundedSize);
      }
      const amountNeededToClearBids: number =  Math.ceil(allBids.reduce((acc, bid) => acc + (bid.size), 0) + 10);
      await createTokenAccountWithBalance(connection, owner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, amountNeededToClearBids);
      await performSingleDepositOrWithdrawal(connection, owner, client, mangoGroup, mangoProgramId, baseSymbol, mangoGroupTokenMappings, marginAccount, 'deposit', amountNeededToClearBids);
      const chunkedBids = chunkOrders(allBids, 15);
      for (let bid of chunkedBids) {
        marginAccount = await client.getMarginAccount(connection, marginAccountPk, dexProgramId);
        const price: number = Math.min(...bid.map((x: any) => x.price));
        const size: number = bid.reduce(( a: any, b: any ) => a + b.size, 0);
        const roundedSize = Math.round( size * 1e2 ) / 1e2;
        await client.placeAndSettle(connection, mangoProgramId, mangoGroup, marginAccount, spotMarket, owner, 'sell', price, roundedSize);
      }
      bna = await getAndDecodeBidsAndAsks(connection, spotMarket);
      allAsks = [...bna.askOrderBook].map(x => ({ price: x.price, size: x.size }));
      allBids = [...bna.bidOrderBook].map(x => ({ price: x.price, size: x.size }));
      expect(allAsks).to.be.empty;
      expect(allBids).to.be.empty;
      prettyPrintOwnerKeys(owner, "Cleaner");
    } catch (error) {
      throw new Error(`
        Test Error: ${error.message},
        ${prettyPrintOwnerKeys(owner, "Cleaner")}
      `);
    }
  }
}

async function placeNOrdersAfterLimit(mangoGroupSpotMarket: any, marketIndex: number, orderQuantityAfter: number) {
  let openOrdersForOwner: any[];
  const orderQuantity = 128; // Max orders
  const buyerOwner = await createWalletAndRequestAirdrop(connection, 5);
  prettyPrintOwnerKeys(buyerOwner, "Buyer");
  const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
  const buyerMarginAccountPk = await client.initMarginAccount(connection, mangoProgramId, mangoGroup, buyerOwner);
  let buyerMarginAccount = await client.getMarginAccount(connection, buyerMarginAccountPk, dexProgramId);

  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(mangoGroupSpotMarket);
  const baseSymbolIndex = mangoGroupSymbols.findIndex(x => x === baseSymbol);
  const quoteSymbolIndex = mangoGroupSymbols.findIndex(x => x === quoteSymbol);

  const [orderSize, orderPrice, _] = await getOrderSizeAndPrice(connection, spotMarket, mangoGroupTokenMappings, baseSymbol, quoteSymbol, 'buy');
  const neededQuoteAmount = orderPrice * orderSize;
  const neededBaseAmountForAllTrades = orderSize * orderQuantity;
  const neededQuoteAmountForAllTrades = neededQuoteAmount * orderQuantity;
  console.info("neededQuoteAmountForAllTrades:", neededQuoteAmountForAllTrades);

  await createTokenAccountWithBalance(connection, buyerOwner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, neededQuoteAmountForAllTrades);
  await performSingleDepositOrWithdrawal(connection, buyerOwner, client, mangoGroup, mangoProgramId, baseSymbol, mangoGroupTokenMappings, buyerMarginAccount, 'deposit', neededQuoteAmountForAllTrades);

  await requestPriceChange(mangoGroup, orderPrice, baseSymbol);

  for (let i = 0; i < orderQuantity; i++) {
    console.info(`Placing a buy order of ${orderSize} ${baseSymbol} for ${orderPrice} ${quoteSymbol} = ~${neededQuoteAmount} ${quoteSymbol} - ${i + 1}/${orderQuantity}`);
    buyerMarginAccount = await client.getMarginAccount(connection, buyerMarginAccount.publicKey, dexProgramId);
    await client.placeAndSettle(connection, mangoProgramId, mangoGroup, buyerMarginAccount, spotMarket, buyerOwner, 'buy', orderPrice, orderSize);
  }
  buyerMarginAccount = await client.getMarginAccount(connection, buyerMarginAccount.publicKey, dexProgramId);
  openOrdersForOwner = await getAndDecodeBidsAndAsksForOwner(connection, spotMarket, buyerMarginAccount.openOrdersAccounts[marketIndex]);
  // TODO: this should be a for loop of cancellations
  // NOTE: Maybe trying cancelling last order not first
  expect(openOrdersForOwner).to.be.an('array').and.to.have.lengthOf(128);
  await client.cancelOrder(connection, mangoProgramId, mangoGroup, buyerMarginAccount, buyerOwner, spotMarket, openOrdersForOwner[0]);
  buyerMarginAccount = await client.getMarginAccount(connection, buyerMarginAccount.publicKey, dexProgramId);
  openOrdersForOwner = await getAndDecodeBidsAndAsksForOwner(connection, spotMarket, buyerMarginAccount.openOrdersAccounts[marketIndex]);
  expect(openOrdersForOwner).to.be.an('array').and.to.have.lengthOf(127);
  for (let i = 0; i < orderQuantityAfter; i++) {
    console.info(`Placing a buy order of ${orderSize} ${baseSymbol} for ${orderPrice} ${quoteSymbol} = ~${neededQuoteAmount} ${quoteSymbol} - ${i + 1}/${orderQuantityAfter}`);
    buyerMarginAccount = await client.getMarginAccount(connection, buyerMarginAccount.publicKey, dexProgramId);
    await client.placeAndSettle(connection, mangoProgramId, mangoGroup, buyerMarginAccount, spotMarket, buyerOwner, 'buy', orderPrice, orderSize);
  }
  expect(openOrdersForOwner).to.be.an('array').and.to.have.lengthOf(128);
}

async function stressTestMatchOrder(mangoGroupSpotMarket: any, orderQuantity: number): Promise<void> {
  let bna: any, allAsks: any[], allBids: any[];
  const sellerOwner = await createWalletAndRequestAirdrop(connection, 5);
  prettyPrintOwnerKeys(sellerOwner, "Seller");
  const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
  const sellerMarginAccountPk = await client.initMarginAccount(connection, mangoProgramId, mangoGroup, sellerOwner);
  let sellerMarginAccount = await client.getMarginAccount(connection, sellerMarginAccountPk, dexProgramId);

  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(mangoGroupSpotMarket);

  const [orderSize, orderPrice, _] = await getOrderSizeAndPrice(connection, spotMarket, mangoGroupTokenMappings, baseSymbol, quoteSymbol, 'sell');
  const neededQuoteAmount = orderPrice * orderSize;
  const neededBaseAmountForAllTrades = orderSize * orderQuantity;
  const neededQuoteAmountForAllTrades = neededQuoteAmount * orderQuantity;
  await createTokenAccountWithBalance(connection, sellerOwner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, neededBaseAmountForAllTrades);
  await performSingleDepositOrWithdrawal(connection, sellerOwner, client, mangoGroup, mangoProgramId, baseSymbol, mangoGroupTokenMappings, sellerMarginAccount, 'deposit', neededBaseAmountForAllTrades);
  for (let i = 0; i < orderQuantity; i++) {
    console.info(`Placing a sell order of ${orderSize} ${baseSymbol} for ${orderPrice} ${quoteSymbol} = ~${neededQuoteAmount} USD - ${i + 1}/${orderQuantity}`);
    sellerMarginAccount = await client.getMarginAccount(connection, sellerMarginAccountPk, dexProgramId);
    await client.placeAndSettle(connection, mangoProgramId, mangoGroup, sellerMarginAccount, spotMarket, sellerOwner, 'sell', orderPrice, orderSize);
  }

  bna = await getAndDecodeBidsAndAsks(connection, spotMarket);
  allAsks = [...bna.askOrderBook].map(x => ({ price: x.price, size: x.size }));
  allBids = [...bna.bidOrderBook].map(x => ({ price: x.price, size: x.size }));

  const buyerOwner = await createWalletAndRequestAirdrop(connection, 5);
  prettyPrintOwnerKeys(buyerOwner, "Buyer");
  const buyerMarginAccountPk = await client.initMarginAccount(connection, mangoProgramId, mangoGroup, buyerOwner);
  const buyerMarginAccount = await client.getMarginAccount(connection, buyerMarginAccountPk, dexProgramId);
  await createTokenAccountWithBalance(connection, buyerOwner, quoteSymbol, mangoGroupTokenMappings, clusterIds.faucets, neededQuoteAmountForAllTrades);
  await performSingleDepositOrWithdrawal(connection, buyerOwner, client, mangoGroup, mangoProgramId, quoteSymbol, mangoGroupTokenMappings, buyerMarginAccount, 'deposit', neededQuoteAmountForAllTrades);
  console.info(`Placing a buy order of ${neededBaseAmountForAllTrades} ${baseSymbol} for ${orderPrice} ${quoteSymbol} = ~${neededQuoteAmountForAllTrades} ${quoteSymbol}`);
  const buyTxHash = await client.placeAndSettle(connection, mangoProgramId, mangoGroup, buyerMarginAccount, spotMarket, buyerOwner, 'buy', orderPrice, neededBaseAmountForAllTrades);
  console.info("buyTxHash:", buyTxHash);
  await connection.confirmTransaction(buyTxHash, 'finalized');
  const buyConfirmedTx: any = await connection.getConfirmedTransaction(buyTxHash);
  const buyTxLogInfo = extractInfoFromLogs(buyConfirmedTx);
  console.info("Buy txLogInfo:", buyTxLogInfo);

  bna = await getAndDecodeBidsAndAsks(connection, spotMarket);
  allAsks = [...bna.askOrderBook].map(x => ({ price: x.price, size: x.size }));
  allBids = [...bna.bidOrderBook].map(x => ({ price: x.price, size: x.size }));
  expect(allAsks).to.be.empty;
  expect(allBids).to.be.empty;
}

async function stressTestLiquidation(mangoGroupSpotMarket: any, orderQuantity: number, shouldPartialLiquidate: boolean = false) {
  let bna: any, allAsks: any[], allBids: any[], prices: number[];
  let leverageCoefficient = 15;
  const liqeeOwner = await createWalletAndRequestAirdrop(connection, 5);
  prettyPrintOwnerKeys(liqeeOwner, "Liqee");
  const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
  const liqeeMarginAccountPk = await client.initMarginAccount(connection, mangoProgramId, mangoGroup, liqeeOwner);
  let liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);

  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(mangoGroupSpotMarket);
  const baseSymbolIndex = mangoGroupSymbols.findIndex(x => x === baseSymbol);
  const quoteSymbolIndex = mangoGroupSymbols.findIndex(x => x === quoteSymbol);

  const [orderSize, orderPrice, _] = await getOrderSizeAndPrice(connection, spotMarket, mangoGroupTokenMappings, baseSymbol, quoteSymbol, 'buy');
  const neededQuoteAmount = orderPrice * orderSize;
  const neededBaseAmountForAllTrades = orderSize * orderQuantity;
  const neededQuoteAmountForAllTrades = neededQuoteAmount * orderQuantity;
  console.info("neededBaseAmountForAllTrades:", neededBaseAmountForAllTrades);

  await createTokenAccountWithBalance(connection, liqeeOwner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, neededBaseAmountForAllTrades);
  await performSingleDepositOrWithdrawal(connection, liqeeOwner, client, mangoGroup, mangoProgramId, baseSymbol, mangoGroupTokenMappings, liqeeMarginAccount, 'deposit', neededBaseAmountForAllTrades);

  prices = await requestPriceChange(mangoGroup, orderPrice, baseSymbol);

  for (let i = 0; i < orderQuantity; i++) {
    console.info(`Placing a buy order of ${orderSize} ${baseSymbol} for ${orderPrice} ${quoteSymbol} = ~${neededQuoteAmount} ${quoteSymbol} - ${i + 1}/${orderQuantity}`);
    liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);
    await client.placeAndSettle(connection, mangoProgramId, mangoGroup, liqeeMarginAccount, spotMarket, liqeeOwner, 'buy', orderPrice * 2, orderSize);
  }

  liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);

  console.info("collRatio before price change:", liqeeMarginAccount.getCollateralRatio(mangoGroup, prices));
  prices = await requestPriceChange(mangoGroup, orderPrice / leverageCoefficient, baseSymbol);
  console.info("collRatio after price change:", liqeeMarginAccount.getCollateralRatio(mangoGroup, prices));

  const liqorOwner = await createWalletAndRequestAirdrop(connection, 5);
  prettyPrintOwnerKeys(liqeeOwner, "Liqor");
  for (let mangoGroupSymbol of mangoGroupSymbols) {
    const requiredBalance = (mangoGroupSymbol === quoteSymbol) ? neededQuoteAmountForAllTrades : 0;
    await createTokenAccountWithBalance(connection, liqorOwner, mangoGroupSymbol, mangoGroupTokenMappings, clusterIds.faucets, requiredBalance);
  }
  const tokenWallets = (await Promise.all(
    mangoGroup.tokens.map(
      (mint) => findLargestTokenAccountForOwner(connection, liqorOwner.publicKey, mint).then(
        (response) => response.publicKey
      )
    )
  ));
  let liquidationTxHash: string;
  if (shouldPartialLiquidate) {
    liquidationTxHash = await client.partialLiquidate(connection, mangoProgramId, mangoGroup, liqeeMarginAccount, liqorOwner, tokenWallets[quoteSymbolIndex], tokenWallets[baseSymbolIndex], quoteSymbolIndex, baseSymbolIndex, neededQuoteAmountForAllTrades);
  } else {
    const depositQuantities = new Array(tokenWallets.length).fill(0);
    depositQuantities[quoteSymbolIndex] = neededQuoteAmountForAllTrades;
    liquidationTxHash = await client.liquidate(connection, mangoProgramId, mangoGroup, liqeeMarginAccount, liqorOwner, tokenWallets, depositQuantities);
  }
  console.info("liquidationTxHash:", liquidationTxHash);
  await connection.confirmTransaction(liquidationTxHash, 'finalized');
  const liquidationConfirmedTx: any = await connection.getConfirmedTransaction(liquidationTxHash);
  const liquidationTxLogInfo = extractInfoFromLogs(liquidationConfirmedTx);
  console.info("Liquidation txLogInfo:", liquidationTxLogInfo);
}

const mangoGroupName = 'BTC_ETH_SOL_SRM_USDC';
const mangoGroupSymbols = mangoGroupName.split('_');
const mangoGroupIds = clusterIds.mango_groups[mangoGroupName];
const mangoGroupSpotMarkets: [string, string][] = Object.entries(mangoGroupIds.spot_market_symbols);
const mangoGroupPk = new PublicKey(mangoGroupIds.mango_group_pk);

const mangoGroupSpotMarket = mangoGroupSpotMarkets[0]; //BTC/USDC
// const mangoGroupSpotMarket = mangoGroupSpotMarkets[1]; //ETH/USDC
// const mangoGroupSpotMarket = mangoGroupSpotMarkets[2]; //SOL/USDC
// const mangoGroupSpotMarket = mangoGroupSpotMarkets[3]; //SRM/USDC

describe('Log stuff', async() => {
  // it('should log token decimals', async() => {
  //   const MINT_LAYOUT = struct([blob(44), u8('decimals'), blob(37)]);
  //   const mainnetTokensToTest = [
  //     ['BTC', '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'],
  //     ['ETH', '2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk'],
  //     ['SOL', 'So11111111111111111111111111111111111111112'],
  //     ['SRM', 'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt'],
  //     ['USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
  //     ['USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  //   ];
  //   const devnetTokensToTest = [
  //     ['BTC', 'bypQzRBaSDWiKhoAw3hNkf35eF3z3AZCU8Sxks6mTPP'],
  //     ['ETH', 'ErWGBLBQMwdyC4H3MR8ef6pFK6gyHAyBxy4o1mHoqKzm'],
  //     ['SOL', 'So11111111111111111111111111111111111111112'],
  //     ['SRM', '9FbAMDvXqNjPqZSYt4EWTguJuDrGkfvwr3gSFpiSbX9S'],
  //     ['USDT', '7KBVenLz5WNH4PA5MdGkJNpDDyNKnBQTwnz1UqJv9GUm'],
  //     ['USDC', 'H6hy7Ykzc43EuGivv7VVuUKNpKgUoFAfUY3wdPr4UyRX'],
  //   ];
  //   for (let [tokenName, tokenMint] of mainnetTokensToTest) {
  //     const data: any = await mainnetConnection.getAccountInfo(new PublicKey(tokenMint));
  //     const info = MINT_LAYOUT.decode(data.data);
  //     console.info(`Mainnet ${tokenName} decimals: ${info.decimals}`);
  //   }
  //   for (let [tokenName, tokenMint] of devnetTokensToTest) {
  //     const data: any = await connection.getAccountInfo(new PublicKey(tokenMint));
  //     const info = MINT_LAYOUT.decode(data.data);
  //     console.info(`Devnet ${tokenName} decimals: ${info.decimals}`);
  //   };
  // });
  // it('should log lotSizes', async() => {
  //   const mainnetSpotMarketsToTest = [
  //     ['BTC/USDC', 'A8YFbxQYFVqKZaoYJLLUVcQiWP7G2MeEgW5wsAQgMvFw'],
  //     ['ETH/USDC', '4tSvZvnbyzHXLMTiFonMyxZoHmFqau1XArcRCVHLZ5gX'],
  //     ['SOL/USDC', '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT'],
  //     ['SRM/USDC', 'ByRys5tuUWDgL73G8JBAEfkdFf8JWBzPBDHsBVQ5vbQA'],
  //   ];
  //   for (let [spotMarketName, spotMarketAddress] of mainnetSpotMarketsToTest) {
  //     const spotMarket = await Market.load(mainnetConnection, new PublicKey(spotMarketAddress), { skipPreflight: true, commitment: 'singleGossip'}, mainnetDexProgramId);
  //     console.info(`Mainnet ${spotMarketName} base/quote lotSizes: ${spotMarket['_decoded'].baseLotSize.toString()}/${spotMarket['_decoded'].quoteLotSize.toString()}`);
  //   }
  // })
  // it ('should log order', async() => {
  //   const { spotMarket } = await getSpotMarketDetails(mangoGroupSpotMarket);
  //   let bna = await getAndDecodeBidsAndAsks(connection, spotMarket);
  //   let allAsks: any[] = [...bna.askOrderBook].map(x => ({ price: x.price, size: x.size })).reverse();
  //   let allBids: any[] = [...bna.bidOrderBook].map(x => ({ price: x.price, size: x.size })).reverse();
  //   console.info(allAsks);
  //   console.info(allBids);
  // })
})

describe('create account with test money', async() => {
  it('should create an account with test money', async() => {
    await initAccountsWithBalances([50, 50, 50, 1000, 100000]);
  });
});

describe('stress test order limits', async() => {
  // before(async () => {
  //   await cleanOrderBook(mangoGroupSpotMarket);
  // });
  // it('should be able to place 129th order after cancelling one', async() => {
  //   await placeNOrdersAfterLimit(mangoGroupSpotMarket, 0, 1);
  // });
});

describe('stress testing matching orders', async() => {
  // before(async () => {
  //   await cleanOrderBook(mangoGroupSpotMarket);
  // });
  // it('should match 1 order at a single price', async() => {
  //   await stressTestMatchOrder(mangoGroupSpotMarket, 1);
  // });
  // it('should match 10 orders at a single price', async() => {
  //   await stressTestMatchOrder(mangoGroupSpotMarket, 10);
  // });
  // it('should match 20 orders at a single price', async() => {
  //   await stressTestMatchOrder(mangoGroupSpotMarket, 20);
  // });
  // it('should match 25 orders at a single price', async() => {
  //   await stressTestMatchOrder(mangoGroupSpotMarket, 25);
  // });
});

describe('stress testing liquidation', async() => {
  // before(async () => {
  //   await cleanOrderBook(mangoGroupSpotMarket);
  // });
  // it('should liquidate an account with 1 open order', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 1);
  // });
  // it('should liquidate an account with 10 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 10);
  // });
  // it('should liquidate an account with 20 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 20);
  // });
  // it('should liquidate an account with 25 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 25);
  // });
  // it('should liquidate an account with 128 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 128);
  // });
});

describe('stress testing partial liquidation', async() => {
  // before(async () => {
  //   await cleanOrderBook(mangoGroupSpotMarket);
  // });
  it('should partially liquidate an account with 1 open order', async() => {
    await stressTestLiquidation(mangoGroupSpotMarket, 1, true);
  });
  // it('should partially liquidate an account with 10 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 10, true);
  // });
  // it('should partially liquidate an account with 20 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 20, true);
  // });
  // it('should partially liquidate an account with 25 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 25, true);
  // });
  // it('should partially liquidate an account with 128 open orders', async() => {
  //   await stressTestLiquidation(mangoGroupSpotMarket, 128, true);
  // });
});
