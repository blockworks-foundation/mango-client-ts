import { MangoClient, MangoGroup, MarginAccount } from '../src/client';
import { findLargestTokenAccountForOwner } from '../src/utils';
import IDS from '../src/ids.json';
import { Account, Connection, PublicKey } from '@solana/web3.js';
import { Market, OpenOrders } from '@project-serum/serum';
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
  getSpotMarketDetails,
  createMangoGroupSymbolMappings,
  createTokenAccountWithBalance,
  getMinSizeAndPriceForMarket,
  placeOrderUsingSerumDex,
  cancelOrdersUsingSerumDex,
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

async function initAccountsWithBalances(neededBalances: number[], wrappedSol: boolean) {
  const owner = await createWalletAndRequestAirdrop(connection, 5);
  const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
  await Promise.all(neededBalances.map(async (x, i) => {
    if (x > 0) {
      const baseSymbol = mangoGroupSymbols[i];
      await createTokenAccountWithBalance(connection, owner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, x, wrappedSol);
    }
  }));
  prettyPrintOwnerKeys(owner, "Account");
  return owner;
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
  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(connection, mangoGroupSpotMarket, dexProgramId);
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
        const roundedSize = Math.round( size * 1e6 ) / 1e6;
        console.info(`Buying ${roundedSize} for ${price}`)
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
        const roundedSize = Math.round( size * 1e6 ) / 1e6;
        console.info(`Selling ${roundedSize} for ${price}`)
        await client.placeAndSettle(connection, mangoProgramId, mangoGroup, marginAccount, spotMarket, owner, 'sell', price, roundedSize);
      }
      bna = await getAndDecodeBidsAndAsks(connection, spotMarket);
      allAsks = [...bna.askOrderBook].map(x => ({ price: x.price, size: x.size }));
      allBids = [...bna.bidOrderBook].map(x => ({ price: x.price, size: x.size }));
      expect(allAsks).to.be.empty;
      expect(allBids).to.be.empty;
      prettyPrintOwnerKeys(owner, "Cleaner");
    } catch (error) {
      console.info(error);
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

  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(connection, mangoGroupSpotMarket, dexProgramId);

  const [orderSize, orderPrice, _] = await getOrderSizeAndPrice(connection, spotMarket, mangoGroupTokenMappings, baseSymbol, quoteSymbol, 'buy');
  const neededQuoteAmount = orderPrice * orderSize;
  const neededQuoteAmountForAllTrades = neededQuoteAmount * orderQuantity;

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

  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(connection, mangoGroupSpotMarket, dexProgramId);

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

async function stressTestLiquidation(params: {
  mangoGroupSpotMarket: any,
  orderQuantity?: number,
  customLiqeeOwner?: Account,
  shouldPartialLiquidate?: boolean,
  shouldCreateNewLiqor?: boolean,
  shouldFinishLiquidationInTest?: boolean,
  customOrderPrice?: number,
  customOrderSize?: number,
  leverageCoefficient?: number,
  matchLeveragedOrder?: boolean,
  side?: 'buy' | 'sell'
}) {
  const {
    mangoGroupSpotMarket,
    orderQuantity = 1,
    customLiqeeOwner = null,
    shouldPartialLiquidate = false,
    shouldCreateNewLiqor = true,
    shouldFinishLiquidationInTest = true,
    customOrderPrice = 0,
    customOrderSize = 0,
    leverageCoefficient = 15,
    matchLeveragedOrder = false,
    side = 'buy'
  } = params;
  console.info("shouldCreateNewLiqor:", shouldCreateNewLiqor)
  console.info("orderQuantity:", orderQuantity)
  let bna: any, allAsks: any[], allBids: any[], prices: number[];
  const liqeeOwner = customLiqeeOwner || await createWalletAndRequestAirdrop(connection, 5);
  prettyPrintOwnerKeys(liqeeOwner, "Liqee");
  const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
  const liqeeMarginAccountPk = (customLiqeeOwner) ? (await client.getMarginAccountsForOwner(connection, mangoProgramId, mangoGroup, liqeeOwner))[0].publicKey : await client.initMarginAccount(connection, mangoProgramId, mangoGroup, liqeeOwner);
  let liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);
  const { spotMarket, baseSymbol, quoteSymbol } = await getSpotMarketDetails(connection, mangoGroupSpotMarket, dexProgramId);
  const baseSymbolIndex = mangoGroupSymbols.findIndex(x => x === baseSymbol);
  const quoteSymbolIndex = mangoGroupSymbols.findIndex(x => x === quoteSymbol);

  const [orderSize, orderPrice, _] = await getOrderSizeAndPrice(connection, spotMarket, mangoGroupTokenMappings, baseSymbol, quoteSymbol, side);
  const finalOrderPrice = customOrderPrice || orderPrice;
  const finalOrderSize = customOrderSize || orderSize;
  const neededQuoteAmount = finalOrderPrice * finalOrderSize;
  const neededBaseAmountForAllTrades = finalOrderSize * orderQuantity;
  const neededQuoteAmountForAllTrades = neededQuoteAmount * orderQuantity;
  const neededCollateralTokenSymbol = (side === 'buy') ? baseSymbol : quoteSymbol;
  const neededAmountForAllTrades = (side === 'buy') ? neededBaseAmountForAllTrades : neededQuoteAmountForAllTrades;
  await createTokenAccountWithBalance(connection, liqeeOwner, neededCollateralTokenSymbol, mangoGroupTokenMappings, clusterIds.faucets, neededAmountForAllTrades);
  await performSingleDepositOrWithdrawal(connection, liqeeOwner, client, mangoGroup, mangoProgramId, neededCollateralTokenSymbol, mangoGroupTokenMappings, liqeeMarginAccount, 'deposit', neededAmountForAllTrades);
  prices = await requestPriceChange(mangoGroup, finalOrderPrice, baseSymbol);

  for (let i = 0; i < orderQuantity; i++) {
    console.info(`Placing a ${side} order of ${finalOrderSize} ${baseSymbol} for ${finalOrderPrice} ${quoteSymbol} = ~${neededQuoteAmount} ${quoteSymbol} - ${i + 1}/${orderQuantity}`);
    liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);
    console.info("Deposits init:", liqeeMarginAccount.getAssets(mangoGroup));
    console.info("Assets init:", liqeeMarginAccount.getAssets(mangoGroup));
    console.info("Liabs init:", liqeeMarginAccount.getLiabs(mangoGroup));
    await client.placeAndSettle(connection, mangoProgramId, mangoGroup, liqeeMarginAccount, spotMarket, liqeeOwner, side, finalOrderPrice, finalOrderSize);
    console.info("Sleeep!!!")
    await sleep(5000);
    liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);
    console.info("Deposits:", liqeeMarginAccount.getAssets(mangoGroup));
    console.info("Assets:", liqeeMarginAccount.getAssets(mangoGroup));
    console.info("Assets Val:", liqeeMarginAccount.getAssetsVal(mangoGroup, prices));
    console.info("Liabs:", liqeeMarginAccount.getLiabs(mangoGroup));
  }

  if (matchLeveragedOrder) await cleanOrderBook(mangoGroupSpotMarket);
  console.info("Sleeep!!!")
  await sleep(10000);
  liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);
  console.info("collRatio before price change:", liqeeMarginAccount.getCollateralRatio(mangoGroup, prices));
  console.info("Assets before:", liqeeMarginAccount.getAssets(mangoGroup));
  console.info("Assets Val before:", liqeeMarginAccount.getAssetsVal(mangoGroup, prices));
  console.info("Deposits before:", liqeeMarginAccount.getDeposits(mangoGroup));
  console.info("Liabs before:", liqeeMarginAccount.getLiabs(mangoGroup));
  console.info(prices);
  const adjustedPrice = (side === 'buy') ? finalOrderPrice / leverageCoefficient : finalOrderPrice * leverageCoefficient;
  prices = await requestPriceChange(mangoGroup, adjustedPrice, baseSymbol);
  liqeeMarginAccount = await client.getMarginAccount(connection, liqeeMarginAccountPk, dexProgramId);
  console.info("collRatio after price change:", liqeeMarginAccount.getCollateralRatio(mangoGroup, prices));
  console.info("Assets after:", liqeeMarginAccount.getAssets(mangoGroup));
  console.info("Assets Val after:", liqeeMarginAccount.getAssetsVal(mangoGroup, prices));
  console.info("Deposits after:", liqeeMarginAccount.getDeposits(mangoGroup));
  console.info("Liabs after:", liqeeMarginAccount.getLiabs(mangoGroup));
  console.info(prices);

  let liqorOwner = new Account();

  if (shouldCreateNewLiqor) {
    liqorOwner = await createWalletAndRequestAirdrop(connection, 5);
    prettyPrintOwnerKeys(liqorOwner, "Liqor");
    for (let mangoGroupSymbol of mangoGroupSymbols) {
      const requiredBalance = (mangoGroupSymbol === quoteSymbol) ? neededQuoteAmountForAllTrades : 0;
      await createTokenAccountWithBalance(connection, liqorOwner, mangoGroupSymbol, mangoGroupTokenMappings, clusterIds.faucets, requiredBalance);
    }
    if (shouldFinishLiquidationInTest) {
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
  }

  return {liqeeOwner, liqorOwner};
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

describe('stress test order limits', async() => {
  before(async () => {
    await cleanOrderBook(mangoGroupSpotMarket);
  });
  it('should be able to place 129th order after cancelling one', async() => {
    await placeNOrdersAfterLimit(mangoGroupSpotMarket, 0, 1);
  });
});

describe('stress testing matching orders', async() => {
  before(async () => {
    await cleanOrderBook(mangoGroupSpotMarket);
  });
  it('should match 1 order at a single price', async() => {
    await stressTestMatchOrder(mangoGroupSpotMarket, 1);
  });
  it('should match 10 orders at a single price', async() => {
    await stressTestMatchOrder(mangoGroupSpotMarket, 10);
  });
  it('should match 20 orders at a single price', async() => {
    await stressTestMatchOrder(mangoGroupSpotMarket, 20);
  });
  it('should match 25 orders at a single price', async() => {
    await stressTestMatchOrder(mangoGroupSpotMarket, 25);
  });
});

describe('stress testing liquidation', async() => {
  before(async () => {
    await cleanOrderBook(mangoGroupSpotMarket);
  });
  it('should liquidate an account with 1 open order', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 1});
  });
  it('should liquidate an account with 10 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 10});
  });
  it('should liquidate an account with 20 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 20});
  });
  it('should liquidate an account with 25 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 25});
  });
  it('should liquidate an account with 128 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 128});
  });
});

