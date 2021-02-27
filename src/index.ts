import { MangoClient, MangoGroup } from './client';
import IDS from './ids.json';
import { Connection, PublicKey } from '@solana/web3.js';
import { getUnixTs } from './utils';

export { MangoClient, MangoGroup, MarginAccount } from './client';
export { MangoIndexLayout, MarginAccountLayout, MangoGroupLayout } from './layout';
export * from './layout';
export * from './utils'

export { IDS }


async function initMangoGroup() {

}

// async function testSolink() {
//   const cluster = "devnet";
//   const client = new MangoClient();
//   const clusterIds = IDS[cluster]
//
//   const connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip')
//   const mangoGroupPk = new PublicKey(clusterIds.mango_groups.BTC_ETH_USDC.mango_group_pk);
//   const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
//   const oraclePk = new PublicKey(IDS.devnet.oracles['BTC/USDC'])
//   const agg = await Aggregator.loadWithConnection(oraclePk, connection)
//   // const agg = await Aggregator.loadWithConnection(oraclePk, connection)
//   console.log(agg.answer.median.toNumber())
// }
//
// testSolink()


// async function main() {
//   const cluster = "devnet";
//   const client = new MangoClient();
//   const clusterIds = IDS[cluster]
//
//   const connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip')
//   const mangoGroupPk = new PublicKey(clusterIds.mango_groups.BTC_ETH_USDC.mango_group_pk);
//   const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
//
//   const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
//
//   const keyPairPath = '/home/dd/.config/solana/id.json'
//   const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))
//
//   // TODO auto fetch
//   const marginAccountPk = new PublicKey("DrKz21L9EqmykcEtiX3sY7ibHbVezgSY225upn3UA8Ju")
//   let marginAccount = await client.getMarginAccount(connection, marginAccountPk)
//
//   console.log(marginAccount.toPrettyString(mangoGroup))
//
//   const marketIndex = 0  // index for BTC/USDC
//   const spotMarket = await Market.load(
//     connection,
//     mangoGroup.spotMarkets[marketIndex],
//     {skipPreflight: true, commitment: 'singleGossip'},
//     mangoGroup.dexProgramId
//   )
//   const prices = await mangoGroup.getPrices(connection)
//   console.log(prices)
//
//   // // margin short 0.1 BTC
//   // await client.placeOrder(
//   //   connection,
//   //   mangoProgramId,
//   //   mangoGroup,
//   //   marginAccount,
//   //   spotMarket,
//   //   payer,
//   //   'sell',
//   //   30000,
//   //   0.1
//   // )
//   //
//   // await spotMarket.matchOrders(connection, payer, 10)
//   //
//   await client.settleFunds(
//     connection,
//     mangoProgramId,
//     mangoGroup,
//     marginAccount,
//     payer,
//     spotMarket
//   )
//   //
//   // await client.settleBorrow(connection, mangoProgramId, mangoGroup, marginAccount, payer, mangoGroup.tokens[2], 5000)
//   // await client.settleBorrow(connection, mangoProgramId, mangoGroup, marginAccount, payer, mangoGroup.tokens[0], 1.0)
//
//   marginAccount = await client.getMarginAccount(connection, marginAccount.publicKey)
//   console.log(marginAccount.toPrettyString(mangoGroup))
// }
// main()

//
// async function testAll() {
//   const cluster = "devnet"
//   const client = new MangoClient()
//   const clusterIds = IDS[cluster]
//
//   const connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip')
//   const mangoGroupPk = new PublicKey(clusterIds.mango_groups.BTC_ETH_USDC.mango_group_pk);
//   const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
//
//   const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
//
//   const keyPairPath = '/home/dd/.config/solana/id.json'
//   const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))
//
//   // TODO auto fetch
//   const marginAccounts = await client.getMarginAccountsForOwner(connection, mangoProgramId, mangoGroup, payer)
//   for (const x of marginAccounts) {
//     // get value of each margin account and select highest
//
//     console.log(x.publicKey.toBase58())
//   }
//
// }
//
//
//
//
// testAll()
