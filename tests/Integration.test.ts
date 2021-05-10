  import { MangoClient, MangoGroup, MarginAccount } from '../src/client';
import IDS from '../src/ids.json';
import { sleep } from '../src/utils';
import { Account, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionSignature } from '@solana/web3.js';
import { Market, TokenInstructions, OpenOrders, Orderbook } from '@project-serum/serum';
import { u64, NATIVE_MINT } from "@solana/spl-token";
import { token } from '@project-serum/common';
import { expect } from 'chai';

// 1. Figure out the most suitable testing framework
// 2. Test making a deposit
// 3. Test making a withdrawal
// 4. Test placing and cancelling an order (1 - 128)
// 5. Create a mangoGroup with more than 3 tokens
// 6. Repeat steps  2-4

console.log = function () {}; //Disable all logging

let cluster = "devnet";
const client = new MangoClient();
const clusterIds = IDS[cluster];

const FAUCET_PROGRAM_ID = new PublicKey(
  "4bXpkKSV8swHSnwqtzuboGPaPDeEgAn4Vt8GfarV5rZt"
);

const connection = new Connection(IDS.cluster_urls[cluster], 'singleGossip');
const mangoGroupName = 'SOL_SRM_USDT';
const mangoGroupIds = clusterIds.mango_groups[mangoGroupName];
const mangoGroupPk = new PublicKey(mangoGroupIds.mango_group_pk);
const mangoProgramId = new PublicKey(clusterIds.mango_program_id);
const dexProgramId = new PublicKey(IDS[cluster].dex_program_id);
const keyPairPath = process.env.KEYPAIR || '/Users/ralfslagzda/.config/solana/id.json'
// const owner = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))
// const ownerPk = owner.publicKey

const updateMarginTokenAccountsAndDeposits = async () => {
  ownedTokenAccounts = await token.getOwnedTokenAccounts(connection, ownerPk);
  if (marginAccountPk) marginAccount = await client.getMarginAccount(connection, marginAccountPk, dexProgramId);
  if (marginAccount) deposits = marginAccount.getDeposits(mangoGroup);
}

const _sendTransaction = async (
  connection: Connection,
  transaction: Transaction,
  signers: Account[],
): Promise<TransactionSignature> => {
  const signature = await connection.sendTransaction(transaction, signers, { preflightCommitment: 'recent' });
  const { value } = await connection.confirmTransaction(signature, 'recent');
  if (value?.err) {
    throw new Error(JSON.stringify(value.err));
  }
  return signature;
}

const createTokenAccountInstrs = async(
  connection: Connection,
  newAccountPubkey: PublicKey,
  mint: PublicKey,
  ownerPk: PublicKey,
  lamports?: number,
): Promise<TransactionInstruction[]> => {
  if (lamports === undefined) {
    lamports = await connection.getMinimumBalanceForRentExemption(165);
  }
  return [
    SystemProgram.createAccount({
      fromPubkey: ownerPk,
      newAccountPubkey,
      space: 165,
      lamports,
      programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }),
    TokenInstructions.initializeAccount({
      account: newAccountPubkey,
      mint,
      owner: ownerPk,
    }),
  ];
}

const createWrappedNativeAccount = async (
  connection: Connection,
  owner: Account,
  amount: number
): Promise<PublicKey> => {
  // Allocate memory for the account
  const balanceNeeded = await connection.getMinimumBalanceForRentExemption(165);
  const newAccount = new Account();
  const tx = new Transaction();
  tx.add(SystemProgram.createAccount({
    fromPubkey: owner.publicKey,
    newAccountPubkey: newAccount.publicKey,
    lamports: balanceNeeded,
    space: 165,
    programId: TokenInstructions.TOKEN_PROGRAM_ID,
  })); // Send lamports to it (these will be wrapped into native tokens by the token program)

  tx.add(SystemProgram.transfer({
    fromPubkey: owner.publicKey,
    toPubkey: newAccount.publicKey,
    lamports: amount
  })); // Assign the new account to the native token mint.
  // the account will be initialized with a balance equal to the native token balance.
  // (i.e. amount)
  tx.add(TokenInstructions.initializeAccount({
    account: newAccount.publicKey,
    mint: NATIVE_MINT,
    owner: ownerPk,
  }));
  const signers = [owner, newAccount];
  const signerPks = signers.map(x => x.publicKey);
  tx.setSigners(...signerPks);
  const txHash = await _sendTransaction(connection, tx, signers);
  return newAccount.publicKey;
}

