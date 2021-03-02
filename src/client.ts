import {
  Account,
  Connection,
  PublicKey,
  sendAndConfirmRawTransaction,
  SimulatedTransactionResponse,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
} from '@solana/web3.js';
import {
  encodeMangoInstruction,
  MangoGroupLayout,
  MarginAccountLayout,
  MAX_RATE,
  NUM_MARKETS,
  NUM_TOKENS,
  OPTIMAL_RATE,
  OPTIMAL_UTIL,
  WideBits,
} from './layout';
import BN from 'bn.js';
import {
  awaitTransactionSignatureConfirmation,
  createAccountInstruction,
  getFilteredProgramAccounts,
  getUnixTs,
  nativeToUi,
  parseTokenAccountData,
  promiseUndef,
  simulateTransaction,
  sleep,
  uiToNative,
  zeroKey,
} from './utils';
import { getFeeRates, getFeeTier, Market, OpenOrders, Orderbook } from '@project-serum/serum';
import { SRM_DECIMALS } from '@project-serum/serum/lib/token-instructions';
import { Order } from '@project-serum/serum/lib/market';
import Wallet from '@project-serum/sol-wallet-adapter';
import { makeCancelOrderInstruction, makeSettleFundsInstruction } from './instruction';
import { Aggregator } from './schema';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';


export class MangoGroup {
  publicKey: PublicKey;

  accountFlags!: WideBits;
  tokens!: PublicKey[];
  vaults!: PublicKey[];
  indexes!: { lastUpdate: BN, borrow: number, deposit: number };
  spotMarkets!: PublicKey[];
  oracles!: PublicKey[];
  signerNonce!: BN;
  signerKey!: PublicKey;
  dexProgramId!: PublicKey;
  totalDeposits!: number[];
  totalBorrows!: number[];
  maintCollRatio!: number;
  initCollRatio!: number;
  srmVault!: PublicKey;
  admin!: PublicKey;
  borrowLimits!: number[];
  mintDecimals!: number[];
  oracleDecimals!: number[];

  nativeSrm: number | null;
  constructor(publicKey: PublicKey, decoded: any, nativeSrm?: number) {
    this.publicKey = publicKey
    Object.assign(this, decoded)
    if (nativeSrm) {
      this.nativeSrm = nativeSrm
    } else {
      this.nativeSrm = null
    }
  }

  async getPrices(
    connection: Connection,
  ): Promise<number[]>  {

    const aggs = await Promise.all(this.oracles.map((pk) => (Aggregator.loadWithConnection(pk, connection))))
    return aggs.map((agg) => (agg.answer.median.toNumber() / Math.pow(10, agg.config.decimals))).concat(1.0)
  }

  getMarketIndex(spotMarket: Market): number {
    for (let i = 0; i < this.spotMarkets.length; i++) {
      if (this.spotMarkets[i].equals(spotMarket.publicKey)) {
        return i
      }
    }
    throw new Error("This Market does not belong to this MangoGroup")
  }

  getTokenIndex(token: PublicKey): number {
    for (let i = 0; i < this.tokens.length; i++) {
      if (this.tokens[i].equals(token)) {
        return i
      }
    }
    throw new Error("This token does not belong in this MangoGroup")
  }

  getBorrowRate(tokenIndex: number): number {

    const totalBorrows = this.getUiTotalBorrow(tokenIndex)
    const totalDeposits = this.getUiTotalDeposit(tokenIndex)

    if (totalDeposits === 0 && totalBorrows === 0) {
      return 0
    }
    if (totalDeposits <= totalBorrows) {
      return MAX_RATE
    }

    const utilization = totalBorrows / totalDeposits
    if (utilization > OPTIMAL_UTIL) {
      const extraUtil = utilization - OPTIMAL_UTIL
      const slope = (MAX_RATE - OPTIMAL_RATE) / (1 - OPTIMAL_UTIL)
      return OPTIMAL_RATE + slope * extraUtil
    } else {
      const slope = OPTIMAL_RATE / OPTIMAL_UTIL
      return slope * utilization
    }
  }
  getDepositRate(tokenIndex: number): number {
    const borrowRate = this.getBorrowRate(tokenIndex)
    const totalBorrows = this.getUiTotalBorrow(tokenIndex)
    const totalDeposits = this.getUiTotalDeposit(tokenIndex)
    if (totalDeposits === 0 && totalBorrows === 0) {
      return 0
    } else if (totalDeposits === 0) {
      return MAX_RATE
    }
    const utilization = totalBorrows / totalDeposits
    return utilization * borrowRate
  }

