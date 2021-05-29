import { MangoClient, MangoGroup, MarginAccount } from './client';
import IDS from './ids.json';
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  TransactionSignature,
} from '@solana/web3.js';
import os from 'os';
import fs from 'fs';
import { Market, OpenOrders, Orderbook } from '@project-serum/serum';
import { Order } from '@project-serum/serum/lib/market';
import { ceilToDecimal, groupBy, nativeToUi, uid } from './utils';
import BN from 'bn.js';
import fetch from 'node-fetch';

// github issue - https://github.com/blockworks-foundation/mango-client-ts/issues/14

type TokenSymbol = string;
type SpotMarketSymbol = string;
type OpenOrdersAsString = string;

interface OpenOrderForPnl {
  nativeQuantityReleased: number;
  nativeQuantityPaid: number;
  side: 'sell' | 'buy';
  size: number;
  openOrders: OpenOrdersAsString;
}

export class MarketBalance {
  constructor(
    public baseTokenSymbol: string,
    public orders: number,
    public unsettled: number,
    public quoteTokenSymbol: string,
    public quoteOrders: number,
    public quoteUnsettled: number,
  ) {}
}

export class MarginAccountBalance {
  constructor(
    public tokenSymbol: string,
    public deposited: number,
    public borrowed: number,
  ) {}
}

export class Balance {
  constructor(
    public marginAccountPublicKey: string,
    public marginAccountBalances: MarginAccountBalance[],
    public marketBalances: MarketBalance[],
  ) {}
}

export class FetchMarketSymbol {
  constructor(public symbol: string) {}
}

export class FetchMarket {
  constructor(public symbols: FetchMarketSymbol[]) {}
}

export class Ticker {
  constructor(
    public symbol: string,
    public price: number,
    public timeMs: number,
  ) {}
}

export class Ohlcv {
  constructor(
    public timeS: number,
    public open: number,
    public high: number,
    public low: number,
    public close: number,
    public volume: number,
  ) {}
}

type Resolution =
  | '1'
  | '3'
  | '5'
  | '15'
  | '30'
  | '60'
  | '120'
  | '180'
  | '240'
  | '1D';

/**
 * a simpler more cex-style client with sensible (hopefully ;)) defaults
 */
export class SimpleClient {
  private constructor(
    private client: MangoClient,
    private connection: Connection,
    private programId: PublicKey,
    private dexProgramId: PublicKey,
    private mangoGroup: MangoGroup,
    private markets: Market[],
    private mangoGroupTokenMappings: Map<TokenSymbol, PublicKey>,
    private spotMarketMappings: Map<SpotMarketSymbol, PublicKey>,
    private payer: Account,
    private marginAccountPk: string,
  ) {}

  public static async create(marginAccountPk: string) {
    const cluster = process.env.CLUSTER || 'mainnet-beta';
    const mangoGroupName = 'BTC_ETH_SOL_SRM_USDC';

    const clusterIds = IDS[cluster];
    const programId = new PublicKey(IDS[cluster].mango_program_id);
    const dexProgramId = new PublicKey(clusterIds.dex_program_id);
    const mangoGroupIds = clusterIds.mango_groups[mangoGroupName];

    // connection
    const connection = new Connection(
      IDS.cluster_urls[cluster],
      'processed' as Commitment,
    );

    // client
    const client = new MangoClient();

    // payer
    const keyPairPath =
      process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json';
    const payer = new Account(
      JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')),
    );

    // mangoGroup
    const mangoGroupPk = new PublicKey(
      clusterIds.mango_groups[mangoGroupName].mango_group_pk,
    );
    const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);

    // markets
    const markets = await Promise.all(
      mangoGroup.spotMarkets.map((pk) =>
        Market.load(
          connection,
          pk,
          { skipPreflight: true, commitment: 'singleGossip' },
          dexProgramId,
        ),
      ),
    );

    // token mappings
    const mangoGroupTokenMappings = new Map<TokenSymbol, PublicKey>();
    const mangoGroupSymbols: [string, string][] = Object.entries(
      mangoGroupIds.symbols,
    );
    for (const [tokenName, tokenMint] of mangoGroupSymbols) {
      mangoGroupTokenMappings[tokenName] = new PublicKey(tokenMint);
    }

