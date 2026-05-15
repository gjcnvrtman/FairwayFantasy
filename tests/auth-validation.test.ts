import { describe, it, expect } from 'vitest';
import {
  validateRegistration,
  countPasswordClasses,
  AUTH_LIMITS,
} from '@/lib/auth-validation';

// 'Fairway-Strong-1' covers 3 of 4 classes (upper, lower, digit, symbol)
// and is 16 chars — comfortably above PASSWORD_MIN (10).
const goodInput = {
  email:        'rory@example.com',
  display_name: 'Rory McLeague',
  password:     'Fairway-Strong-1',
};

describe('validateRegistration — happy path', () => {
  it('accepts a valid registration', () => {
    expect(validateRegistration(goodInput)).toEqual({});
  });

  it('accepts the boundary lengths', () => {
    // Names at the min/max edge.
    const minName = 'A'.repeat(AUTH_LIMITS.DISPLAY_NAME_MIN);
    const maxName = 'A'.repeat(AUTH_LIMITS.DISPLAY_NAME_MAX);
    // Password at exactly PASSWORD_MIN length AND meeting the 3-class
    // complexity rule (upper + lower + digit). 'A' + 'a' x (MIN-2) + '1'
    // totals PASSWORD_MIN characters with 3 classes.
    const padding = 'a'.repeat(Math.max(0, AUTH_LIMITS.PASSWORD_MIN - 2));
    const minPw   = 'A' + padding + '1';

    expect(validateRegistration({ ...goodInput, display_name: minName })).toEqual({});
    expect(validateRegistration({ ...goodInput, display_name: maxName })).toEqual({});
    expect(validateRegistration({ ...goodInput, password:     minPw  })).toEqual({});
  });
});

describe('validateRegistration — email', () => {
  it('rejects empty email', () => {
    const errs = validateRegistration({ ...goodInput, email: '' });
    expect(errs.email).toBeTruthy();
  });

  it('rejects malformed email — no @', () => {
    const errs = validateRegistration({ ...goodInput, email: 'just-text' });
    expect(errs.email).toContain('valid email');
  });

  it('rejects malformed email — no TLD', () => {
    const errs = validateRegistration({ ...goodInput, email: 'rory@example' });
    expect(errs.email).toBeTruthy();
  });

  it('rejects whitespace inside email', () => {
    const errs = validateRegistration({ ...goodInput, email: 'rory @ example.com' });
    expect(errs.email).toBeTruthy();
  });

  it('rejects an absurdly long email', () => {
    const long = 'x'.repeat(250) + '@a.com';
    const errs = validateRegistration({ ...goodInput, email: long });
    expect(errs.email).toContain('too long');
  });
});

describe('validateRegistration — display_name', () => {
  it('rejects empty', () => {
    const errs = validateRegistration({ ...goodInput, display_name: '' });
    expect(errs.display_name).toBeTruthy();
  });

  it('rejects below the minimum', () => {
    const errs = validateRegistration({
      ...goodInput, display_name: 'A'.repeat(AUTH_LIMITS.DISPLAY_NAME_MIN - 1),
    });
    expect(errs.display_name).toContain(`${AUTH_LIMITS.DISPLAY_NAME_MIN}`);
  });

  it('rejects above the maximum', () => {
    const errs = validateRegistration({
      ...goodInput, display_name: 'A'.repeat(AUTH_LIMITS.DISPLAY_NAME_MAX + 1),
    });
    expect(errs.display_name).toContain(`${AUTH_LIMITS.DISPLAY_NAME_MAX}`);
  });
});

describe('validateRegistration — password', () => {
  it('rejects empty', () => {
    const errs = validateRegistration({ ...goodInput, password: '' });
    expect(errs.password).toBeTruthy();
  });

  it('rejects below the minimum', () => {
    // Make sure the test is exercising the length check (not the
    // complexity check) by using a password that's long-enough-style
    // but short-enough-short.
    const tooShort = 'Aa1' + 'x'.repeat(Math.max(0, AUTH_LIMITS.PASSWORD_MIN - 4));
    const errs = validateRegistration({ ...goodInput, password: tooShort });
    expect(errs.password).toContain(`${AUTH_LIMITS.PASSWORD_MIN}`);
  });

  it('rejects above the maximum', () => {
    const errs = validateRegistration({
      ...goodInput, password: 'A1' + 'a'.repeat(AUTH_LIMITS.PASSWORD_MAX),
    });
    expect(errs.password).toContain('too long');
  });

  it('rejects insufficient character-class diversity (only lowercase)', () => {
    // All-lowercase password long enough to pass the length check but
    // only 1 class — should be rejected for complexity.
    const onlyLower = 'a'.repeat(AUTH_LIMITS.PASSWORD_MIN + 5);
    const errs = validateRegistration({ ...goodInput, password: onlyLower });
    expect(errs.password).toBeTruthy();
    expect(errs.password).toContain('lowercase');
  });

  it('rejects 2-class password (lowercase + digit only)', () => {
    const twoClass = 'password12';
    const errs = validateRegistration({ ...goodInput, password: twoClass });
    expect(errs.password).toBeTruthy();
  });

  it('accepts a 3-class password (lowercase + uppercase + digit)', () => {
    const threeClass = 'Password12';
    const errs = validateRegistration({ ...goodInput, password: threeClass });
    expect(errs.password).toBeUndefined();
  });

  it('accepts a 3-class password using symbols (lowercase + digit + symbol)', () => {
    const threeClass = 'pass-word-12';
    const errs = validateRegistration({ ...goodInput, password: threeClass });
    expect(errs.password).toBeUndefined();
  });

  it('accepts all 4 classes', () => {
    const fourClass = 'Pass-word-12';
    const errs = validateRegistration({ ...goodInput, password: fourClass });
    expect(errs.password).toBeUndefined();
  });
});

describe('countPasswordClasses', () => {
  it('counts lowercase only', () => {
    expect(countPasswordClasses('abcdefghij')).toBe(1);
  });

  it('counts lowercase + digit', () => {
    expect(countPasswordClasses('abc123')).toBe(2);
  });

  it('counts all four classes', () => {
    expect(countPasswordClasses('Aa1-')).toBe(4);
  });

  it('counts an empty string as zero classes', () => {
    expect(countPasswordClasses('')).toBe(0);
  });

  it('counts symbol-only', () => {
    expect(countPasswordClasses('!@#$%^&*()')).toBe(1);
  });
});

describe('validateRegistration — multi-field', () => {
  it('returns ALL errors at once, not just the first', () => {
    const errs = validateRegistration({
      email:        '',
      display_name: '',
      password:     '',
    });
    expect(Object.keys(errs).sort()).toEqual(['display_name', 'email', 'password']);
  });
});