  getUiTotalDeposit(tokenIndex: number): number {
    return nativeToUi(this.totalDeposits[tokenIndex] * this.indexes[tokenIndex].deposit, this.mintDecimals[tokenIndex])
  }
  getUiTotalBorrow(tokenIndex: number): number {
    return nativeToUi(this.totalBorrows[tokenIndex] * this.indexes[tokenIndex].borrow, this.mintDecimals[tokenIndex])
  }
}

export class MarginAccount {
  publicKey: PublicKey;
  createTime: number;  // used to determine when to update
  // TODO maybe this is obviated by websocket feed onUpdate

  accountFlags!: WideBits;
  mangoGroup!: PublicKey;
  owner!: PublicKey;
  deposits!: number[];
  borrows!: number[];
  openOrders!: PublicKey[];
  srmBalance!: number;
  openOrdersAccounts: (OpenOrders | undefined)[]  // undefined if an openOrdersAccount not yet initialized and has zeroKey
  // TODO keep updated with websocket

  constructor(publicKey: PublicKey, decoded: any) {
    this.publicKey = publicKey
    this.createTime = getUnixTs()
    this.openOrdersAccounts = new Array(NUM_MARKETS).fill(undefined)
    Object.assign(this, decoded)
  }

  getNativeDeposit(mangoGroup: MangoGroup, tokenIndex: number): number {  // insufficient precision
    return Math.round(mangoGroup.indexes[tokenIndex].deposit * this.deposits[tokenIndex])
  }
  getNativeBorrow(mangoGroup: MangoGroup, tokenIndex: number): number {  // insufficient precision
    return Math.round(mangoGroup.indexes[tokenIndex].borrow * this.borrows[tokenIndex])
  }
  getUiDeposit(mangoGroup: MangoGroup, tokenIndex: number): number {  // insufficient precision
    return nativeToUi(this.getNativeDeposit(mangoGroup, tokenIndex), mangoGroup.mintDecimals[tokenIndex])
  }
  getUiBorrow(mangoGroup: MangoGroup, tokenIndex: number): number {  // insufficient precision
    return nativeToUi(this.getNativeBorrow(mangoGroup, tokenIndex), mangoGroup.mintDecimals[tokenIndex])
  }

  getUiSrmBalance() {
    return nativeToUi(this.srmBalance, SRM_DECIMALS)
  }

  async loadOpenOrders(
    connection: Connection,
    dexProgramId: PublicKey
  ): Promise<(OpenOrders | undefined)[]> {
    const promises: Promise<OpenOrders | undefined>[] = []
    for (let i = 0; i < this.openOrders.length; i++) {
      if (this.openOrders[i].equals(zeroKey)) {
        promises.push(promiseUndef())
      } else {
        promises.push(OpenOrders.load(connection, this.openOrders[i], dexProgramId))
      }
    }

    this.openOrdersAccounts = await Promise.all(promises)
    return this.openOrdersAccounts
  }

  toPrettyString(
    mangoGroup: MangoGroup,
    prices: number[]
  ): string {
    const lines = [
      `MarginAccount: ${this.publicKey.toBase58()}`,
      `${"Asset".padEnd(5)} ${"Deposits".padEnd(10)} ${"Borrows".padEnd(10)}`,
    ]

    const tokenToDecimals = {
      "BTC": 4,
      "ETH": 3,
      "USDC": 2
    }
    const tokenNames = ["BTC", "ETH", "USDC"]  // TODO pull this from somewhere

    for (let i = 0; i < mangoGroup.tokens.length; i++) {
      const decimals = tokenToDecimals[tokenNames[i]]
      const depositStr = this.getUiDeposit(mangoGroup, i).toFixed(decimals).toString().padEnd(10)
      const borrowStr = this.getUiBorrow(mangoGroup, i).toFixed(decimals).toString().padEnd(10)
      lines.push(
        `${tokenNames[i].padEnd(5)} ${depositStr} ${borrowStr}`
      )
    }

    lines.push(`Coll. Ratio: ${this.getCollateralRatio(mangoGroup, prices).toFixed(4)}`)
    lines.push(`Value: ${this.computeValue(mangoGroup, prices).toFixed(2)}`)

    return lines.join('\n')
  }