const createTokenAccount = async(
  connection: Connection,
  mint: PublicKey,
  owner: Account
): Promise<PublicKey> => {
  const newAccount = new Account();
  const tx = new Transaction();
  const signers = [owner, newAccount];
  const signerPks = signers.map(x => x.publicKey);
  tx.add(
    ...(await createTokenAccountInstrs(connection, newAccount.publicKey, mint, owner.publicKey)),
  );
  tx.setSigners(...signerPks);
  const txHash = await _sendTransaction(connection, tx, signers);
  return newAccount.publicKey;
}

const createWalletAndRequestAirdrop = async () => {
  console.info("Creating a new wallet for tests");
  owner = new Account();
  ownerPk = owner.publicKey;
  let balances = await connection.getBalance(ownerPk);
  console.info("Requesting incremental SOL airdrops, this may take a few seconds");
  for (let i = 0; i < 11; i++) {
    console.info(`Incremental SOL airdrop #${i + 1}/11`);
    await connection.requestAirdrop(ownerPk, 10 * 1e9);
    await sleep(2000);
  }
  balances = await connection.getBalance(ownerPk);
  return owner;
}

const getPDA = () => {
  return PublicKey.findProgramAddress([Buffer.from("faucet")], FAUCET_PROGRAM_ID);
}


const getMintPubkeyFromTokenAccountPubkey = async (
  tokenAccountPubkey: PublicKey
) => {
  try {
    const tokenMintData = (
      await connection.getParsedAccountInfo(
        tokenAccountPubkey,
        "singleGossip"
      )
    ).value!.data;
    //@ts-expect-error (doing the data parsing into steps so this ignore line is not moved around by formatting)
    const tokenMintAddress = tokenMintData.parsed.info.mint;
    return new PublicKey(tokenMintAddress);
  } catch (err) {
    throw new Error(
      "Error calculating mint address from token account. Are you sure you inserted a valid token account address"
    );
  }
};

const buildAirdropTokensIx = async (
  amount: u64,
  tokenMintPublicKey: PublicKey,
  destinationAccountPubkey: PublicKey,
  faucetPubkey: PublicKey
) => {
  const pubkeyNonce = await getPDA();

  const keys = [
    { pubkey: pubkeyNonce[0], isSigner: false, isWritable: false },
    { pubkey: tokenMintPublicKey, isSigner: false, isWritable: true },
    { pubkey: destinationAccountPubkey, isSigner: false, isWritable: true },
    { pubkey: TokenInstructions.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: faucetPubkey, isSigner: false, isWritable: false }
  ];

  return new TransactionInstruction({
    programId: FAUCET_PROGRAM_ID,
    data: Buffer.from([1, ...amount.toArray("le", 8)]),
    keys
  });
};

const airdropTokens = async (
  feePayerAccount: Account,
  faucetAddress: string,
  tokenDestinationPublicKey: PublicKey,
  amount: u64
) => {
  const faucetPubkey = new PublicKey(faucetAddress);
  const tokenMintPubkey = await getMintPubkeyFromTokenAccountPubkey(
    tokenDestinationPublicKey
  );
  const ix = await buildAirdropTokensIx(
    amount,
    tokenMintPubkey,
    tokenDestinationPublicKey,
    faucetPubkey
  );
  const tx = new Transaction();
  tx.add(ix);

  const signers = [feePayerAccount];
  const txHash = await _sendTransaction(connection, tx, signers);
  return tokenDestinationPublicKey.toBase58();
};

const airdropMangoGroupTokens = async () => {
  (await Promise.all(
    mangoGroup.tokens.map(async (mint: PublicKey) => {
      const tokenName = mangoGroupTokenMappings[mint.toString()];
      if (tokenName) {
        const ownedTokenAccount = ownedTokenAccounts.find(x => x.account.mint.equals(mint));
        if (tokenName !== 'SOL') {
          await airdropTokens(owner, clusterIds.faucets[tokenName], ownedTokenAccount.publicKey, new u64(100 * 1e6));
        }
      }
    })
  ));
  await updateMarginTokenAccountsAndDeposits();
}

const createTokenAccountsForMangoGroupTokens = async (mangoGroup: MangoGroup) => {
  (await Promise.all(
    mangoGroup.tokens.map(async (mint: PublicKey) => {
      const tokenName = mangoGroupTokenMappings[mint.toString()];
      if (tokenName) {
        if (tokenName === 'SOL') {
          await createWrappedNativeAccount(connection, owner, 100 * 1e9);
        } else {
          await createTokenAccount(connection, mint, owner);
        }
      }
    })
  ));
  await updateMarginTokenAccountsAndDeposits();
}

