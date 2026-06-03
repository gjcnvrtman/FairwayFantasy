// Pure-logic tests for the password-reset path. Match the existing
// auth-validation test pattern — we don't spin up a DB here, we
// validate the contract of the pure functions the API + page rely on.

import { describe, it, expect } from 'vitest';
import {
  validatePassword,
  validateRegistration,
  AUTH_LIMITS,
} from '../src/lib/auth-validation';

describe('validatePassword', () => {
  it('rejects empty', () => {
    expect(validatePassword('')).toBe('Password is required.');
  });

  it('rejects under length', () => {
    const tooShort = 'Ab1!' + 'x'.repeat(AUTH_LIMITS.PASSWORD_MIN - 5);
    expect(tooShort.length).toBe(AUTH_LIMITS.PASSWORD_MIN - 1);
    const err = validatePassword(tooShort);
    expect(err).toMatch(/at least \d+ characters/);
  });

  it('rejects over length', () => {
    const tooLong = 'Aa1!' + 'x'.repeat(AUTH_LIMITS.PASSWORD_MAX);
    const err = validatePassword(tooLong);
    expect(err).toMatch(/too long/);
  });

  it('rejects too few character classes (only lowercase + length pad)', () => {
    const oneClass = 'aaaaaaaaaaaaaaaa'; // 16 lowercase letters
    const err = validatePassword(oneClass);
    expect(err).toMatch(/lowercase letter, uppercase letter, digit, symbol/);
  });

  it('accepts a valid mixed-class password', () => {
    expect(validatePassword('Reset-pw-2026!')).toBeNull();
  });

  it('accepts when 3 of 4 classes are present (matches AUTH_LIMITS.PASSWORD_MIN_CLASSES default)', () => {
    // lowercase + uppercase + digit (no symbol) → 3 classes → valid
    expect(validatePassword('NewPassword123')).toBeNull();
    // lowercase + uppercase + symbol (no digit) → 3 classes → valid
    expect(validatePassword('NewPassword!@')).toBeNull();
  });
});

describe('validateRegistration / validatePassword DRY contract', () => {
  // The reset-password route and the registration route both gate on
  // the same complexity rules. If we ever forget to share the helper,
  // these tests will catch divergence — they pass the same password
  // to both validators and assert agreement on whether it's valid.
  const corpus = [
    '',                          // empty
    'a',                         // way too short
    'aaaaaaaaaaaaaaaaaaaa',      // only-lowercase, fails class count
    'NewPassword123',            // valid: lower + upper + digit
    'NewPassword!@',             // valid: lower + upper + symbol
    'Reset-pw-2026!',            // valid: all 4 classes
    'x'.repeat(AUTH_LIMITS.PASSWORD_MAX + 1),  // too long
  ];

  for (const pw of corpus) {
    it(`agreement for password length=${pw.length}`, () => {
      const direct = validatePassword(pw);
      const regErrors = validateRegistration({
        email:        'foo@example.com',
        display_name: 'Foo Bar',
        password:     pw,
      });
      // If validatePassword says OK, the registration validator's
      // .password field must be absent. If it says NOT-OK, the
      // registration validator must surface the same error string.
      if (direct === null) {
        expect(regErrors.password).toBeUndefined();
      } else {
        expect(regErrors.password).toBe(direct);
      }
    });
  }
});