  computeValue(
    mangoGroup: MangoGroup,
    prices: number[]
  ): number {
    let value = 0
    for (let i = 0; i < this.deposits.length; i++) {
      value += (this.getUiDeposit(mangoGroup, i) - this.getUiBorrow(mangoGroup, i))  * prices[i]
    }

    for (let i = 0; i < this.openOrdersAccounts.length; i++) {
      const oos = this.openOrdersAccounts[i]
      if (oos != undefined) {
        value += nativeToUi(oos.baseTokenTotal.toNumber(), mangoGroup.mintDecimals[i]) * prices[i]
        value += nativeToUi(oos.quoteTokenTotal.toNumber(), mangoGroup.mintDecimals[NUM_TOKENS-1])
      }
    }

    return value
  }

  async getValue(
    connection: Connection,
    mangoGroup: MangoGroup
  ): Promise<number> {
    const prices = await mangoGroup.getPrices(connection)
    return this.computeValue(mangoGroup, prices)
  }

  getDeposits(mangoGroup: MangoGroup): number[] {
    const deposits = new Array<number>(NUM_TOKENS)

    for (let i = 0; i < NUM_TOKENS; i++) {
      deposits[i] = this.getUiDeposit(mangoGroup, i)
    }

    return deposits
  }

  getAssets(mangoGroup: MangoGroup): number[] {
    const assets = new Array<number>(NUM_TOKENS)

    for (let i = 0; i < NUM_TOKENS; i++) {
      assets[i] = this.getUiDeposit(mangoGroup, i)
    }
    for (let i = 0; i < NUM_MARKETS; i++) {
      const openOrdersAccount = this.openOrdersAccounts[i]
      if (openOrdersAccount == undefined) {
        continue
      }

      assets[i] += nativeToUi(openOrdersAccount.baseTokenTotal.toNumber(), mangoGroup.mintDecimals[i])
      assets[NUM_TOKENS-1] += nativeToUi(openOrdersAccount.quoteTokenTotal.toNumber(), mangoGroup.mintDecimals[NUM_TOKENS-1])
    }


    return assets
  }

  getLiabs(mangoGroup: MangoGroup): number[] {
    const liabs = new Array(NUM_TOKENS)
    for (let i = 0; i < NUM_TOKENS; i++) {
      liabs[i] = this.getUiBorrow(mangoGroup, i)
    }

    return liabs
  }

  getAssetsVal(mangoGroup: MangoGroup, prices: number[]): number {
    let assetsVal = 0
    for (let i = 0; i < NUM_TOKENS; i++) {
      assetsVal += this.getUiDeposit(mangoGroup, i) * prices[i]
    }

    for (let i = 0; i < NUM_MARKETS; i++) {
      const openOrdersAccount = this.openOrdersAccounts[i]
      if (openOrdersAccount == undefined) {
        continue
      }

      assetsVal += nativeToUi(openOrdersAccount.baseTokenTotal.toNumber(), mangoGroup.mintDecimals[i]) * prices[i]
      assetsVal += nativeToUi(openOrdersAccount.quoteTokenTotal.toNumber(), mangoGroup.mintDecimals[NUM_TOKENS-1])
    }

    return assetsVal
  }

  getLiabsVal(mangoGroup: MangoGroup, prices: number[]) {
    let liabsVal = 0
    for (let i = 0; i < NUM_TOKENS; i++) {
      liabsVal += this.getUiBorrow(mangoGroup, i) * prices[i]
    }
    return liabsVal
  }

  getCollateralRatio(mangoGroup: MangoGroup, prices: number[]): number {
    const assetsVal = this.getAssetsVal(mangoGroup, prices)
    const liabsVal = this.getLiabsVal(mangoGroup, prices)

    return assetsVal / liabsVal
  }

