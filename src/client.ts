import {
  Account,
  AccountInfo,
  Connection,
  PublicKey,
  sendAndConfirmRawTransaction,
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
  NUM_MARKETS,
  NUM_TOKENS,
  WideBits,
} from './layout';
import BN from 'bn.js';
import {
  createAccountInstruction,
  decodeAggregatorInfo,
  getMintDecimals,
  nativeToUi,
  uiToNative,
  zeroKey,
} from './utils';
import { Market, OpenOrders, Orderbook } from '@project-serum/serum';
import { TOKEN_PROGRAM_ID } from '@project-serum/serum/lib/token-instructions';
import { Order } from '@project-serum/serum/lib/market';
import Wallet from '@project-serum/sol-wallet-adapter';


export class MangoGroup {
  publicKey: PublicKey;
  mintDecimals: number[];

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

  constructor(publicKey: PublicKey, mintDecimals: number[], decoded: any) {
    this.publicKey = publicKey;
    this.mintDecimals = mintDecimals;
    Object.assign(this, decoded);
  }

  async getPrices(
    connection: Connection,
  ): Promise<number[]>  {
    const oracleAccs = await getMultipleAccounts(connection, this.oracles);
    return oracleAccs.map((oa) => decodeAggregatorInfo(oa.accountInfo).submissionValue).concat(1.0)
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
    return 0.0  // TODO
  }
  getDepositRate(tokenIndex: number): number {
    return 0.0  // TODO
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

  openOrdersAccounts: undefined | (OpenOrders | undefined)[]  // undefined if an openOrdersAccount not yet initialized and has zeroKey
  // TODO keep updated with websocket

  constructor(publicKey: PublicKey, decoded: any) {
    this.publicKey = publicKey
    this.createTime = getUnixTs()
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
    return Promise.all(promises)
  }
  toPrettyString(
    mangoGroup: MangoGroup
  ): string {
    const lines = [
      `MarginAccount: ${this.publicKey.toBase58()}`,
      `Asset Deposits Borrows`,
    ]

    const tokenNames = ["BTC", "ETH", "USDC"]  // TODO pull this from somewhere
    for (let i = 0; i < mangoGroup.tokens.length; i++) {
      lines.push(
        `${tokenNames[i]} ${this.getUiDeposit(mangoGroup, i)} ${this.getUiBorrow(mangoGroup, i)}`
      )
    }

    return lines.join('\n')
  }

  async getValue(
    connection: Connection,
    mangoGroup: MangoGroup
  ): Promise<number> {
    const prices = await mangoGroup.getPrices(connection)

    let value = 0
    for (let i = 0; i < this.deposits.length; i++) {
      value += (this.getUiDeposit(mangoGroup, i) - this.getUiBorrow(mangoGroup, i))  * prices[i]
    }

    if (this.openOrdersAccounts == undefined) {
      return value
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

  getAssets(mangoGroup: MangoGroup): number[] {
    if (this.openOrdersAccounts == undefined) {
      throw new Error("openOrdersAccounts not yet loaded")
    }

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
    if (this.openOrdersAccounts == undefined) {
      return assetsVal
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

    if (!this.openOrdersAccounts) {
      throw new Error("Must load open orders accounts first")
    }

    const openOrdersAccount = this.openOrdersAccounts[marketIndex]
    if (!openOrdersAccount) { // no open orders for this market
      return []
    }

    const orders = market.filterForOpenOrders(bids, asks, [openOrdersAccount])
    return await Promise.all(orders.map(
      (order) => (
        client.cancelOrder(connection, programId, mangoGroup, this, owner, market, order)
      )
    ))

  }

  async cancelAllOrders(
    connection: Connection

  ): Promise<boolean> {

    // fetch all orders using order id

    return true
  }

}

export class MangoClient {
  async initMangoGroup() {
    throw new Error("Not Implemented");
  }

  async sendTransaction(
    connection: Connection,
    transaction: Transaction,
    payer: Account,
    additionalSigners: Account[],
): Promise<TransactionSignature> {
    // TODO test on mainnet

    transaction.recentBlockhash = (await connection.getRecentBlockhash('max')).blockhash
    transaction.setSigners(payer.publicKey, ...additionalSigners.map( a => a.publicKey ))

    const signers = [payer].concat(additionalSigners)
    transaction.sign(...signers)
    const rawTransaction = transaction.serialize()
    return await sendAndConfirmRawTransaction(connection, rawTransaction, {skipPreflight: true})

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
      { isSigner: false, isWritable: false, pubkey: token },
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
      ...mangoGroup.oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
      ...mangoGroup.tokens.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
    ]
    const data = encodeMangoInstruction({Withdraw: {tokenIndex, quantity: nativeQuantity}})


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
      ...mangoGroup.tokens.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
    ]
    const data = encodeMangoInstruction({Borrow: {tokenIndex, quantity: nativeQuantity}})


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
  ): Promise<TransactionSignature> {

    if (!marginAccount.openOrdersAccounts) {
      throw new Error("openOrderesAccounts must be initialized")
    }

    const transaction = new Transaction()
    for (let i = 0; i < NUM_MARKETS; i++) {
      if (marginAccount.openOrdersAccounts[i] == undefined) {
        continue
      }
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

    const assets = marginAccount.getAssets(mangoGroup)
    const liabs = marginAccount.getLiabs(mangoGroup)

    for (let i = 0; i < NUM_TOKENS; i++) {  // TODO test this. maybe it hits transaction size limit
      const keys = [
        { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
        { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
        { isSigner: true, isWritable: false,  pubkey: owner.publicKey },
        { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY }
      ]
      const data = encodeMangoInstruction({SettleBorrow: {tokenIndex: new BN(i), quantity: uiToNative(liabs[i], mangoGroup.mintDecimals[i])}})

      const instruction = new TransactionInstruction( { keys, data, programId })
      transaction.add(instruction)

    }

    const additionalSigners = []
    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
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
      ...mangoGroup.tokens.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
    ]
    const data = encodeMangoInstruction({Liquidate: {depositQuantities: depositsBN}})


    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, liqor, additionalSigners)
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

  ): Promise<TransactionSignature> {
    // TODO allow wrapped SOL wallets
    // TODO allow fee discounts

    orderType = orderType == undefined ? 'limit' : orderType
    // orderType = orderType ?? 'limit'
    const limitPrice = spotMarket.priceNumberToLots(price)
    const maxQuantity = spotMarket.baseSizeNumberToLots(size)
    if (maxQuantity.lte(new BN(0))) {
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
      { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[vaultIndex] },
      { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].baseVault },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].quoteVault },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_RENT_PUBKEY },
      ...openOrdersKeys.map( (pubkey) => ( { isSigner: false, isWritable: true, pubkey })),
      ...mangoGroup.oracles.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
      ...mangoGroup.tokens.map( (pubkey) => ( { isSigner: false, isWritable: false, pubkey })),
    ]