describe('stress testing partial liquidation', async() => {
  // before(async () => {
  //   await cleanOrderBook(mangoGroupSpotMarket);
  // });
  it('should partially liquidate an account with 1 open order', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 1, shouldPartialLiquidate: true});
  });
  it('should partially liquidate an account with 10 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 10, shouldPartialLiquidate: true});
  });
  it('should partially liquidate an account with 20 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 20, shouldPartialLiquidate: true});
  });
  it('should partially liquidate an account with 25 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 25, shouldPartialLiquidate: true});
  });
  it('should partially liquidate an account with 128 open orders', async() => {
    await stressTestLiquidation({mangoGroupSpotMarket, orderQuantity: 128, shouldPartialLiquidate: true});
  });
it ('should test socialized loss with 1 borrows', async() => {
  const mangoGroupSpotMarketBTC = mangoGroupSpotMarkets[0]; //BTC/USDC
  await stressTestLiquidation({ mangoGroupSpotMarket: mangoGroupSpotMarketBTC, shouldPartialLiquidate: true, shouldFinishLiquidationInTest: true, customOrderPrice: 20, customOrderSize: 1, matchLeveragedOrder: false, shouldCreateNewLiqor: true, leverageCoefficient: 30 });
})
  it ('should test socialized loss with 4 borrows', async() => {
    const mangoGroupSpotMarketETH = mangoGroupSpotMarkets[1]; //ETH/USDC
    const { liqeeOwner } = await stressTestLiquidation({ mangoGroupSpotMarket: mangoGroupSpotMarketETH, shouldPartialLiquidate: true, shouldFinishLiquidationInTest: false, customOrderPrice: 10, customOrderSize: 1, shouldCreateNewLiqor: false });
    const mangoGroupSpotMarketSOL = mangoGroupSpotMarkets[2]; //SOL/USDC
    await stressTestLiquidation({ mangoGroupSpotMarket: mangoGroupSpotMarketSOL, customLiqeeOwner: liqeeOwner, shouldPartialLiquidate: true, shouldFinishLiquidationInTest: false, customOrderPrice: 10, customOrderSize: 1, shouldCreateNewLiqor: false });
    const mangoGroupSpotMarketSRM = mangoGroupSpotMarkets[3]; //SRM/USDC
    await stressTestLiquidation({ mangoGroupSpotMarket: mangoGroupSpotMarketSRM, customLiqeeOwner: liqeeOwner, shouldPartialLiquidate: true, shouldFinishLiquidationInTest: false, customOrderPrice: 10, customOrderSize: 1, shouldCreateNewLiqor: false });
    const mangoGroupSpotMarketBTC = mangoGroupSpotMarkets[0]; //BTC/USDC
    await stressTestLiquidation({ mangoGroupSpotMarket: mangoGroupSpotMarketBTC, customLiqeeOwner: liqeeOwner, shouldPartialLiquidate: true, shouldFinishLiquidationInTest: true, customOrderPrice: 10, customOrderSize: 1, matchLeveragedOrder: true, shouldCreateNewLiqor: true });
  })
});