const walletTokenAccountsShouldEqual = (amount: number) => {
  mangoGroup.tokens.map((mint: PublicKey) => {
    const tokenName = mangoGroupTokenMappings[mint.toString()];
    if (tokenName) {
      const ownedTokenAccount = ownedTokenAccounts.find(x => x.account.mint.equals(mint));
      const multiplier = (tokenName === 'SOL') ? 1e9 : 1e6;
      expect(Math.round(ownedTokenAccount.account.amount)).to.equal(amount * multiplier);
    }
  })
}

const performDepositOrWithdrawal = async (marginAccount: MarginAccount, type: string, amount: number) => {
  (await Promise.all(
    mangoGroup.tokens.map(async (mint: PublicKey) => {
      const tokenName = mangoGroupTokenMappings[mint.toString()];
      if (tokenName) {
        const ownedTokenAccount = ownedTokenAccounts.find(x => x.account.mint.equals(mint));
        if (type === 'deposit') {
          await client.deposit(connection, mangoProgramId, mangoGroup, marginAccount, owner, mint, ownedTokenAccount.publicKey, Number(amount));
        } else if (type === 'withdraw') {
          await client.withdraw(connection, mangoProgramId, mangoGroup, marginAccount, owner, mint, ownedTokenAccount.publicKey, Number(amount));
        }
      }
    })
  ));
}

const getAndDecodeBidsAndAsks = async(spotMarket: Market) => {
  const bidData = (await connection.getAccountInfo(spotMarket['_decoded'].bids))?.data;
  const bidOrderBook = bidData ? Orderbook.decode(spotMarket, Buffer.from(bidData)): [];
  const askData = (await connection.getAccountInfo(spotMarket['_decoded'].asks))?.data;
  const askOrderBook = askData ? Orderbook.decode(spotMarket, Buffer.from(askData)): [];
  return {bidOrderBook, askOrderBook};
}
const getAndDecodeBidsAndAsksForOwner = async(spotMarket: Market, openOrdersAccount: OpenOrders) => {
  const { bidOrderBook, askOrderBook } = await getAndDecodeBidsAndAsks(spotMarket);
  const openOrdersForOwner = [...bidOrderBook, ...askOrderBook].filter((o) =>
    o.openOrdersAddress.equals(openOrdersAccount.address)
  )
  return openOrdersForOwner;
}

let owner: Account;
let ownerPk: PublicKey;
let mangoGroup: MangoGroup;
let mangoGroupTokenMappings: any;
let mangoGroupSpotMarkets: [string, string][];
let marginAccount: MarginAccount;
let marginAccountPk: PublicKey;
let ownedTokenAccounts: any;
let deposits: number[];
const testAmount: number = 100;

before(async () => {
  await createWalletAndRequestAirdrop();
  console.info(`Testing for mangoGroup: ${mangoGroupPk.toString()}`);
  mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  const mangoGroupSymbols: [string, string][] = Object.entries(mangoGroupIds.symbols);
  mangoGroupTokenMappings = Object.assign({}, ...mangoGroupSymbols.map(([a,b]) => ({[b]: a})))
  mangoGroupSpotMarkets = Object.entries(mangoGroupIds.spot_market_symbols);
  await createTokenAccountsForMangoGroupTokens(mangoGroup);
  await airdropMangoGroupTokens();
});

after(async () => {
  console.info("============");
  console.info("Your test wallet's public key:", owner.publicKey.toString());
  console.info("============");
  console.info(`Your test wallet's secret, to import in Sollet: \n [${owner.secretKey.toString()}]`);
  console.info("============");
});

describe('initMarginAccount', async () => {
  let existingMarginAccounts: MarginAccount[];
  before(async () => {
    existingMarginAccounts = await client.getMarginAccountsForOwner(connection, mangoProgramId, mangoGroup, owner);
  })
  it ('should init a new marginAccount', async() => {
    marginAccountPk = await client.initMarginAccount(connection, mangoProgramId, mangoGroup, owner);
    marginAccount = await client.getMarginAccount(connection, marginAccountPk, dexProgramId);
    const newMarginAccounts = await client.getMarginAccountsForOwner(connection, mangoProgramId, mangoGroup, owner);
    expect(newMarginAccounts).to.be.an('array').and.to.have.lengthOf(existingMarginAccounts.length + 1);
    expect(newMarginAccounts.find(x => x.publicKey.equals(marginAccountPk))).to.be.an('object'); // If not found return false
  });
})

