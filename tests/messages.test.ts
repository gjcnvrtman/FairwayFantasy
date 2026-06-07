import { describe, it, expect } from 'vitest';
import { validateMessageBody, MESSAGE_LIMITS } from '@/lib/messages';

describe('validateMessageBody', () => {
  it('accepts a single character', () => {
    expect(validateMessageBody('a')).toBeNull();
  });

  it('accepts a body at exactly the max length', () => {
    const body = 'x'.repeat(MESSAGE_LIMITS.BODY_MAX);
    expect(validateMessageBody(body)).toBeNull();
  });

  it('accepts ordinary smack', () => {
    expect(validateMessageBody('Hambone choked, again.')).toBeNull();
  });

  it('rejects an empty string with a friendly message', () => {
    const err = validateMessageBody('');
    expect(err).toBe("Message can't be empty.");
  });

  it('rejects a body over the max length', () => {
    const body = 'x'.repeat(MESSAGE_LIMITS.BODY_MAX + 1);
    const err = validateMessageBody(body);
    expect(err).toContain(String(MESSAGE_LIMITS.BODY_MAX));
    expect(err).toContain('characters or fewer');
  });

  it('treats a multi-byte body by length-in-code-units', () => {
    // Emoji-only message of, say, 3 emoji is fine — well under cap.
    expect(validateMessageBody('🔥🔥🔥')).toBeNull();
  });
});

describe('MESSAGE_LIMITS contract', () => {
  it('keeps a reasonable body cap', () => {
    expect(MESSAGE_LIMITS.BODY_MIN).toBe(1);
    expect(MESSAGE_LIMITS.BODY_MAX).toBe(500);
  });

  it('keeps a sane rate-limit window', () => {
    // If these ever go too lax we should hear about it in review.
    expect(MESSAGE_LIMITS.POST_LIMIT).toBeLessThanOrEqual(60);
    expect(MESSAGE_LIMITS.POST_WINDOW_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
