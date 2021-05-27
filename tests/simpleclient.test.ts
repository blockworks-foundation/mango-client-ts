import { Balance, SimpleClient } from '../src/simpleclient';

import expect from 'expect';

process.env.CLUSTER = 'devnet';
const marketSymbol = 'BTC/USDC';

describe('test simple client', async () => {
  // it('boostrap account with funds for tokens', async () => {
  //   const keyPairPath =
  //     process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json';
  //
  //   const cluster = 'devnet';
  //   const clusterIds = IDS[cluster];
  //   const dexProgramId = new PublicKey(clusterIds.dex_program_id);
  //   const connection = new Connection(
  //     IDS.cluster_urls[cluster],
  //     'singleGossip',
  //   );
  //   const client = new MangoClient();
  //   const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
  //
  //   const mangoGroupName = 'BTC_ETH_SOL_SRM_USDC';
  //   const mangoGroupIds = clusterIds.mango_groups[mangoGroupName];
  //   const mangoGroupSpotMarkets: [string, string][] = Object.entries(
  //     mangoGroupIds.spot_market_symbols,
  //   );
  //   const mangoGroupPk = new PublicKey(mangoGroupIds.mango_group_pk);
  //   const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  //
  //   const buyerOwner = new Account(
  //     JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')),
  //   );
  //   const prices = await mangoGroup.getPrices(connection);
  //   const marginAccounts = await client.getMarginAccountsForOwner(
  //     connection,
  //     mangoProgramId,
  //     mangoGroup,
  //     buyerOwner,
  //   );
  //   marginAccounts.sort((a, b) =>
  //     a.computeValue(mangoGroup, prices) > b.computeValue(mangoGroup, prices)
  //       ? -1
  //       : 1,
  //   );
  //
  //   async function getSpotMarketDetails(
  //     mangoGroupSpotMarket: any,
  //   ): Promise<any> {
  //     const [spotMarketSymbol, spotMarketAddress] = mangoGroupSpotMarket;
  //     const [baseSymbol, quoteSymbol] = spotMarketSymbol.split('/');
  //     const spotMarket = await Market.load(
  //       connection,
  //       new PublicKey(spotMarketAddress),
  //       { skipPreflight: true, commitment: 'singleGossip' },
  //       dexProgramId,
  //     );
  //     return { spotMarket, baseSymbol, quoteSymbol };
  //   }
  //
  //   const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(
  //     connection,
  //     mangoGroupIds,
  //   );
  //
  //   // deposit usdc
  //     await createTokenAccountWithBalance(
  //       connection,
  //       buyerOwner,
  //       "USDC",
  //       mangoGroupTokenMappings,
  //       clusterIds.faucets,
  //       100_000,
  //     );
  //   await performSingleDepositOrWithdrawal(
  //     connection,
  //     buyerOwner,
  //     client,
  //     mangoGroup,
  //     mangoProgramId,
  //     "USDC",
  //     mangoGroupTokenMappings,
  //     marginAccounts[0],
  //     'deposit',
  //     100_000,
  //   );
  //
  //   // deposit base currency for each spot market
  //   for (let i = 0; i < mangoGroupSpotMarkets.length; i++) {
  //     const mangoGroupSpotMarket = mangoGroupSpotMarkets[i];
  //     const { spotMarket, baseSymbol, quoteSymbol } =
  //       await getSpotMarketDetails(mangoGroupSpotMarket);
  //     const [orderSize, orderPrice, _] = await getOrderSizeAndPrice(
  //       connection,
  //       spotMarket,
  //       mangoGroupTokenMappings,
  //       baseSymbol,
  //       quoteSymbol,
  //       'buy',
  //     );
  //     const neededQuoteAmount = orderPrice * orderSize;
  //     const neededQuoteAmountForAllTrades = neededQuoteAmount * 128;
  //     await createTokenAccountWithBalance(
  //       connection,
  //       buyerOwner,
  //       baseSymbol,
  //       mangoGroupTokenMappings,
  //       clusterIds.faucets,
  //       neededQuoteAmountForAllTrades,
  //     );
  //
  //     await performSingleDepositOrWithdrawal(
  //       connection,
  //       buyerOwner,
  //       client,
  //       mangoGroup,
  //       mangoProgramId,
  //       baseSymbol,
  //       mangoGroupTokenMappings,
  //       marginAccounts[0],
  //       'deposit',
  //       neededQuoteAmountForAllTrades,
  //     );
  //   }
  // });

  it('test place order', async () => {
    const sc = await SimpleClient.create();
    await sc.cancelOrders();
    await sc.placeOrder(marketSymbol, 'buy', 0.0001, 10000);
    await sc.placeOrder(marketSymbol, 'sell', 0.0001, 90000);
    const ordersAfterPlacement = await sc.getOpenOrders(marketSymbol);
    expect(ordersAfterPlacement.length).toBe(2);
  });

  it('test cancel a specific order', async () => {
    const sc = await SimpleClient.create();
    await sc.cancelOrders();
    await sc.placeOrder(marketSymbol, 'buy', 0.0001, 48000);
    const ordersAfterPlacement = await sc.getOpenOrders(marketSymbol);
    await sc.cancelOrders(
      marketSymbol,
      ordersAfterPlacement[0].orderId.toString(),
    );
    const ordersAfterCancellation = await sc.getOpenOrders(marketSymbol);
    expect(ordersAfterCancellation.length).toBe(0);
  });

  it('test cancel orders', async () => {
    const sc = await SimpleClient.create();
    await sc.placeOrder(marketSymbol, 'buy', 0.0001, 48000);
    await sc.placeOrder(marketSymbol, 'buy', 0.0001, 48000);
    await sc.cancelOrders();
    const ordersAfterCancellation = await sc.getOpenOrders(marketSymbol);
    expect(ordersAfterCancellation.length).toBe(0);
  });

  it('test balances', async () => {
    const sc = await SimpleClient.create();
    const balances: Balance[] = await sc.getBalances();
    balances.map((balance) => {
      balance.marginAccountBalances.map((marginAccountBalance) => {
        expect(marginAccountBalance.deposited).toBeGreaterThan(0);
      });
    });
  });

  it('test trade history', async () => {
    const sc = await SimpleClient.create();
    const tradeHistory = await sc.getTradeHistory(marketSymbol);
    expect(tradeHistory.length).toBeGreaterThan(0);
  });

  it('test tickers', async () => {
    const sc = await SimpleClient.create();
    const tickers = await sc.getTickers();
    expect(tickers.length).toBeGreaterThan(0);
  });

  it('test ohlcv', async () => {
    const sc = await SimpleClient.create();
    const to = Date.now();
    const yday = to - 24 * 60 * 60 * 1000;
    const ohlcvs = await sc.getOhlcv(marketSymbol, '1D', yday, to);
    expect(ohlcvs.length).toBeGreaterThan(0);
  });
});
