import { MangoClient, MangoGroup } from './client';
import IDS from './ids.json';
import { Account, Connection, PublicKey } from '@solana/web3.js';
import { Aggregator } from './schema';
import { homedir } from 'os';
import fs from 'fs';

export { MangoClient, MangoGroup, MarginAccount } from './client';
export { MangoIndexLayout, MarginAccountLayout, MangoGroupLayout } from './layout';
export * from './layout';
export * from './utils'

export { IDS }


// async function tests() {
//   const cluster = "devnet";
//   const client = new MangoClient();
//   const clusterIds = IDS[cluster]
//
//   const connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip')
//   const mangoGroupPk = new PublicKey(clusterIds.mango_groups['BTC_ETH_USDT'].mango_group_pk);
//   const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
//
//   const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
//   const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))
//
//
//   async function testSolink() {
//
//     const oraclePk = new PublicKey(IDS[cluster].oracles['ETH/USDT'])
//     const agg = await Aggregator.loadWithConnection(oraclePk, connection)
//
//     // const agg = await Aggregator.loadWithConnection(oraclePk, connection)
//     console.log(agg.answer.median.toNumber(), agg.answer.updatedAt.toNumber(), agg.round.id.toNumber())
//
//   }
//
//   async function testDepositSrm() {
//     const srmVaultPk = new PublicKey(clusterIds['mango_groups']['BTC_ETH_USDT']['srm_vault_pk'])
//     const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk, srmVaultPk)
//     const srmAccountPk = new PublicKey("6utvndL8EEjpwK5QVtguErncQEPVbkuyABmXu6FeygeV")
//     const mangoSrmAccount = await client.depositSrm(connection, mangoProgramId, mangoGroup, payer, srmAccountPk, 100)
//     console.log(mangoSrmAccount)
//   }
//
//   // await testSolink()
//   testDepositSrm()
// }
//
// tests()