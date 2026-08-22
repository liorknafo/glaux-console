import { describe, expect, it } from 'vitest';
import { checkEndpointUrl, isLikelyLocal, REFUSAL_MESSAGE } from './validation';

describe('endpoint validation', () => {
  it('accepts local emulator endpoints', () => {
    for (const url of [
      'http://localhost:4566',
      'http://127.0.0.1:9000',
      'https://emulator.internal:4566',
      'http://host.docker.internal:4566',
      'http://192.168.1.20:4566',
    ]) {
      expect(checkEndpointUrl(url), url).toEqual({ ok: true, url: url.replace(/\/$/, '') });
    }
  });

  it('refuses real AWS hosts by design, not by warning', () => {
    for (const url of [
      'https://s3.amazonaws.com',
      'https://athena.us-east-1.amazonaws.com',
      'https://sqs.cn-north-1.amazonaws.com.cn',
      'https://lambda.us-east-1.api.aws',
      'https://AMAZONAWS.COM',
      'https://s3.amazonaws.com.',
    ]) {
      const result = checkEndpointUrl(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason).toBe(REFUSAL_MESSAGE);
    }
  });

  it('does not refuse a lookalike host that is not real AWS', () => {
    expect(checkEndpointUrl('http://amazonaws.com.localhost:4566').ok).toBe(true);
    expect(checkEndpointUrl('http://my-amazonaws.com-emulator.local:4566').ok).toBe(true);
  });

  it('rejects malformed input with a usable message', () => {
    expect(checkEndpointUrl('')).toEqual({ ok: false, reason: 'Enter an endpoint URL.' });
    const noScheme = checkEndpointUrl('localhost:4566');
    expect(noScheme.ok).toBe(false);
    const ftp = checkEndpointUrl('ftp://localhost:21');
    expect(ftp.ok).toBe(false);
    if (!ftp.ok) expect(ftp.reason).toContain('Use http or https');
  });

  it('strips a trailing slash so paths compose predictably', () => {
    expect(checkEndpointUrl('http://localhost:4566/')).toEqual({
      ok: true,
      url: 'http://localhost:4566',
    });
  });

  it('flags non-private hosts without refusing them', () => {
    expect(isLikelyLocal('http://localhost:4566')).toBe(true);
    expect(isLikelyLocal('http://10.0.0.5:4566')).toBe(true);
    expect(isLikelyLocal('https://emulator.example.com')).toBe(false);
  });
});
