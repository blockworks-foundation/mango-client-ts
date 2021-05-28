import { Balance, SimpleClient } from '../src/simpleclient';
import { Account, Connection, PublicKey } from '@solana/web3.js';
import {
  createMangoGroupSymbolMappings,
  createTokenAccountWithBalance,
  createWalletAndRequestAirdrop,
  getOrderSizeAndPrice,
  performSingleDepositOrWithdrawal,
} from './test_utils';
import { MangoClient } from '../src';
import IDS from '../src/ids.json';
import { Market } from '@project-serum/serum';
import os from 'os';
import fs from 'fs';
import expect from 'expect';

process.env.CLUSTER = 'devnet';
const marketSymbol = 'BTC/USDC';
const lowPriceThatDoesntTrigger = 1;
const keyFilePath =
  process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json';

describe('test simple client', async () => {
  (!fs.existsSync(keyFilePath) ? it : it.skip)(
    'boostrap wallet and funds for trading',
    async () => {
      async function getSpotMarketDetails(
        mangoGroupSpotMarket: any,
      ): Promise<any> {
        const [spotMarketSymbol, spotMarketAddress] = mangoGroupSpotMarket;
        const [baseSymbol, quoteSymbol] = spotMarketSymbol.split('/');
        const spotMarket = await Market.load(
          connection,
          new PublicKey(spotMarketAddress),
          { skipPreflight: true, commitment: 'singleGossip' },
          dexProgramId,
        );
        return { spotMarket, baseSymbol, quoteSymbol };
      }

      // 1. mango specific setup
      const cluster = 'devnet';
      const clusterIds = IDS[cluster];
      const dexProgramId = new PublicKey(clusterIds.dex_program_id);
      const connection = new Connection(
        IDS.cluster_urls[cluster],
        'singleGossip',
      );
      const client = new MangoClient();
      const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
      const mangoGroupName = 'BTC_ETH_SOL_SRM_USDC';
      const mangoGroupIds = clusterIds.mango_groups[mangoGroupName];
      const mangoGroupSpotMarkets: [string, string][] = Object.entries(
        mangoGroupIds.spot_market_symbols,
      );
      const mangoGroupPk = new PublicKey(mangoGroupIds.mango_group_pk);
      const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
      const mangoGroupTokenMappings = await createMangoGroupSymbolMappings(
        connection,
        mangoGroupIds,
      );

      // 2. create wallet
      let owner = await createWalletAndRequestAirdrop(connection, 100);
      fs.writeFileSync(keyFilePath, `[${owner.secretKey.toString()}]`);
      owner = new Account(JSON.parse(fs.readFileSync(keyFilePath, 'utf-8')));

      // 3. get margin accounts, if none exist then init one
      const prices = await mangoGroup.getPrices(connection);
      let marginAccounts = await client.getMarginAccountsForOwner(
        connection,
        mangoProgramId,
        mangoGroup,
        owner,
      );
      marginAccounts.sort((a, b) =>
        a.computeValue(mangoGroup, prices) > b.computeValue(mangoGroup, prices)
          ? -1
          : 1,
      );
      if (marginAccounts.length === 0) {
        await client.initMarginAccount(
          connection,
          mangoProgramId,
          mangoGroup,
          owner,
        );
        marginAccounts = await client.getMarginAccountsForOwner(
          connection,
          mangoProgramId,
          mangoGroup,
          owner,
        );
      }

      // 4. deposit usdc
      await createTokenAccountWithBalance(
        connection,
        owner,
        'USDC',
        mangoGroupTokenMappings,
        clusterIds.faucets,
        100_000,
      );
      await performSingleDepositOrWithdrawal(
        connection,
        owner,
        client,
        mangoGroup,
        mangoProgramId,
        'USDC',
        mangoGroupTokenMappings,
        marginAccounts[0],
        'deposit',
        100_000,
      );

      // 5. deposit base currency for each spot market
      for (const mangoGroupSpotMarket of mangoGroupSpotMarkets) {
        const { spotMarket, baseSymbol, quoteSymbol } =
          await getSpotMarketDetails(mangoGroupSpotMarket);
        const [orderSize, orderPrice, _] = await getOrderSizeAndPrice(
          connection,
          spotMarket,
          mangoGroupTokenMappings,
          baseSymbol,
          quoteSymbol,
          'buy',
        );
        const neededQuoteAmount = orderPrice * orderSize;
        const neededQuoteAmountForAllTrades = neededQuoteAmount * 128;
        await createTokenAccountWithBalance(
          connection,
          owner,
          baseSymbol,
          mangoGroupTokenMappings,
          clusterIds.faucets,
          neededQuoteAmountForAllTrades,
        );
        await performSingleDepositOrWithdrawal(
          connection,
          owner,
          client,
          mangoGroup,
          mangoProgramId,
          baseSymbol,
          mangoGroupTokenMappings,
          marginAccounts[0],
          'deposit',
          neededQuoteAmountForAllTrades,
        );
      }
    },
  );

  async function cleanup(sc: SimpleClient) {
    await sc.cancelOrders();
  }

  (process.env.CLUSTER === 'devnet' ? it : it.skip)(
    'clean slate for devnet',
    async () => {
      const sc = await SimpleClient.create();
      await cleanup(sc);
      const orders = await sc.getOpenOrders(marketSymbol);
      expect(orders.length).toBe(0);
    },
  );

  it('test place order', async () => {
    const sc = await SimpleClient.create();

    const ordersBeforePlacement = await sc.getOpenOrders(marketSymbol);
    expect(ordersBeforePlacement.length).toBe(0);

    await sc.placeOrder(
      marketSymbol,
      'limit',
      'buy',
      0.0001,
      lowPriceThatDoesntTrigger,
    );
    await sc.placeOrder(
      marketSymbol,
      'limit',
      'buy',
      0.0002,
      lowPriceThatDoesntTrigger,
    );
    const ordersAfterPlacement = await sc.getOpenOrders(marketSymbol);
    expect(ordersAfterPlacement.length).toBe(2);

    await cleanup(sc);
  });

  //
  it('test cancel a specific order', async () => {
    const sc = await SimpleClient.create();
    const txClientId = await sc.placeOrder(
      marketSymbol,
      'limit',
      'buy',
      0.0001,
      lowPriceThatDoesntTrigger,
    );
    const ordersBeforeCancellation = await sc.getOpenOrders(marketSymbol);

    await sc.cancelOrders(marketSymbol, txClientId);

    const ordersAfterCancellation = await sc.getOpenOrders(marketSymbol);

    expect(ordersAfterCancellation.length).toBe(
      ordersBeforeCancellation.length - 1,
    );
  });

  it('test balances', async () => {
    const sc = await SimpleClient.create();
    const balance: Balance = await sc.getBalance();
    balance.marginAccountBalances.map((marginAccountBalance) => {
      expect(marginAccountBalance.deposited).toBeGreaterThan(0);
    });
  });

  (process.env.CLUSTER === 'mainnet-beta' ? it : it.skip)(
    'test trade history',
    async () => {
      const sc = await SimpleClient.create();
      const tradeHistory = await sc.getTradeHistory(marketSymbol);
      expect(tradeHistory.length).toBeGreaterThan(0);
    },
  );

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

  (process.env.CLUSTER === 'mainnet-beta' ? it : it.skip)('pnl', async () => {
    const sc = await SimpleClient.create();
    const pnl = await sc.getPnl();
    expect(pnl).toBeGreaterThan(0);
  });
});
