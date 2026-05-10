import { describe, it, expect } from 'vitest';
import { validateRegistration, AUTH_LIMITS } from '@/lib/auth-validation';

const goodInput = {
  email:        'rory@example.com',
  display_name: 'Rory McLeague',
  password:     'fairway-strong-1',
};

describe('validateRegistration — happy path', () => {
  it('accepts a valid registration', () => {
    expect(validateRegistration(goodInput)).toEqual({});
  });

  it('accepts the boundary lengths', () => {
    // Names at the min/max edge.
    const minName = 'A'.repeat(AUTH_LIMITS.DISPLAY_NAME_MIN);
    const maxName = 'A'.repeat(AUTH_LIMITS.DISPLAY_NAME_MAX);
    const minPw   = 'a'.repeat(AUTH_LIMITS.PASSWORD_MIN);

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
    const errs = validateRegistration({
      ...goodInput, password: 'a'.repeat(AUTH_LIMITS.PASSWORD_MIN - 1),
    });
    expect(errs.password).toContain(`${AUTH_LIMITS.PASSWORD_MIN}`);
  });

  it('rejects above the maximum', () => {
    const errs = validateRegistration({
      ...goodInput, password: 'a'.repeat(AUTH_LIMITS.PASSWORD_MAX + 1),
    });
    expect(errs.password).toContain('too long');
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
