import { Market, OpenOrders } from '@project-serum/serum';
import { Account, Commitment, Connection, PublicKey } from '@solana/web3.js';
import * as os from 'os';
import * as fs from 'fs';

import { MangoClient, MangoGroup } from './client';
import IDS from './ids.json';
import {
  decodeRecentEvents,
  findLargestTokenAccountForOwner,
  getMultipleAccounts,
  nativeToUi,
  parseTokenAccountData,
  sleep
} from './utils'
import { NUM_MARKETS, NUM_TOKENS } from './layout';

async function tests() {
  const cluster = "mainnet-beta";
  const client = new MangoClient();
  const clusterIds = IDS[cluster]

  const connection = new Connection(IDS.cluster_urls[cluster], 'processed' as Commitment)
  const mangoGroupPk = new PublicKey(clusterIds.mango_groups['BTC_ETH_SOL_SRM_USDC'].mango_group_pk);
  const mangoProgramId = new PublicKey(clusterIds.mango_program_id);

  const keyPairPath = process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json'
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  /*
  async function testSolink() {

    const oraclePk = new PublicKey(IDS[cluster].oracles['ETH/USDT'])
    const agg = await Aggregator.loadWithConnection(oraclePk, connection)

    // const agg = await Aggregator.loadWithConnection(oraclePk, connection)
    console.log(agg.answer.median.toNumber(), agg.answer.updatedAt.toNumber(), agg.round.id.toNumber())

  }
  */

  /*
  async function testDepositSrm() {
    const srmVaultPk = new PublicKey(clusterIds['mango_groups']['BTC_ETH_USDT']['srm_vault_pk'])
    const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk, srmVaultPk)
    const srmAccountPk = new PublicKey("6utvndL8EEjpwK5QVtguErncQEPVbkuyABmXu6FeygeV")
    const mangoSrmAccountPk = await client.depositSrm(connection, mangoProgramId, mangoGroup, payer, srmAccountPk, 100)
    console.log(mangoSrmAccountPk.toBase58())
    await sleep(2000)
    const mangoSrmAccount = await client.getMangoSrmAccount(connection, mangoSrmAccountPk)
    const txid = await client.withdrawSrm(connection, mangoProgramId, mangoGroup, mangoSrmAccount, payer, srmAccountPk, 50)
    console.log('success', txid)
  }
  */

  async function getMarginAccountDetails() {
    const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
    const marginAccountPk = new PublicKey("AoqCcazWgh1VyDhDmvUEt36UHKt3ujJv57c9YEvaDZLj")
    const marginAccount = await client.getMarginAccount(connection, marginAccountPk, mangoGroup.dexProgramId)
    const prices = await mangoGroup.getPrices(connection)

    console.log(marginAccount.toPrettyString(mangoGroup, prices))
    console.log(marginAccount.beingLiquidated)
    console.log(marginAccount.getCollateralRatio(mangoGroup, prices))

    for (let i = 0; i < NUM_TOKENS; i++) {
      console.log(marginAccount.getUiDeposit(mangoGroup, i), marginAccount.getUiBorrow(mangoGroup, i))
    }
    for (let i = 0; i < NUM_MARKETS; i++) {
      let openOrdersAccount = marginAccount.openOrdersAccounts[i]
      if (openOrdersAccount === undefined) {
        continue
      }

      console.log('referrer rebates', i, openOrdersAccount['referrerRebatesAccrued'].toNumber())
      console.log(i,
        nativeToUi(openOrdersAccount.quoteTokenTotal.toNumber() + openOrdersAccount['referrerRebatesAccrued'].toNumber(), mangoGroup.mintDecimals[NUM_MARKETS]),
        nativeToUi(openOrdersAccount.quoteTokenFree.toNumber(), mangoGroup.mintDecimals[NUM_MARKETS]),

        nativeToUi(openOrdersAccount.baseTokenTotal.toNumber(), mangoGroup.mintDecimals[i]),
        nativeToUi(openOrdersAccount.baseTokenFree.toNumber(), mangoGroup.mintDecimals[i])

      )
    }

  }

  async function testMarketOrderDex() {
    const NUM_MARKETS = 2;
    const dexProgramId = new PublicKey(clusterIds.dex_program_id);

    const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk)

    // load largest wallet account for each token
    const tokenWallets = (await Promise.all(
      mangoGroup.tokens.map(
        (mint) => findLargestTokenAccountForOwner(connection, payer.publicKey, mint).then(
          (response) => response.publicKey
        )
      )
    ))
    console.log({tokenWallets: tokenWallets.map(w => w.toString())})

    // load all markets
    const markets = await Promise.all(mangoGroup.spotMarkets.map(
      (pk) => Market.load(connection, pk, {skipPreflight: true, commitment: 'singleGossip'}, dexProgramId)
    ))
    console.log({markets})

    // load open orders
    const liqorOpenOrdersKeys: PublicKey[] = []
    for (let i = 0; i < NUM_MARKETS; i++) {
      let openOrdersAccounts: OpenOrders[] = await markets[i].findOpenOrdersAccountsForOwner(connection, payer.publicKey)
      if(openOrdersAccounts.length) {
        liqorOpenOrdersKeys.push(openOrdersAccounts[0].publicKey)
      } else {
        console.log(`No OpenOrders account found for market ${markets[i].publicKey.toBase58()}`)
      }
    }
    console.log({liqorOpenOrdersKeys: liqorOpenOrdersKeys.map(k => k.toString())})

    const marketIndex = 1;
    const market = markets[marketIndex]; // ETH/USDT
    const price = 4000;
    const size = 0.001;

    const txid = await market.placeOrder(
      connection,
      {
        owner: payer,
        payer: tokenWallets[marketIndex],
        side: 'sell',
        price,
        size,
        orderType: 'ioc',
        openOrdersAddressKey: liqorOpenOrdersKeys[marketIndex],
        feeDiscountPubkey: null  // TODO find liqor's SRM fee account
      }
    )
    console.log({txid})

    var lastSeenSeqNum = undefined

    for (let i = 0; i < 50; ++i) {
      const status = await connection.getSignatureStatus(txid);
      console.log({status: status!.value!.confirmations})

      let orders = await market.loadOrdersForOwner(connection, payer.publicKey);
      console.log({orders});

      const info = await connection.getAccountInfo(market['_decoded'].eventQueue)
      const { header, nodes } = decodeRecentEvents(info!.data, lastSeenSeqNum)
      console.log({ header, nodes: nodes.map(n => [n.nativeQuantityPaid.toNumber(),
                                                   n.nativeQuantityReleased.toNumber()]) })
      lastSeenSeqNum = header.seqNum

      const liqorWalletAccounts = await getMultipleAccounts(connection, tokenWallets, 'processed' as Commitment)
      const liqorValuesUi = liqorWalletAccounts.map(
        (a, i) => nativeToUi(parseTokenAccountData(a.accountInfo.data).amount, mangoGroup.mintDecimals[i])
      )
      console.log({liqorValuesUi})
      await sleep(500)
    }
  }

  await getMarginAccountDetails()
  // await testSolink()
  // await testDepositSrm()
  // await testMarketOrderDex()
}

tests()