    const data = encodeMangoInstruction(
      {
        PlaceOrder:
          clientId
            ? { side, limitPrice, maxQuantity, orderType, clientId, selfTradeBehavior }
            : { side, limitPrice, maxQuantity, orderType, selfTradeBehavior }
      }
    )

    const placeOrderInstruction = new TransactionInstruction( { keys, data, programId })
    transaction.add(placeOrderInstruction)

    // sign, send and confirm transaction
    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
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

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: true, isWritable: false,  pubkey: owner.publicKey },
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      { isSigner: false, isWritable: false, pubkey: spotMarket.programId },
      { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
      { isSigner: false, isWritable: true, pubkey: marginAccount.openOrders[marketIndex] },
      { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].baseVault },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].quoteVault },
      { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[marketIndex] },
      { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[mangoGroup.vaults.length - 1] },
      { isSigner: false, isWritable: false, pubkey: dexSigner },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    ]
    const data = encodeMangoInstruction( {SettleFunds: {}} )

    const instruction = new TransactionInstruction( { keys, data, programId })

    // Add all instructions to one atomic transaction
    const transaction = new Transaction()
    transaction.add(instruction)

    // Specify signers in addition to the wallet
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
    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey},
      { isSigner: true, isWritable: false,  pubkey: owner.publicKey },
      { isSigner: false,  isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      { isSigner: false, isWritable: false, pubkey: mangoGroup.dexProgramId },
      { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
      { isSigner: false, isWritable: true, pubkey: order.openOrdersAddress },
      { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].requestQueue },
      { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
    ]

    const data = encodeMangoInstruction({
      CancelOrder: {
        side: order.side,
        orderId: order.orderId,
        openOrders: order.openOrdersAddress,
        openOrdersSlot: order.openOrdersSlot
      }
    })


    const instruction = new TransactionInstruction( { keys, data, programId })

    const transaction = new Transaction()
    transaction.add(instruction)
    const additionalSigners = []

    return await this.sendTransaction(connection, transaction, owner, additionalSigners)
  }


  async getMangoGroup(
    connection: Connection,
    mangoGroupPk: PublicKey
  ): Promise<MangoGroup> {
    const acc = await connection.getAccountInfo(mangoGroupPk);
    const decoded = MangoGroupLayout.decode(acc == null ? undefined : acc.data);
    const mintDecimals: number[] = await Promise.all(decoded.tokens.map( (pk) => getMintDecimals(connection, pk) ))
    return new MangoGroup(mangoGroupPk, mintDecimals, decoded);
  }
  async getMarginAccount(
    connection: Connection,
    marginAccountPk: PublicKey
  ): Promise<MarginAccount> {
    const acc = await connection.getAccountInfo(marginAccountPk, 'singleGossip')
    return new MarginAccount(marginAccountPk, MarginAccountLayout.decode(acc == null ? undefined : acc.data))
  }


  async getCompleteMarginAccount(
    connection: Connection,
    marginAccountPk: PublicKey,
    dexProgramId: PublicKey
  ): Promise<MarginAccount> {
    const ma = await this.getMarginAccount(connection, marginAccountPk)
    await ma.loadOpenOrders(connection, dexProgramId)
    return ma
  }

  async getAllMarginAccounts(
    connection: Connection,
    programId: PublicKey,
    mangoGroupPk: PublicKey
  ): Promise<MarginAccount[]>{
    const filters = [
      {
        memcmp: {
          offset: MarginAccountLayout.offsetOf('mangoGroup'),
          bytes: mangoGroupPk.toBase58(),
        }
      },

      {
        dataSize: MarginAccountLayout.span,
      },
    ];

    const accounts = await getFilteredProgramAccounts(connection, programId, filters);
    return accounts.map(
      ({ publicKey, accountInfo }) =>
        new MarginAccount(publicKey, MarginAccountLayout.decode(accountInfo == null ? undefined : accountInfo.data))
    );
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
    return accounts.map(
      ({ publicKey, accountInfo }) =>
        new MarginAccount(publicKey, MarginAccountLayout.decode(accountInfo == null ? undefined : accountInfo.data))
    );
  }
}

async function getMultipleAccounts(
  connection: Connection,
  publicKeys: PublicKey[]

): Promise<{ publicKey: PublicKey; accountInfo: AccountInfo<Buffer> }[]> {
  const publickKeyStrs = publicKeys.map((pk) => (pk.toBase58()));

  // @ts-ignore
  const resp = await connection._rpcRequest('getMultipleAccounts', [publickKeyStrs]);
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

async function getFilteredProgramAccounts(
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


async function promiseUndef(): Promise<undefined> {
  return undefined
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};