describe('create various liquidation opportunities', async() => {
  it('should create a liquidation opportunity', async() => {
    const {liqeeOwner, liqorOwner} = await stressTestLiquidation({ mangoGroupSpotMarket: mangoGroupSpotMarket, shouldPartialLiquidate: true, shouldFinishLiquidationInTest: false, customOrderPrice: 20, customOrderSize: 1, side: 'sell' });
    // const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
    // const quoteCurrencyAccountPk = await createTokenAccountWithBalance(connection, liqorOwner, 'USDC', mangoGroupTokenMappings, clusterIds.faucets, 0);
    // const baseCurrencyAmounts: number[] = [1, 2, 10, 100];
    // await Promise.all(mangoGroupSpotMarkets.map(async (mangoGroupSpotMarket: any, index: number) => {
    //   const { spotMarket, baseSymbol, minSize, minPrice } = await getSpotMarketDetails(connection, mangoGroupSpotMarket, dexProgramId);
    //   console.info(baseSymbol);
    //   const baseCurrencyAccountPk = await createTokenAccountWithBalance(connection, liqorOwner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, baseCurrencyAmounts[index]);
    //   const side = 'sell';
    //   if (!baseCurrencyAccountPk || !quoteCurrencyAccountPk) throw Error('Missing the necessary token accounts');
    //   await placeOrderUsingSerumDex(connection, liqorOwner, spotMarket, baseCurrencyAccountPk, quoteCurrencyAccountPk, { side, size: minSize, price: minPrice });
    //   // const openOrdersAccounts = await spotMarket.findOpenOrdersAccountsForOwner(connection, owner.publicKey);
    //   // const ordersForOwner = await getAndDecodeBidsAndAsksForOwner(connection, spotMarket, openOrdersAccounts[0]);
    //   // await cancelOrdersUsingSerumDex(connection, owner, spotMarket, ordersForOwner);
    //   const allOpenOrdersAccounts = await OpenOrders.findForOwner(connection, liqorOwner.publicKey, dexProgramId)
    //   console.info("All oo accs:", allOpenOrdersAccounts.length);
    // }));
  });
})

