
# Mango Client
A client to engage with the mango program

## Testing
**All tests are meant to be run on devnet**
The full test run, takes a long time to run and in some cases fail due to connectivity issues or someone else working on *devnet*. Therefore it is recommended to run isolated tests like so -
```
yarn test -g "<test description>"
```
For example the following test  -
```
it('should log lotSizes', async() => {...});
```
would be run like this -
```
yarn test -g "should log lotSizes"
```
You can also specify a test group that can run multiple tests for example the following group -
```
describe('log stuff', async() => {...});
```
can be run like this -
```
yarn test -g "should log lotSizes"
```
If however you do want to run the full suite of tests simply run -
```
yarn test
```
### Requirements
Some tests like logging and order matching will run without any requirements, however all liquidation tests expect to have an `AGGREGATOR_PATH` variable set in your *.env*.

The `AGGREGATOR_PATH` variable should be the *solana-flux-aggregator* path which you can get [here](https://github.com/blockworks-foundation/solana-flux-aggregator).

Example *.env* file -
```
AGGREGATOR_PATH=~/solana-flux-aggregator
```

### Testing liquidations
One of the most dynamic tests in the suite are the liquidation tests, which can be found in the `stress testing partial liquidation` group simply do a search for it in your IDE.

All of the tests there are variations of the `stressTestLiquidation` function.

Roughly this function works by -
1. Creates and funds a *liqee* account to be liquidated
2. Changes the oracle price to the order price the *liqee* is about submit
3. Submits a long or a short order on behalf of the *liqee*
4. Changes the oracle price to force *liqee*'s collateral ratio to drop below maintenance threshold
5. Creates and funds a *liqor* account that will perform the liquidation
6. *liqor* performs the liquidation

Listed below are the parameters that can allow to create many different liquidation scenarios -
```
mangoGroupSpotMarket: Market,
orderQuantity?: number, // Default = 1
customLiqeeOwner?: Account, // Default = null
shouldPartialLiquidate?: boolean, // Default = false
shouldCreateNewLiqor?: boolean, // Default = true
shouldFinishLiquidationInTest?: boolean, // Default = true
customOrderPrice?: number, // Default = 0
customOrderSize?: number, // Default = 0
leverageCoefficient?: number, // Default = 15
matchLeveragedOrder?: boolean, // Default = false
side?: 'buy' | 'sell' // Default = 'buy'
```
* *mangoGroupSpotMarket* is the spot market in which the liquidation opportunity should be created
* *orderQuantity* specifies how many orders the *liqee* account should create, it doesn't affect the orderSize
* *customLiqeeOwner* can be specified if you would like to reuse an existing account as `liqee`. This is useful if you want to chain liquidation scenarios. If left empty a new account is created
* *shouldPartialLiquidate* specifies whether it should be a regular liquidation or partial
* *shouldCreateNewLiqor* will create a new liqor account that will get funded to perform the liquidation. If you're chaining a liquidation scenario there's no need to create a liquidator on each, in that case you can set it to `false`
* *shouldFinishLiquidationInTest* - As with above you should set this parameter to `false` if you want to chain liquidation scenarios, or would like to finish the liquidation manually.
* *customOrderPrice* - if not set it will use the `minPrice` from the market
* *customOrderSize* - if not set it will use the `minSize` from the market
* *leverageCoefficient* - this parameter specifies force the level of leverage for the *liqee*, e.g. 15 coefficient will force *liqee* to be 15x
* *matchLeveragedOrder* specifies if the long or short should be matched, otherwise the liquidation scenario will play out with the borrow to always stay in the same currency as an open order. If set to `true` it will double the leverageCoefficient.
* *side* specifies whether it should be a long or a short that get's liquidated



### Example
```
async function main() {
  const client = new MangoClient()
  const cluster = 'mainnet-beta'
  const clusterUrl = process.env.CLUSTER_URL || IDS.cluster_urls[cluster]
  const connection = new Connection(clusterUrl, 'singleGossip')
  const programId = new PublicKey(IDS[cluster].mango_program_id)
  const dexProgramId = new PublicKey(IDS[cluster].dex_program_id)
  const mangoGroupPk = new PublicKey(IDS[cluster].mango_groups['BTC_ETH_USDT'].mango_group_pk)

  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'

  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))
  const mangoGroup = await client.getMangoGroup(connection, mangoGroupPk)
  const prices = await mangoGroup.getPrices(connection)
  const marginAccounts = (await client.getMarginAccountsForOwner(connection, programId, mangoGroup, payer))
  marginAccounts.sort(
    (a, b) => (a.computeValue(mangoGroup, prices) > b.computeValue(mangoGroup, prices) ? -1 : 1)
  )
  let marginAccount = marginAccounts[0]

  const market = await Market.load(connection, mangoGroup.spotMarkets[0], { skipPreflight: true, commitment: 'singleGossip'}, mangoGroup.dexProgramId)
  console.log('placing order')
  const txid = await client.placeOrder(connection, programId, mangoGroup, marginAccount, market, payer, 'buy', 48000, 0.0001)
  console.log('order placed')

  await sleep(5000)
  marginAccount = await client.getMarginAccount(connection, marginAccount.publicKey, mangoGroup.dexProgramId)
  const bids = await market.loadBids(connection)
  const asks = await market.loadAsks(connection)
  console.log('canceling orders')
  await marginAccount.cancelAllOrdersByMarket(connection, client, programId, mangoGroup, market, bids, asks, payer)
  console.log('orders canceled')
}
```