  async cancelAllOrdersByMarket(
    connection: Connection,
    client: MangoClient,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    market: Market,
    bids: Orderbook,
    asks: Orderbook,
    owner: Account
  ): Promise<TransactionSignature[]> {

    const marketIndex = mangoGroup.getMarketIndex(market)
    const openOrdersAccount = this.openOrdersAccounts[marketIndex]
    if (openOrdersAccount == undefined) { // no open orders for this market
      return []
    }

    const orders = market.filterForOpenOrders(bids, asks, [openOrdersAccount])
    return await Promise.all(orders.map(
      (order) => (
        client.cancelOrder(connection, programId, mangoGroup, this, owner, market, order)
      )
    ))

  }

}

export class MangoClient {

  async sendTransaction(
    connection: Connection,
    transaction: Transaction,
    payer: Account,
    additionalSigners: Account[],
    timeout = 30000,
  ): Promise<TransactionSignature> {

    transaction.recentBlockhash = (await connection.getRecentBlockhash('singleGossip')).blockhash
    transaction.setSigners(payer.publicKey, ...additionalSigners.map( a => a.publicKey ))

    const signers = [payer].concat(additionalSigners)
    transaction.sign(...signers)
    const rawTransaction = transaction.serialize()
    const startTime = getUnixTs();

    const txid: TransactionSignature = await connection.sendRawTransaction(
      rawTransaction,
      {
        skipPreflight: true,
      },
    );

    console.log('Started awaiting confirmation for', txid);
    let done = false;
    (async () => {
      while (!done && (getUnixTs() - startTime) < timeout / 1000) {
        connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true
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
          await simulateTransaction(connection, transaction, 'singleGossip')
        ).value;
      } catch (e) {

      }
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

    console.log('Latency', txid, getUnixTs() - startTime);
    return txid;
  }

  async sendTransactionDeprecated(
    connection: Connection,
    transaction: Transaction,
    payer: Account,
    additionalSigners: Account[],
): Promise<TransactionSignature> {
    // TODO test on mainnet

    transaction.recentBlockhash = (await connection.getRecentBlockhash('singleGossip')).blockhash
    transaction.setSigners(payer.publicKey, ...additionalSigners.map( a => a.publicKey ))

    const signers = [payer].concat(additionalSigners)
    transaction.sign(...signers)
    const rawTransaction = transaction.serialize()
    return await sendAndConfirmRawTransaction(connection, rawTransaction, {skipPreflight: true})
  }

  async initMangoGroup(
    connection: Connection,
    programId: PublicKey,
    payer: PublicKey,
  ) {
    throw new Error("Not Implemented");
  }

  async initMarginAccount(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    owner: Account,  // assumed to be same as payer for now
  ): Promise<PublicKey> {
    // Create a Solana account for the MarginAccount and allocate space
    const accInstr = await createAccountInstruction(connection,
      owner.publicKey, MarginAccountLayout.span, programId)

    // Specify the accounts this instruction takes in (see program/src/instruction.rs)
    const keys = [
      { isSigner: false, isWritable: false, pubkey: mangoGroup.publicKey },
      { isSigner: false, isWritable: true,  pubkey: accInstr.account.publicKey },
      { isSigner: true,  isWritable: false, pubkey: owner.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_RENT_PUBKEY }
    ]

    // Encode and create instruction for actual initMarginAccount instruction
    const data = encodeMangoInstruction({ InitMarginAccount: {} })
    const initMarginAccountInstruction = new TransactionInstruction( { keys, data, programId })

    // Add all instructions to one atomic transaction
    const transaction = new Transaction()
    transaction.add(accInstr.instruction)
    transaction.add(initMarginAccountInstruction)

    // Specify signers in addition to the wallet
    const additionalSigners = [
      accInstr.account,
    ]

    // sign, send and confirm transaction
    await this.sendTransaction(connection, transaction, owner, additionalSigners)

    return accInstr.account.publicKey
  }

  async deposit(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,
    token: PublicKey,
    tokenAcc: PublicKey,

    quantity: number
  ): Promise<TransactionSignature> {
    const tokenIndex = mangoGroup.getTokenIndex(token)
    const nativeQuantity = uiToNative(quantity, mangoGroup.mintDecimals[tokenIndex])

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false, pubkey: owner.publicKey },
      { isSigner: false, isWritable: true,  pubkey: tokenAcc },
      { isSigner: false, isWritable: true,  pubkey: mangoGroup.vaults[tokenIndex] },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY }
    ]
    const data = encodeMangoInstruction({Deposit: {quantity: nativeQuantity}})

    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }

  async withdraw(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,
    token: PublicKey,
    tokenAcc: PublicKey,

    quantity: number
  ): Promise<TransactionSignature> {
    const tokenIndex = mangoGroup.getTokenIndex(token)
    const nativeQuantity = uiToNative(quantity, mangoGroup.mintDecimals[tokenIndex])

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false, pubkey: owner.publicKey },
      { isSigner: false, isWritable: true,  pubkey: tokenAcc },
      { isSigner: false, isWritable: true,  pubkey: mangoGroup.vaults[tokenIndex] },
      { isSigner: false, isWritable: false,  pubkey: mangoGroup.signerKey },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      ...marginAccount.openOrders.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
      ...mangoGroup.oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey }))
    ]
    const data = encodeMangoInstruction({Withdraw: {quantity: nativeQuantity}})


    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }

  async borrow(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,
    token: PublicKey,

    quantity: number
  ): Promise<TransactionSignature> {
    const tokenIndex = mangoGroup.getTokenIndex(token)
    const nativeQuantity = uiToNative(quantity, mangoGroup.mintDecimals[tokenIndex])

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false, pubkey: owner.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      ...marginAccount.openOrders.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
      ...mangoGroup.oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
    ]
    const data = encodeMangoInstruction({Borrow: {tokenIndex: new BN(tokenIndex), quantity: nativeQuantity}})


    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }

  async settleBorrow(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,

    token: PublicKey,
    quantity: number
  ): Promise<TransactionSignature> {

    const tokenIndex = mangoGroup.getTokenIndex(token)
    const nativeQuantity = uiToNative(quantity, mangoGroup.mintDecimals[tokenIndex])

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false,  pubkey: owner.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY }
    ]
    const data = encodeMangoInstruction({SettleBorrow: {tokenIndex: new BN(tokenIndex), quantity: nativeQuantity}})

    const instruction = new TransactionInstruction( { keys, data, programId })
    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }

  /**
   * Call SettleFunds on each market, then call SettleBorrow for each token in one transaction
   * @param connection
   * @param programId
   * @param mangoGroup
   * @param marginAccount
   * @param markets
   * @param owner
   */
  async settleAll(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    markets: Market[],
    owner: Account
  ): Promise<TransactionSignature | null> {

    const transaction = new Transaction()

    const assetGains: number[] = new Array(NUM_TOKENS).fill(0)

    for (let i = 0; i < NUM_MARKETS; i++) {
      const openOrdersAccount = marginAccount.openOrdersAccounts[i]
      if (openOrdersAccount === undefined) {
        continue
      } else if (openOrdersAccount.quoteTokenFree.toNumber() === 0 && openOrdersAccount.baseTokenFree.toNumber() === 0) {
        continue
      }

      assetGains[i] += openOrdersAccount.baseTokenFree.toNumber()
      assetGains[NUM_TOKENS-1] += openOrdersAccount.quoteTokenFree.toNumber()

      const spotMarket = markets[i]
      const dexSigner = await PublicKey.createProgramAddress(
        [
          spotMarket.publicKey.toBuffer(),
          spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
        ],
        spotMarket.programId
      )
      const keys = [
        { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
        { isSigner: true, isWritable: false,  pubkey: owner.publicKey },
        { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
        { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
        { isSigner: false, isWritable: false, pubkey: spotMarket.programId },
        { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
        { isSigner: false, isWritable: true, pubkey: marginAccount.openOrders[i] },
        { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
        { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].baseVault },
        { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].quoteVault },
        { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[i] },
        { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[mangoGroup.vaults.length - 1] },
        { isSigner: false, isWritable: false, pubkey: dexSigner },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      ]
      const data = encodeMangoInstruction( {SettleFunds: {}} )

      const instruction = new TransactionInstruction( { keys, data, programId })
      transaction.add(instruction)
    }

    const deposits = marginAccount.getDeposits(mangoGroup)
    const liabs = marginAccount.getLiabs(mangoGroup)

    for (let i = 0; i < NUM_TOKENS; i++) {  // TODO test this. maybe it hits transaction size limit

      const deposit = deposits[i] + assetGains[i]
      if (deposit === 0 || liabs[i] === 0) {
        continue
      }
      const keys = [
        { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
        { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
        { isSigner: true, isWritable: false,  pubkey: owner.publicKey },
        { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY }
      ]
      const data = encodeMangoInstruction({SettleBorrow: {tokenIndex: new BN(i), quantity: uiToNative(liabs[i] * 2, mangoGroup.mintDecimals[i])}})

      const instruction = new TransactionInstruction( { keys, data, programId })
      transaction.add(instruction)
    }

    const additionalSigners = []
    if (transaction.instructions.length == 0) {
       return null
    } else {
      return await this.sendTransaction(connection, transaction, owner, additionalSigners)
    }
  }

  async liquidate(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    liqeeMarginAccount: MarginAccount,  // liquidatee marginAccount
    liqor: Account,  // liquidator
    tokenAccs: PublicKey[],
    depositQuantities: number[]
  ): Promise<TransactionSignature> {

    const depositsBN: BN[] = []
    for (let i = 0; i < mangoGroup.tokens.length; i++) {
      depositsBN[i] = uiToNative(depositQuantities[i], mangoGroup.mintDecimals[i])
    }

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: true, isWritable: false, pubkey: liqor.publicKey },
      { isSigner: false,  isWritable: true, pubkey: liqeeMarginAccount.publicKey },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      ...liqeeMarginAccount.openOrders.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
      ...mangoGroup.oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
      ...mangoGroup.vaults.map( (pubkey) => ( { isSigner: false, isWritable: true, pubkey })),
      ...tokenAccs.map( (pubkey) => ( { isSigner: false, isWritable: true, pubkey })),
    ]
    const data = encodeMangoInstruction({Liquidate: {depositQuantities: depositsBN}})


    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, liqor, additionalSigners)
  }

  async depositSrm(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,
    srmAccount: PublicKey,

    quantity: number
  ): Promise<TransactionSignature> {
    const nativeQuantity = uiToNative(quantity, SRM_DECIMALS)

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false, pubkey: owner.publicKey },
      { isSigner: false, isWritable: true,  pubkey: srmAccount },
      { isSigner: false, isWritable: true,  pubkey: mangoGroup.srmVault },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY }
    ]
    const data = encodeMangoInstruction({DepositSrm: {quantity: nativeQuantity}})

    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }

  async withdrawSrm(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,
    srmAccount: PublicKey,

    quantity: number
  ): Promise<TransactionSignature> {
    const nativeQuantity = uiToNative(quantity, SRM_DECIMALS)

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false, pubkey: owner.publicKey },
      { isSigner: false, isWritable: true,  pubkey: srmAccount },
      { isSigner: false, isWritable: true,  pubkey: mangoGroup.srmVault },
      { isSigner: false, isWritable: false,  pubkey: mangoGroup.signerKey },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY }
    ]
    const data = encodeMangoInstruction({WithdrawSrm: {quantity: nativeQuantity}})

    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }

  async placeOrder(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    spotMarket: Market,
    owner: Account,

    side: 'buy' | 'sell',
    price: number,
    size: number,
    orderType?: 'limit' | 'ioc' | 'postOnly',
    clientId?: BN,
    timeout?: number
  ): Promise<TransactionSignature> {
    // TODO allow wrapped SOL wallets

    orderType = orderType || 'limit'
    const limitPrice = spotMarket.priceNumberToLots(price)
    const maxBaseQuantity = spotMarket.baseSizeNumberToLots(size)

    const feeTier = getFeeTier(0, nativeToUi(mangoGroup.nativeSrm || 0, SRM_DECIMALS));
    const rates = getFeeRates(feeTier);
    const maxQuoteQuantity = new BN(
      spotMarket['_decoded'].quoteLotSize.toNumber() * (1 + rates.taker),
    ).mul(spotMarket.baseSizeNumberToLots(size).mul(spotMarket.priceNumberToLots(price)));

    if (maxBaseQuantity.lte(new BN(0))) {
      throw new Error('size too small')
    }
    if (limitPrice.lte(new BN(0))) {
      throw new Error('invalid price')
    }
    const selfTradeBehavior = 'decrementTake'
    const marketIndex = mangoGroup.getMarketIndex(spotMarket)
    const vaultIndex = (side === 'buy') ? mangoGroup.vaults.length - 1 : marketIndex

    // Add all instructions to one atomic transaction
    const transaction = new Transaction()

    // Specify signers in addition to the wallet
    const additionalSigners: Account[] = []

    // Create a Solana account for the open orders account if it's missing
    const openOrdersKeys: PublicKey[] = [];
    for (let i = 0; i < marginAccount.openOrders.length; i++) {
      if (i === marketIndex && marginAccount.openOrders[marketIndex].equals(zeroKey)) {
        // open orders missing for this market; create a new one now
        const openOrdersSpace = OpenOrders.getLayout(mangoGroup.dexProgramId).span
        const openOrdersLamports = await connection.getMinimumBalanceForRentExemption(openOrdersSpace, 'singleGossip')
        const accInstr = await createAccountInstruction(
          connection, owner.publicKey, openOrdersSpace, mangoGroup.dexProgramId, openOrdersLamports
        )

        transaction.add(accInstr.instruction)
        additionalSigners.push(accInstr.account)
        openOrdersKeys.push(accInstr.account.publicKey)
      } else {
        openOrdersKeys.push(marginAccount.openOrders[i])
      }
    }

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: true,  isWritable: false,  pubkey: owner.publicKey },
      { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      { isSigner: false, isWritable: false, pubkey: spotMarket.programId },
      { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].requestQueue },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].eventQueue },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].bids },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].asks },
      { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[vaultIndex] },
      { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].baseVault },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].quoteVault },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_RENT_PUBKEY },
      { isSigner: false, isWritable: true, pubkey: mangoGroup.srmVault },
      ...openOrdersKeys.map( (pubkey) => ( { isSigner: false, isWritable: true, pubkey })),
      ...mangoGroup.oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
    ]

    const data = encodeMangoInstruction(
      {
        PlaceOrder:
          clientId
            ? { side, limitPrice, maxBaseQuantity, maxQuoteQuantity, selfTradeBehavior, orderType, clientId, limit: 65535}
            : { side, limitPrice, maxBaseQuantity, maxQuoteQuantity, selfTradeBehavior, orderType, limit: 65535}
      }
    )

    const placeOrderInstruction = new TransactionInstruction( { keys, data, programId })
    transaction.add(placeOrderInstruction)

    // sign, send and confirm transaction
    if (timeout) {
      return await this.sendTransaction(connection, transaction, owner, additionalSigners, timeout)
    } else {
      return await this.sendTransaction(connection, transaction, owner, additionalSigners)
    }
  }
  async settleFunds(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,
    spotMarket: Market,

  ): Promise<TransactionSignature> {

    const marketIndex = mangoGroup.getMarketIndex(spotMarket)
    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
      ],
      spotMarket.programId
    )

    const instruction = makeSettleFundsInstruction(
      programId,
      mangoGroup.publicKey,
      owner.publicKey,
      marginAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      marginAccount.openOrders[marketIndex],
      mangoGroup.signerKey,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      mangoGroup.vaults[marketIndex],
      mangoGroup.vaults[mangoGroup.vaults.length - 1],
      dexSigner
    )

    const transaction = new Transaction()
    transaction.add(instruction)

    // Specify signers in addition to the owner account
    const additionalSigners = []

    // sign, send and confirm transaction
    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }


  async cancelOrder(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    marginAccount: MarginAccount,
    owner: Account,
    spotMarket: Market,
    order: Order,
  ): Promise<TransactionSignature> {
    const instruction = makeCancelOrderInstruction(
      programId,
      mangoGroup.publicKey,
      owner.publicKey,
      marginAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      order.openOrdersAddress,
      mangoGroup.signerKey,
      spotMarket['_decoded'].eventQueue,
      order
    )
    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }

  async getMangoGroup(
    connection: Connection,
    mangoGroupPk: PublicKey,
    srmVaultPk?: PublicKey
  ): Promise<MangoGroup> {
    if (srmVaultPk) {
      const [acc, srmVaultAcc] = await Promise.all(
        [connection.getAccountInfo(mangoGroupPk), connection.getAccountInfo(srmVaultPk)]
      )
      const decoded = MangoGroupLayout.decode(acc == null ? undefined : acc.data);
      if (!srmVaultAcc) { return new MangoGroup(mangoGroupPk, decoded) }

      const srmVault = parseTokenAccountData(srmVaultAcc.data)
      return new MangoGroup(mangoGroupPk, decoded, srmVault.amount)
    } else {
      const acc = await connection.getAccountInfo(mangoGroupPk);
      const decoded = MangoGroupLayout.decode(acc == null ? undefined : acc.data);
      return new MangoGroup(mangoGroupPk, decoded);
    }
  }

  async getMarginAccount(
    connection: Connection,
    marginAccountPk: PublicKey,
    dexProgramId: PublicKey
  ): Promise<MarginAccount> {
    const acc = await connection.getAccountInfo(marginAccountPk, 'singleGossip')
    const ma = new MarginAccount(marginAccountPk, MarginAccountLayout.decode(acc == null ? undefined : acc.data))
    await ma.loadOpenOrders(connection, dexProgramId)
    return ma
  }

  async getAllMarginAccounts(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup
  ): Promise<MarginAccount[]> {

    const filters = [
      {
        memcmp: {
          offset: MarginAccountLayout.offsetOf('mangoGroup'),
          bytes: mangoGroup.publicKey.toBase58(),
        }
      },

      {
        dataSize: MarginAccountLayout.span,
      },
    ];

    const marginAccountsProms = getFilteredProgramAccounts(connection, programId, filters)
      .then((accounts) => (
        accounts.map(({ publicKey, accountInfo }) =>
          new MarginAccount(publicKey, MarginAccountLayout.decode(accountInfo == null ? undefined : accountInfo.data))
        )
      ))

    const ordersFilters = [
      {
        memcmp: {
          offset: OpenOrders.getLayout(mangoGroup.dexProgramId).offsetOf('owner'),
          bytes: mangoGroup.signerKey.toBase58()
        }
      },
      {
        dataSize: OpenOrders.getLayout(mangoGroup.dexProgramId).span
      }
    ]

    const openOrdersProms = getFilteredProgramAccounts(connection, mangoGroup.dexProgramId, ordersFilters)
      .then(
        (accounts) => (
          accounts.map(
            ( { publicKey, accountInfo } ) =>
            OpenOrders.fromAccountInfo(publicKey, accountInfo, mangoGroup.dexProgramId)
          )
        )
      )

    const marginAccounts = await marginAccountsProms
    const openOrders = await openOrdersProms
    const pkToOpenOrdersAccount = {}
    openOrders.forEach(
      (openOrdersAccount) => (
        pkToOpenOrdersAccount[openOrdersAccount.publicKey.toBase58()] = openOrdersAccount
      )
    )

    for (const ma of marginAccounts) {
      for (let i = 0; i < ma.openOrders.length; i++) {
        if (ma.openOrders[i].toBase58() in pkToOpenOrdersAccount) {
          ma.openOrdersAccounts[i] = pkToOpenOrdersAccount[ma.openOrders[i].toBase58()]
        }
      }
    }

    return marginAccounts
  }

  async getMarginAccountsForOwner(
    connection: Connection,
    programId: PublicKey,
    mangoGroup: MangoGroup,
    owner: Account | Wallet
  ): Promise<MarginAccount[]> {

    const filters = [
      {
        memcmp: {
          offset: MarginAccountLayout.offsetOf('mangoGroup'),
          bytes: mangoGroup.publicKey.toBase58(),
        },
      },
      {
        memcmp: {
          offset: MarginAccountLayout.offsetOf('owner'),
          bytes: owner.publicKey.toBase58(),
        }
      },

      {
        dataSize: MarginAccountLayout.span,
      },
    ];

    const accounts = await getFilteredProgramAccounts(connection, programId, filters);

    const marginAccounts = accounts.map(
      ({ publicKey, accountInfo }) =>
        new MarginAccount(publicKey, MarginAccountLayout.decode(accountInfo == null ? undefined : accountInfo.data))
    )

    await Promise.all(marginAccounts.map((ma) => ma.loadOpenOrders(connection, mangoGroup.dexProgramId)))

    return marginAccounts
  }
}

