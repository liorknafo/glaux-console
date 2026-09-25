import { describe, expect, it } from 'vitest';
import {
  checkEndpointUrl,
  classifyHost,
  isLikelyLocal,
  METADATA_REFUSAL_MESSAGE,
  REFUSAL_MESSAGE,
} from './validation';

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

  it('refuses a literal address outside the local ranges, as the backend does', () => {
    // The form cannot resolve a name, so it mirrors only the half of the
    // local-only rule that a string can decide. The backend decides the rest.
    for (const url of [
      'http://93.184.216.34:4566',
      'http://8.8.8.8',
      'http://172.32.0.1:4566',
      'http://100.64.0.1:4566',
      'http://[2606:4700:4700::1111]:4566',
      'http://[::ffff:93.184.216.34]:4566',
    ]) {
      const result = checkEndpointUrl(url);
      expect(result.ok, url).toBe(false);
      expect(result.ok === false && result.reason, url).toMatch(/not a local address/);
    }
  });

  it('sorts hosts the same way the backend does', () => {
    expect(classifyHost('127.0.0.1')).toBe('local');
    expect(classifyHost('localhost')).toBe('local');
    expect(classifyHost('glaux.localhost')).toBe('local');
    expect(classifyHost('10.0.0.5')).toBe('local');
    expect(classifyHost('93.184.216.34')).toBe('remote');
    expect(classifyHost('emulator.internal')).toBe('name');
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

  it('refuses cloud instance-metadata addresses', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.170.2/v2/credentials',
      'http://metadata.google.internal/',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://instance-data/',
      'http://100.100.100.200/latest/meta-data/',
    ]) {
      const result = checkEndpointUrl(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason).toBe(METADATA_REFUSAL_MESSAGE);
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
