import { MangoClient, MarginAccount } from './client';
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
import { MangoGroup } from '../lib';
import { Order } from '@project-serum/serum/lib/market';
import { nativeToUi } from './utils';
import BN from 'bn.js';
import fetch from 'node-fetch';

// github issue - https://github.com/blockworks-foundation/mango-client-ts/issues/14

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
    public marginAccountPublicKey: PublicKey,
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

function ceilToDecimal(value: number, decimals: number | undefined | null) {
  return decimals
    ? Math.ceil(value * 10 ** decimals) / 10 ** decimals
    : Math.ceil(value);
}

type TokenSymbol = string;
type SpotMarketSymbol = string;

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

function notEmpty<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined;
}

/**
 * a simpler more cex-style client with sensible (hopefully ;)) defaults
 */
export class SimpleClient {
  private constructor(
    private client: MangoClient,
    private connection: Connection,
    private programId: PublicKey,
    private mangoGroup: MangoGroup,
    private markets: Market[],
    private mangoGroupTokenMappings: Map<TokenSymbol, PublicKey>,
    private spotMarketMappings: Map<SpotMarketSymbol, PublicKey>,
    private payer: Account,
  ) {}

  public static async create() {
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
      mangoGroup,
      markets,
      mangoGroupTokenMappings,
      mangoGroupSportMarketMappings,
      payer,
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

  private async getMarginAccountsForOwner(): Promise<MarginAccount[]> {
    const prices = await this.mangoGroup.getPrices(this.connection);
    const marginAccounts = await this.client.getMarginAccountsForOwner(
      this.connection,
      this.programId,
      this.mangoGroup,
      this.payer,
    );
    return marginAccounts.sort((a, b) =>
      a.computeValue(this.mangoGroup, prices) >
      b.computeValue(this.mangoGroup, prices)
        ? -1
        : 1,
    );
  }

  // todo: is the name misleading? should it be just
  // getOrdersAccountForSymbol or getAccountForSymbol?
  private async getOpenOrdersAccountForSymbol(
    marketSymbol: SpotMarketSymbol,
  ): Promise<OpenOrders[]> {
    if (Object.keys(this.spotMarketMappings).indexOf(marketSymbol) === -1) {
      throw new Error(`unknown spot market ${marketSymbol}`);
    }
    const marketAddress = this.spotMarketMappings[marketSymbol];
    const market = this.markets.find((market) =>
      market.publicKey.equals(marketAddress),
    );

    const marketIndex = this.mangoGroup.getMarketIndex(market!);
    const marginAccounts = await this.getMarginAccountsForOwner();
    return marginAccounts
      .map((marginAccount) => marginAccount.openOrdersAccounts[marketIndex])
      .filter(notEmpty);
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
    orderId?: string,
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
    // note: orderId could not even belong to his margin account
    // in that case ordersToCancel would be empty
    const ordersToCancel = orderId
      ? orders.filter((o) => o.orderId.toString() === orderId)
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
    side: 'buy' | 'sell',
    quantity: number,
    price: number,
  ): Promise<TransactionSignature> {
    if (!symbol.trim()) {
      throw new Error(`invalid symbol ${symbol}`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`invalid quantity ${quantity}`);
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`invalid price ${price}`);
    }

    const market = this.getMarketForSymbol(symbol);

    const marginAccounts = await this.getMarginAccountsForOwner();
    // todo: rather choose margin account with largest balance for base or
    // quote currency based on trade side
    const marginAccountWithLargestBalance = marginAccounts[0];

    return this.client.placeOrder(
      this.connection,
      this.programId,
      this.mangoGroup,
      marginAccountWithLargestBalance,
      market,
      this.payer,
      side,
      price,
      quantity,
    );
  }

  async getOpenOrders(
    symbol: SpotMarketSymbol,
    orderId?: string,
  ): Promise<Order[]> {
    const openOrderAccounts = await this.getOpenOrdersAccountForSymbol(symbol);
    const orders: Order[] = await this.getOrderBook(symbol);

    orders.filter((o) =>
      openOrderAccounts.find((account) =>
        account?.address.equals(o.openOrdersAddress),
      ),
    );

    if (orderId) {
      return orders.filter((o) => o.orderId.toString() === orderId);
    }

    return orders;
  }

  async cancelOrders(symbol?: SpotMarketSymbol, orderId?: string) {
    const marginAccounts = await this.getMarginAccountsForOwner();
    for (const marginAccount of marginAccounts) {
      await this.cancelOrdersForMarginAccount(marginAccount, symbol, orderId);
    }
  }

  async getTradeHistory(symbol: SpotMarketSymbol): Promise<Order[]> {
    if (!symbol.trim()) {
      throw new Error(`invalid symbol ${symbol}`);
    }
    const market = this.getMarketForSymbol(symbol);

    const fills = await market.loadFills(this.connection, 10_000);
    const filteredFills = fills.filter((fill) => fill && fill.openOrders);
    const openOrdersAccountForSymbol = await this.getOpenOrdersAccountForSymbol(
      symbol,
    );
    const openOrderAccounts = openOrdersAccountForSymbol.filter(
      (account) => account && account.address,
    );
    return filteredFills.filter((fill) =>
      openOrderAccounts.find(
        (account) => account!.address.equals(fill.openOrders) !== undefined,
      ),
    );
  }

  /**
   * returns balances, simple and mango specific details
   */
  async getBalances(): Promise<Balance[]> {
    const marginAccounts = await this.getMarginAccountsForOwner();
    return marginAccounts.map((marginAccount) => {
      const marginAccountBalances = Object.keys(
        this.mangoGroupTokenMappings,
      ).map((tokenSymbol) => {
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
      });

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

        const tokenIndex = this.mangoGroup.getTokenIndex(
          market.baseMintAddress,
        );
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
        marginAccount.publicKey,
        marginAccountBalances,
        marketBalances,
      );
    });
  }

  async getPnl() {
    // todo
    throw new Error('not implemented');
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
}
