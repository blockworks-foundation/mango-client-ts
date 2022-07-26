import { Connection, PublicKey } from '@solana/web3.js';
import { expect } from 'chai';
import { getOraclePrice } from '../src/utils';

const conn = new Connection('https://api.mainnet-beta.solana.com/');

describe('getOraclePrice', async () => {
  it('should parse flux aggregator', async () => {
    const p = await getOraclePrice(
      conn,
      new PublicKey('HxrRDnjj2Ltj9LMmtcN6PDuFqnDe3FqXDHPvs2pwmtYF'),
    );
    expect(p).to.be.within(5000, 80000);
  });

  it('should parse pyth', async () => {
    const p = await getOraclePrice(
      conn,
      new PublicKey('GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU'),
    );
    expect(p).to.be.within(5000, 80000);
  });
});