    // market mappings
    const mangoGroupSportMarketMappings = new Map<
      SpotMarketSymbol,
      PublicKey
    >();
    const mangoGroupSpotMarketSymbols: [SpotMarketSymbol, string][] =
      Object.entries(mangoGroupIds.spot_market_symbols);
    for (const [spotMarketSymbol, address] of mangoGroupSpotMarketSymbols) {
      mangoGroupSportMarketMappings[spotMarketSymbol] = new PublicKey(address);
    }

    return new SimpleClient(
      client,
      connection,
      programId,
      dexProgramId,
      mangoGroup,
      markets,
      mangoGroupTokenMappings,
      mangoGroupSportMarketMappings,
      payer,
      marginAccountPk,
    );
  }

  /// private

  private getMarketForSymbol(marketSymbol: SpotMarketSymbol): Market {
    if (Object.keys(this.spotMarketMappings).indexOf(marketSymbol) === -1) {
      throw new Error(`unknown spot market ${marketSymbol}`);
    }
    const marketAddress = this.spotMarketMappings[marketSymbol];
    const market = this.markets.find((market) =>
      market.publicKey.equals(marketAddress),
    );
    if (market === undefined) {
      throw new Error(`market not found for ${market}`);
    }
    return market;
  }

  private async getMarginAccountForOwner(): Promise<MarginAccount> {
    return await this.client.getMarginAccount(
      this.connection,
      new PublicKey(this.marginAccountPk),
      this.dexProgramId,
    );
  }

  private async getOpenOrdersAccountForSymbol(
    marketSymbol: SpotMarketSymbol,
  ): Promise<OpenOrders | undefined> {
    const market = this.getMarketForSymbol(marketSymbol);
    const marketIndex = this.mangoGroup.getMarketIndex(market!);
    const marginAccount = await this.getMarginAccountForOwner();
    return marginAccount.openOrdersAccounts[marketIndex];
  }

  private async cancelOrder(
    marginAccount: MarginAccount,
    market: Market,
    order: Order,
  ): Promise<TransactionSignature> {
    return this.client.cancelOrder(
      this.connection,
      this.programId,
      this.mangoGroup,
      marginAccount,
      this.payer,
      market,
      order,
    );
  }

  private async cancelOrdersForMarginAccount(
    marginAccount: MarginAccount,
    symbol?: SpotMarketSymbol,
    clientId?: string,
  ) {
    let orders;
    let market;

    if (symbol === undefined) {
      for (const spotMarketSymbol of Object.keys(this.spotMarketMappings)) {
        market = this.getMarketForSymbol(spotMarketSymbol);
        orders = await this.getOpenOrders(spotMarketSymbol);
        await orders.map((order) =>
          this.cancelOrder(marginAccount, market, order),
        );
      }
      return;
    }

    market = this.getMarketForSymbol(symbol!);
    orders = await this.getOpenOrders(symbol!);
    // note: clientId could not even belong to his margin account
    // in that case ordersToCancel would be empty
    const ordersToCancel =
      clientId !== undefined
        ? orders.filter((o) => o.clientId.toString() === clientId)
        : orders;

    await Promise.all(
      ordersToCancel.map((order) =>
        this.cancelOrder(marginAccount, market, order),
      ),
    );
  }

  /// public

  async placeOrder(
    symbol: SpotMarketSymbol,
    type: 'market' | 'limit',
    side: 'buy' | 'sell',
    quantity: number,
    price?: number,
    orderType?: 'ioc' | 'postOnly' | 'limit',
  ): Promise<string> {
    if (!symbol.trim()) {
      throw new Error(`invalid symbol ${symbol}`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`invalid quantity ${quantity}`);
    }
    if ((type === 'limit' && !Number.isFinite(price)) || price! <= 0) {
      throw new Error(`invalid price ${price}`);
    }

    if (type === 'market') {
      const orderBook = await this.getOrderBook(symbol);
      let acc = 0;
      let selectedOrder;
      for (const order of orderBook) {
        acc += order.size;
        if (acc >= quantity) {
          selectedOrder = order;
          break;
        }
      }

      if (side === 'buy') {
        price = selectedOrder.price * 1.05;
      } else {
        price = selectedOrder.price * 0.95;
      }
    }

    const market = this.getMarketForSymbol(symbol);

    const marginAccount = await this.getMarginAccountForOwner();

    const clientId = new BN(uid());

    orderType = orderType === undefined ? 'limit' : orderType;

    await this.client.placeOrder(
      this.connection,
      this.programId,
      this.mangoGroup,
      marginAccount,
      market,
      this.payer,
      side,
      price!,
      quantity,
      orderType,
      clientId,
    );

    return clientId.toString();
  }

  async getOpenOrders(
    symbol: SpotMarketSymbol,
    clientId?: string,
  ): Promise<Order[]> {
    const openOrderAccount = await this.getOpenOrdersAccountForSymbol(symbol);
    if (openOrderAccount === undefined) {
      return [];
    }

    let orders: Order[] = await this.getOrderBook(symbol);
    orders = orders.filter((o) =>
      openOrderAccount.address.equals(o.openOrdersAddress),
    );

    if (clientId) {
      return orders.filter(
        (o) => o.clientId && o.clientId.toString() === clientId,
      );
    }

    return orders;
  }

  async cancelOrders(symbol?: SpotMarketSymbol, clientId?: string) {
    const marginAccount = await this.getMarginAccountForOwner();
    await this.cancelOrdersForMarginAccount(marginAccount, symbol, clientId);
  }

  async getTradeHistory(symbol: SpotMarketSymbol): Promise<OpenOrderForPnl[]> {
    if (!symbol.trim()) {
      throw new Error(`invalid symbol ${symbol}`);
    }

    const openOrdersAccount = await this.getOpenOrdersAccountForSymbol(symbol);
    if (openOrdersAccount === undefined) {
      return [];
    }

    // e.g. https://stark-fjord-45757.herokuapp.com/trades/open_orders/G5rZ4Qfv5SxpJegVng5FuZftDrJkzLkxQUNjEXuoczX5
    //     {
    //         "id": 2267328,
    //         "loadTimestamp": "2021-04-28T03:36:20.573Z",
    //         "address": "C1EuT9VokAKLiW7i2ASnZUvxDoKuKkCpDDeNxAptuNe4",
    //         "programId": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    //         "baseCurrency": "BTC",
    //         "quoteCurrency": "USDT",
    //         "fill": true,
    //         "out": false,
    //         "bid": false,
    //         "maker": false,
    //         "openOrderSlot": "6",
    //         "feeTier": "0",
    //         "nativeQuantityReleased": "93207112",
    //         "nativeQuantityPaid": "1700",
    //         "nativeFeeOrRebate": "205508",
    //         "orderId": "9555524110645989995606320",
    //         "openOrders": "G5rZ4Qfv5SxpJegVng5FuZftDrJkzLkxQUNjEXuoczX5",
    //         "clientOrderId": "0",
    //         "uuid": "0040cdbdb0667fd5f75c2538e4097c5090e7b15d8cf9a5e7db7a54c3c212d27a",
    //         "source": "1",
    //         "baseTokenDecimals": 6,
    //         "quoteTokenDecimals": 6,
    //         "side": "sell",
    //         "price": 54948.6,
    //         "feeCost": 0.205508,
    //         "size": 0.0017
    //     }
    const response = await fetch(
      `https://stark-fjord-45757.herokuapp.com/trades/open_orders/${openOrdersAccount.address.toBase58()}`,
    );
    const parsedResponse = await response.json();
    const trades: OpenOrderForPnl[] = parsedResponse?.data
      ? parsedResponse.data
      : [];
    return trades
      .filter((trade) =>
        openOrdersAccount.address.equals(new PublicKey(trade.openOrders)),
      )
      .map((trade) => ({ ...trade, marketName: symbol }));
  }

  /**
   * returns balances, simple and mango specific details
   */
  async getBalance(): Promise<Balance> {
    const marginAccount = await this.getMarginAccountForOwner();

    const marginAccountBalances = Object.keys(this.mangoGroupTokenMappings).map(
      (tokenSymbol) => {
        const tokenIndex = this.mangoGroup.getTokenIndex(
          this.mangoGroupTokenMappings[tokenSymbol],
        );

        const decimals = this.mangoGroup.mintDecimals[tokenIndex];
        const uiDeposit = marginAccount.getUiDeposit(
          this.mangoGroup,
          tokenIndex,
        );
        const uiDepositDisplay = ceilToDecimal(uiDeposit, decimals);
        const uiBorrow = marginAccount.getUiBorrow(this.mangoGroup, tokenIndex);
        const uiBorrowDisplay = ceilToDecimal(uiBorrow, decimals);

        return new MarginAccountBalance(
          tokenSymbol,
          uiDepositDisplay,
          uiBorrowDisplay,
        );
      },
    );

    const marketBalances = this.mangoGroup.spotMarkets.map((marketPk) => {
      const market = this.markets.find((market) =>
        market.publicKey.equals(marketPk),
      );
      if (market === undefined) {
        throw new Error(`market for ${marketPk.toBase58()} not found`);
      }

      const token = Object.entries(this.mangoGroupTokenMappings).find(
        (entry) => {
          return entry[1].equals(market.baseMintAddress);
        },
      );

      const tokenIndex = this.mangoGroup.getTokenIndex(market.baseMintAddress);
      const openOrders: OpenOrders =
        marginAccount.openOrdersAccounts[tokenIndex]!;
      const nativeBaseFree = openOrders?.baseTokenFree || new BN(0);
      const nativeBaseLocked = openOrders
        ? openOrders.baseTokenTotal.sub(nativeBaseFree)
        : new BN(0);
      const nativeBaseUnsettled = openOrders?.baseTokenFree || new BN(0);
      const orders = nativeToUi(
        nativeBaseLocked.toNumber(),
        this.mangoGroup.mintDecimals[tokenIndex],
      );
      const unsettled = nativeToUi(
        nativeBaseUnsettled.toNumber(),
        this.mangoGroup.mintDecimals[tokenIndex],
      );

      const quoteToken = Object.entries(this.mangoGroupTokenMappings).find(
        (entry) => {
          return entry[1].equals(market.quoteMintAddress);
        },
      );
      const quoteCurrencyIndex = this.mangoGroup.getTokenIndex(
        market.quoteMintAddress,
      );
      const nativeQuoteFree = openOrders?.quoteTokenFree || new BN(0);
      const nativeQuoteLocked = openOrders
        ? openOrders!.quoteTokenTotal.sub(nativeQuoteFree)
        : new BN(0);
      const nativeQuoteUnsettled = openOrders?.quoteTokenFree || new BN(0);
      const ordersQuote = nativeToUi(
        nativeQuoteLocked.toNumber(),
        this.mangoGroup.mintDecimals[quoteCurrencyIndex],
      );
      const unsettledQuote = nativeToUi(
        nativeQuoteUnsettled.toNumber(),
        this.mangoGroup.mintDecimals[quoteCurrencyIndex],
      );

      return new MarketBalance(
        token![0],
        orders,
        unsettled,
        quoteToken![0],
        ordersQuote,
        unsettledQuote,
      );
    });

    return new Balance(
      marginAccount.publicKey.toBase58(),
      marginAccountBalances,
      marketBalances,
    );
  }

  async getPnl() {
    // grab trade history
    let tradeHistory: OpenOrderForPnl[] = [];
    for (const [spotMarketSymbol, unused] of Object.entries(
      this.spotMarketMappings,
    )) {
      const tradeHistoryForSymbol = await this.getTradeHistory(
        spotMarketSymbol,
      );
      tradeHistory = tradeHistory.concat(tradeHistoryForSymbol);
    }

    const profitAndLoss = {};

    // compute profit and loss for all markets
    const groupedTrades = groupBy(tradeHistory, (trade) => trade.marketName);
    groupedTrades.forEach((val, key) => {
      profitAndLoss[key] = val.reduce(
        (acc, current) =>
          (current.side === 'sell' ? current.size * -1 : current.size) + acc,
        0,
      );
    });

    // compute profit and loss for usdc
    const totalNativeUsdc = tradeHistory.reduce((acc, current) => {
      const usdcAmount =
        current.side === 'sell'
          ? current.nativeQuantityReleased
          : current.nativeQuantityPaid * -1;
      return usdcAmount + acc;
    }, 0);
    (profitAndLoss as any).USDC = nativeToUi(
      totalNativeUsdc,
      this.mangoGroup.mintDecimals[2],
    );

    // compute final pnl
    let total = 0;
    const prices = await this.mangoGroup.getPrices(this.connection);
    const assetIndex = {
      'BTC/USDC': 0,
      'BTC/WUSDC': 0,
      'ETH/USDC': 1,
      'ETH/WUSDC': 1,
      'SOL/USDC': 1,
      'SOL/WUSDC': 1,
      'SRM/USDC': 1,
      'SRM/WUSDC': 1,
      USDC: 2,
      WUSDC: 2,
    };
    for (const assetName of Object.keys(profitAndLoss)) {
      total = total + profitAndLoss[assetName] * prices[assetIndex[assetName]];
    }

    return total.toFixed(2);
  }

  /**
   * returns available markets
   */
  async getMarkets(): Promise<FetchMarket> {
    const fetchMarketSymbols = Object.keys(this.spotMarketMappings).map(
      (spotMarketSymbol) => new FetchMarketSymbol(spotMarketSymbol),
    );
    return new FetchMarket(fetchMarketSymbols);
  }

  /**
   * returns tickers i.e. symbol, closing price, time of closing price
   */
  async getTickers(symbol?: SpotMarketSymbol): Promise<Ticker[]> {
    let ohlcvs;
    let latestOhlcv;

    const to = Date.now();
    // use a sufficiently large window to ensure that we get data back
    const toMinus20Mins = to - 20 * 60 * 1000;
    const oneMinute = '1';

    if (symbol === undefined) {
      const tickers: Ticker[] = [];
      for (const zymbol of Object.keys(this.spotMarketMappings)) {
        ohlcvs = await this.getOhlcv(zymbol, oneMinute, toMinus20Mins, to);
        latestOhlcv = ohlcvs[ohlcvs.length - 1];
        tickers.push(
          new Ticker(zymbol, latestOhlcv.close, latestOhlcv.timeS * 1000),
        );
      }
      return tickers;
    }

    ohlcvs = await this.getOhlcv(symbol, oneMinute, toMinus20Mins, to);
    latestOhlcv = ohlcvs[ohlcvs.length - 1];
    return [new Ticker(symbol, latestOhlcv.close, latestOhlcv.timeS * 1000)];
  }

  async getOrderBook(symbol: SpotMarketSymbol): Promise<Order[]> {
    const market = this.getMarketForSymbol(symbol);

    const bidData = (await this.connection.getAccountInfo(market.bidsAddress))
      ?.data;
    const bidOrderBook = bidData
      ? Orderbook.decode(market, Buffer.from(bidData))
      : [];
    const askData = (await this.connection.getAccountInfo(market.asksAddress))
      ?.data;
    const askOrderBook = askData
      ? Orderbook.decode(market, Buffer.from(askData))
      : [];
    return [...bidOrderBook, ...askOrderBook];
  }

  /**
   * returns ohlcv in ascending order for time
   */
  async getOhlcv(
    spotMarketSymbol: SpotMarketSymbol,
    resolution: Resolution,
    fromEpochMs: number,
    toEpochMs: number,
  ): Promise<Ohlcv[]> {
    const response = await fetch(
      `https://serum-history.herokuapp.com/tv/history` +
        `?symbol=${spotMarketSymbol}&resolution=${resolution}` +
        `&from=${fromEpochMs / 1000}&to=${toEpochMs / 1000}`,
    );
    const { t, o, h, l, c, v } = await response.json();
    const ohlcvs: Ohlcv[] = [];
    for (let i = 0; i < t.length; i++) {
      ohlcvs.push(new Ohlcv(t[i], o[i], h[i], l[i], c[i], v[i]));
    }
    return ohlcvs;
  }

  // async debug() {
  //   const marginAccountForOwner = await this.getMarginAccountForOwner();
  //   console.log(
  //     `margin account - ${marginAccountForOwner.publicKey.toBase58()}`,
  //   );
  //
  //   const balance = await this.getBalance();
  //   balance.marginAccountBalances.map((bal) => {
  //     console.log(
  //       ` - balance for ${bal.tokenSymbol}, deposited ${bal.deposited}, borrowed ${bal.borrowed}`,
  //     );
  //   });
  //
  //   for (const symbol of Object.keys(this.spotMarketMappings)) {
  //     const openOrdersAccountForSymbol =
  //       await this.getOpenOrdersAccountForSymbol(symbol);
  //     if (openOrdersAccountForSymbol === undefined) {
  //       continue;
  //     }
  //     console.log(
  //       ` - symbol ${symbol}, open orders account ${openOrdersAccountForSymbol?.publicKey.toBase58()}`,
  //     );
  //
  //     const openOrders = await this.getOpenOrders(symbol);
  //     if (openOrders === undefined) {
  //       continue;
  //     }
  //     for (const order of openOrders) {
  //       console.log(`  - orderId  ${order.orderId}, clientId ${order.clientId}`);
  //     }
  //   }
  // }
}

async function test() {
  process.env.CLUSTER = 'devnet';
  const sc = await SimpleClient.create(
    'tBhXVv9JVJL8tApoBxEcKEgs7Ngd1FgdYGwBTarN4Ux',
  );
  console.log(JSON.stringify(await sc.getBalance(), null, 2));
}

test();