describe('deposit & withdrawal', async() => {
  before(async () => {
    await updateMarginTokenAccountsAndDeposits();
  });
  it('should successfully deposit each token in mangoGroup', async () => {
    walletTokenAccountsShouldEqual(testAmount);
    deposits.map(x => expect(Math.round(x)).to.be.a('number').and.equal(0));
    await performDepositOrWithdrawal(marginAccount, 'deposit', testAmount);

    await updateMarginTokenAccountsAndDeposits();
    walletTokenAccountsShouldEqual(0);
    deposits.map(x => expect(Math.round(x)).to.be.a('number').and.equal(testAmount));
  });

  it('should successfully withdraw each token in mangoGroup', async () => {
    walletTokenAccountsShouldEqual(0);
    deposits.map(x => expect(Math.round(x)).to.be.a('number').and.equal(testAmount));

    await performDepositOrWithdrawal(marginAccount, 'withdraw', testAmount);

    await updateMarginTokenAccountsAndDeposits();
    walletTokenAccountsShouldEqual(testAmount);
    deposits.map(x => expect(Math.round(x)).to.be.a('number').and.equal(0));
  });
});

// NOTE: This test also creates the necessary openOrders accounts for the marginAccount
describe('place & cancel orders', async() => {
  before(async () => {
    await performDepositOrWithdrawal(marginAccount, 'deposit', testAmount);
    await updateMarginTokenAccountsAndDeposits();
    deposits.map(x => expect(Math.round(x)).to.be.a('number').and.equal(testAmount));
  })

  it('should successfully place a single buy order for each token in mangoGroup', async () => {
    // This needs to run synchronously
    for (let [spotMarketSymbol, spotMarketAddress] of mangoGroupSpotMarkets) {
      const spotMarket = await Market.load(connection, new PublicKey(spotMarketAddress), { skipPreflight: true, commitment: 'singleGossip'}, dexProgramId);
      const marketIndex = mangoGroup.getMarketIndex(spotMarket);
      await client.placeAndSettle(connection, mangoProgramId, mangoGroup, marginAccount, spotMarket, owner, 'buy', 10, 1);
      await updateMarginTokenAccountsAndDeposits();
      const openOrdersAccount = marginAccount.openOrdersAccounts[marketIndex];
      if (!openOrdersAccount) throw new Error(`openOrdersAccount not found for ${spotMarketSymbol}`);
      const openOrdersForOwner = await getAndDecodeBidsAndAsksForOwner(spotMarket, openOrdersAccount);
      expect(openOrdersForOwner).to.be.an('array').and.to.have.lengthOf(1);
      expect(openOrdersForOwner[0]).to.be.an('object').and.to.have.property('side', 'buy');
      expect(openOrdersForOwner[0]).to.be.an('object').and.to.have.property('price', 10);
      expect(openOrdersForOwner[0]).to.be.an('object').and.to.have.property('size', 1);
    }
    deposits.map((x, i) => expect(Math.round(x)).to.be.a('number').and.equal(deposits[i + 1] ? testAmount : testAmount - 20));
  })

  it('should successfully cancel a single buy order for each token in mangoGroup', async () => {
    for (let [spotMarketSymbol, spotMarketAddress] of mangoGroupSpotMarkets) {
      const spotMarket = await Market.load(connection, new PublicKey(spotMarketAddress), { skipPreflight: true, commitment: 'singleGossip'}, dexProgramId);
      const marketIndex = mangoGroup.getMarketIndex(spotMarket);
      const openOrdersAccount = marginAccount.openOrdersAccounts[marketIndex];
      if (!openOrdersAccount) throw new Error(`openOrdersAccount not found for ${spotMarketSymbol}`);
      let openOrdersForOwner = await getAndDecodeBidsAndAsksForOwner(spotMarket, openOrdersAccount);
      await client.cancelOrder(connection, mangoProgramId, mangoGroup, marginAccount, owner, spotMarket, openOrdersForOwner[0]);
      await client.settleFunds(connection, mangoProgramId, mangoGroup, marginAccount, owner, spotMarket);
      openOrdersForOwner = await getAndDecodeBidsAndAsksForOwner(spotMarket, openOrdersAccount);
      expect(openOrdersForOwner).to.be.an('array').that.is.empty;;
    }
    await updateMarginTokenAccountsAndDeposits();
    deposits.map(x => expect(Math.round(x)).to.be.a('number').and.equal(testAmount));
  });
})
