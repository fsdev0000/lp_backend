import { validateReferralInvite, DEFAULT_REFERRAL_RECORDS } from '../services/masterclassReferralService';

describe('Masterclass Referral / Invite Code Validation', () => {
  it('should have two distinct entries for Danielle and Divalos with 33.33% discount', () => {
    const danielle = DEFAULT_REFERRAL_RECORDS.find((r) => r.referrerName === 'Danielle');
    const divalos = DEFAULT_REFERRAL_RECORDS.find((r) => r.referrerName === 'Divalos');

    expect(danielle).toBeDefined();
    expect(divalos).toBeDefined();
    expect(danielle?.code).toBe('0XQZ6IN');
    expect(divalos?.code).toBe('DIVALOS');
    expect(danielle?.discountPercent).toBe(33.33);
    expect(divalos?.discountPercent).toBe(33.33);
  });

  it('should correctly validate Danielle code (0XQZ6IN) and minus from 750 to 500', async () => {
    const result = await validateReferralInvite('0XQZ6IN');

    expect(result.valid).toBe(true);
    expect(result.referrerName).toBe('Danielle');
    expect(result.code).toBe('0XQZ6IN');
    expect(result.discountPercent).toBe(33.33);
    expect(result.originalPriceUsd).toBe(750);
    expect(result.discountAmountUsd).toBe(250);
    expect(result.finalPriceUsd).toBe(500);
    expect(result.originalAmountCents).toBe(75000);
    expect(result.discountAmountCents).toBe(25000);
    expect(result.finalAmountCents).toBe(50000);
  });

  it('should be case-insensitive for Danielle code (0xqz6in)', async () => {
    const result = await validateReferralInvite('0xqz6in');

    expect(result.valid).toBe(true);
    expect(result.referrerName).toBe('Danielle');
    expect(result.finalPriceUsd).toBe(500);
  });

  it('should correctly validate Divalos code (DIVALOS) and minus from 750 to 500', async () => {
    const result = await validateReferralInvite('DIVALOS');

    expect(result.valid).toBe(true);
    expect(result.referrerName).toBe('Divalos');
    expect(result.code).toBe('DIVALOS');
    expect(result.discountPercent).toBe(33.33);
    expect(result.originalPriceUsd).toBe(750);
    expect(result.discountAmountUsd).toBe(250);
    expect(result.finalPriceUsd).toBe(500);
  });

  it('should support Divalos alias code (DIVALOS33)', async () => {
    const result = await validateReferralInvite('DIVALOS33');

    expect(result.valid).toBe(true);
    expect(result.referrerName).toBe('Divalos');
    expect(result.finalPriceUsd).toBe(500);
  });

  it('should reject invalid promo codes', async () => {
    const result = await validateReferralInvite('FAKE_CODE_999');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('INVALID_CODE');
  });

  it('should reject empty or null promo codes', async () => {
    const result = await validateReferralInvite('');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('NO_CODE_PROVIDED');
  });
});