describe('create accounts for testing', async() => {
  it('should create an account with test money', async() => {
    const buyerOwner = await initAccountsWithBalances([100, 100, 500, 1000, 100000], false);
  });
  it('should fund mango group', async() => {
    const buyerOwner = await initAccountsWithBalances([100, 100, 500, 1000, 100000], false);
    const amounts = [100, 100, 500, 1000, 100000];
    const symbols = ['BTC', 'ETH', 'SOL', 'SRM', 'USDC'];
    const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
    const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
    const buyerMarginAccountPk = await client.initMarginAccount(connection, mangoProgramId, mangoGroup, buyerOwner);
    const buyerMarginAccount = await client.getMarginAccount(connection, buyerMarginAccountPk, dexProgramId);
    for (let i = 0; i < symbols.length; i++) {
      await createTokenAccountWithBalance(connection, buyerOwner, symbols[i], mangoGroupTokenMappings, clusterIds.faucets, amounts[i]);
      await performSingleDepositOrWithdrawal(connection, buyerOwner, client, mangoGroup, mangoProgramId, symbols[i], mangoGroupTokenMappings, buyerMarginAccount, 'deposit', amounts[i]);
    }
  });
  it('should create an account with initialised openOrders', async() => {
    const owner: Account = await createWalletAndRequestAirdrop(connection, 5);
    const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(connection, mangoGroupIds);
    const quoteCurrencyAccountPk = await createTokenAccountWithBalance(connection, owner, 'USDC', mangoGroupTokenMappings, clusterIds.faucets, 0);
    await Promise.all(mangoGroupSpotMarkets.map(async (mangoGroupSpotMarket: any) => {
      const { spotMarket, baseSymbol, minSize, minPrice } = await getSpotMarketDetails(connection, mangoGroupSpotMarket, dexProgramId);
      const baseCurrencyAccountPk = await createTokenAccountWithBalance(connection, owner, baseSymbol, mangoGroupTokenMappings, clusterIds.faucets, minSize);
      const side = 'sell';
      if (!baseCurrencyAccountPk || !quoteCurrencyAccountPk) throw Error('Missing the necessary token accounts');
      await placeOrderUsingSerumDex(connection, owner, spotMarket, baseCurrencyAccountPk, quoteCurrencyAccountPk, { side, size: minSize, price: minPrice });
      // const openOrdersAccounts = await spotMarket.findOpenOrdersAccountsForOwner(connection, owner.publicKey);
      // const ordersForOwner = await getAndDecodeBidsAndAsksForOwner(connection, spotMarket, openOrdersAccounts[0]);
      // await cancelOrdersUsingSerumDex(connection, owner, spotMarket, ordersForOwner);
    }));
  })
});

