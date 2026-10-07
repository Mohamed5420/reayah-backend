import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, isEncrypted } from '../../src/utils/crypto/field-encryption';

describe('field encryption', () => {
  it('round-trips and uses a random IV', () => {
    const a = encryptField('29801011234567');
    const b = encryptField('29801011234567');
    expect(a).not.toBe(b);
    expect(isEncrypted(a)).toBe(true);
    expect(decryptField(a)).toBe('29801011234567');
  });

  it('handles Arabic text', () => {
    expect(decryptField(encryptField('سكر من النوع الثاني'))).toBe('سكر من النوع الثاني');
  });

  it('rejects tampered ciphertext', () => {
    const parts = encryptField('LIC-123').split(':');
    parts[4] = Buffer.from('tampered').toString('base64');
    expect(() => decryptField(parts.join(':'))).toThrow();
  });

  it('passes plain (not yet encrypted) values through', () => {
    expect(decryptField('legacy value')).toBe('legacy value');
  });
});
