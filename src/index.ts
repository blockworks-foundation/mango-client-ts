import { MangoClient, MangoGroup } from './client';
import IDS from './ids.json';
import { Account, Connection, PublicKey } from '@solana/web3.js';
import { Market } from '@project-serum/serum';

export { MangoClient, MangoGroup, MarginAccount, tokenToDecimals } from './client';
export { MangoIndexLayout, MarginAccountLayout, MangoGroupLayout } from './layout';
export * from './layout';
export * from './utils'

export { IDS }

import { homedir } from 'os'
import * as fs from 'fs';
import { Aggregator } from './schema';
import { nativeToUi, sleep, uiToNative } from './utils';
import { NUM_MARKETS, NUM_TOKENS } from './layout';


async function tests() {
  const cluster = "mainnet-beta";
  const client = new MangoClient();
  const clusterIds = IDS[cluster]

  const connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip')
  const mangoGroupPk = new PublicKey(clusterIds.mango_groups['BTC_ETH_USDT'].mango_group_pk);
  const mangoProgramId = new PublicKey(clusterIds.mango_program_id);

  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))


  async function testSolink() {

    const oraclePk = new PublicKey(IDS[cluster].oracles['ETH/USDT'])
    const agg = await Aggregator.loadWithConnection(oraclePk, connection)

    // const agg = await Aggregator.loadWithConnection(oraclePk, connection)
    console.log(agg.answer.median.toNumber(), agg.answer.updatedAt.toNumber(), agg.round.id.toNumber())

  }

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

  async function getMarginAccountDetails() {
    const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
    const marginAccountPk = new PublicKey("D6kMTdmEhgiLWhdWcWddsS4LDVChogwNamxTVaNRJK2y")
    const marginAccount = await client.getMarginAccount(connection, marginAccountPk, mangoGroup.dexProgramId)
    const prices = await mangoGroup.getPrices(connection)

    console.log(marginAccount.toPrettyString(mangoGroup, prices))

    for (let i = 0; i < NUM_MARKETS; i++) {
      let openOrdersAccount = marginAccount.openOrdersAccounts[i]
      if (openOrdersAccount === undefined) {
        continue
      }

      for (const oid of openOrdersAccount.orders) {
        console.log(oid.toString())
      }
      console.log(i,
        nativeToUi(openOrdersAccount.quoteTokenTotal.toNumber(), mangoGroup.mintDecimals[NUM_MARKETS]),
        nativeToUi(openOrdersAccount.quoteTokenFree.toNumber(), mangoGroup.mintDecimals[NUM_MARKETS]),

        nativeToUi(openOrdersAccount.baseTokenTotal.toNumber(), mangoGroup.mintDecimals[i]),
        nativeToUi(openOrdersAccount.baseTokenFree.toNumber(), mangoGroup.mintDecimals[i])

      )
    }

  }

  async function buyEth() {
	  const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk)
	  const prices = await mangoGroup.getPrices(connection)
    const marginAccountPubKey = new PublicKey('D6kMTdmEhgiLWhdWcWddsS4LDVChogwNamxTVaNRJK2y');
    const marginAccount = await client.getMarginAccount(connection, marginAccountPubKey, mangoGroup.dexProgramId);
    console.log(marginAccount)

	  const market = await Market.load(connection, mangoGroup.spotMarkets[1], { skipPreflight: true, commitment: 'singleGossip'}, mangoGroup.dexProgramId)
	  console.log(market)

	  const bids = await market.loadBids(connection)
	  const asks = await market.loadAsks(connection)

	  console.log('placing order')
	  const txid = await client.placeOrder(connection, mangoProgramId, mangoGroup, marginAccount, market, payer, 'buy', 2350, 0.01)
	  console.log('order placed')
  }

  buyEth();

  //await getMarginAccountDetails()
  // await testSolink()
  // testDepositSrm()
}

tests()