describe('log stuff', async() => {
  // NOTE: This part of tests is used to test and log random things
  it('should log token decimals', async() => {
    const MINT_LAYOUT = struct([blob(44), u8('decimals'), blob(37)]);
    const mainnetTokensToTest = [
      ['BTC', '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'],
      ['ETH', '2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk'],
      ['SOL', 'So11111111111111111111111111111111111111112'],
      ['SRM', 'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt'],
      ['USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
      ['USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    ];
    const devnetTokensToTest = [
      ['BTC', 'bypQzRBaSDWiKhoAw3hNkf35eF3z3AZCU8Sxks6mTPP'],
      ['ETH', 'ErWGBLBQMwdyC4H3MR8ef6pFK6gyHAyBxy4o1mHoqKzm'],
      ['SOL', 'So11111111111111111111111111111111111111112'],
      ['SRM', '9FbAMDvXqNjPqZSYt4EWTguJuDrGkfvwr3gSFpiSbX9S'],
      ['USDT', '7KBVenLz5WNH4PA5MdGkJNpDDyNKnBQTwnz1UqJv9GUm'],
      ['USDC', 'H6hy7Ykzc43EuGivv7VVuUKNpKgUoFAfUY3wdPr4UyRX'],
    ];
    for (let [tokenName, tokenMint] of mainnetTokensToTest) {
      const data: any = await mainnetConnection.getAccountInfo(new PublicKey(tokenMint));
      const info = MINT_LAYOUT.decode(data.data);
      console.info(`Mainnet ${tokenName} decimals: ${info.decimals}`);
    }
    for (let [tokenName, tokenMint] of devnetTokensToTest) {
      const data: any = await connection.getAccountInfo(new PublicKey(tokenMint));
      const info = MINT_LAYOUT.decode(data.data);
      console.info(`Devnet ${tokenName} decimals: ${info.decimals}`);
    };
  });
  it('should log lotSizes', async() => {
    const mainnetSpotMarketsToTest = [
      ['BTC/USDC', 'A8YFbxQYFVqKZaoYJLLUVcQiWP7G2MeEgW5wsAQgMvFw'],
      ['BTC/USDT', 'C1EuT9VokAKLiW7i2ASnZUvxDoKuKkCpDDeNxAptuNe4'],
      ['ETH/USDC', '4tSvZvnbyzHXLMTiFonMyxZoHmFqau1XArcRCVHLZ5gX'],
      ['SOL/USDC', '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT'],
      ['SRM/USDC', 'ByRys5tuUWDgL73G8JBAEfkdFf8JWBzPBDHsBVQ5vbQA'],
    ];
    const devnetSpotMarketsToTest = [
      ['BTC/USDC', 'BCqDfFd119UyNEC2HavKdy3F4qhy6EMGirSurNWKgioW'],
      ['ETH/USDC', 'AfB75DQs1E2VoUAMRorUxAz68b18kWZ1uqQuRibGk212'],
      ['SOL/USDC', '6vZd6Ghwkuzpbp7qNzBuRkhcfA9H3S7BJ2LCWSYrjfzo'],
      ['SRM/USDC', '6rRnXBLGzcD5v1q4NfWWZQdgBfqzEuD3g4GqDWVU8yhH'],
    ];
    for (let [spotMarketName, spotMarketAddress] of mainnetSpotMarketsToTest) {
      const spotMarket = await Market.load(mainnetConnection, new PublicKey(spotMarketAddress), { skipPreflight: true, commitment: 'singleGossip'}, mainnetDexProgramId);
      console.info(`Mainnet ${spotMarketName} base/quote lotSizes: ${spotMarket['_decoded'].baseLotSize.toString()}/${spotMarket['_decoded'].quoteLotSize.toString()}`);
      console.info(`Mainnet ${spotMarketName} baseSizeNumberToLots: ${spotMarket.baseSizeNumberToLots(1)}`);
      console.info(`Mainnet ${spotMarketName} priceNumberToLots: ${spotMarket.priceNumberToLots(1)}`);
    }
    for (let [spotMarketName, spotMarketAddress] of devnetSpotMarketsToTest) {
      const spotMarket = await Market.load(connection, new PublicKey(spotMarketAddress), { skipPreflight: true, commitment: 'singleGossip'}, dexProgramId);
      console.info(`Devnet ${spotMarketName} base/quote lotSizes: ${spotMarket['_decoded'].baseLotSize.toString()}/${spotMarket['_decoded'].quoteLotSize.toString()}`);
      console.info(`Devnet ${spotMarketName} baseSizeNumberToLots: ${spotMarket.baseSizeNumberToLots(1)}`);
      console.info(`Devnet ${spotMarketName} priceNumberToLots: ${spotMarket.priceNumberToLots(1)}`);
    }
  });
  it ('should log orderbook for spotmarket', async() => {
    const { spotMarket } = await getSpotMarketDetails(connection, mangoGroupSpotMarket, dexProgramId);
    let bna = await getAndDecodeBidsAndAsks(connection, spotMarket);
    let allAsks: any[] = [...bna.askOrderBook].map(x => ({ price: x.price, size: x.size })).reverse();
    let allBids: any[] = [...bna.bidOrderBook].map(x => ({ price: x.price, size: x.size })).reverse();
    console.info("=== allAsks ===");
    console.info(allAsks);
    console.info("=== allBids ===");
    console.info(allBids);
  });
  it ('should log margin account of private key', async() => {
    const ownerKey = [252,0,132,118,116,9,142,85,38,150,113,82,117,172,107,37,200,103,20,206,153,172,239,151,251,175,208,119,89,164,50,4,85,244,218,137,21,123,226,241,53,80,95,8,194,128,195,133,108,79,71,175,75,177,35,99,181,251,84,107,1,154,104,105];
    const owner = new Account(ownerKey);
    const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
    const marginAccount = await client.getMarginAccountsForOwner(connection, mangoProgramId, mangoGroup, owner);
    console.info(marginAccount[0].publicKey.toString());
  });
})
