import { describe, expect, it } from 'vitest';
import { formatClaudeSshAddress, parseClaudeSshAddress } from '../utils/claudeSshAddress';

describe('Claude SSH server addresses', () => {
  it.each([
    ['dev-server', 'dev-server', null],
    [' user@host ', 'user@host', null],
    ['user@host:2222', 'user@host', 2222],
    ['ssh://user@host:2222', 'user@host', 2222],
    ['user@[2001:db8::1]:2222', 'user@2001:db8::1', 2222],
    ['user@2001:db8::1', 'user@2001:db8::1', null],
    ['[fe80::1%en0]:22', 'fe80::1%en0', 22],
  ])('parses %s without turning it into shell arguments', (address, target, port) => {
    expect(parseClaudeSshAddress(address as string)).toEqual({ target, port });
  });
  it.each(['', '-oProxyCommand=echo', 'user@host -p 22', 'user@host;echo', 'user@host:0', 'user@host:65536', 'user@host:abc', '@host', 'user@@host', 'user@[::1', 'user@host/path'])('rejects invalid address %s', address => {
    expect(parseClaudeSshAddress(address)).toBeNull();
  });
  it.each([
    { target: 'user@host', port: 22 },
    { target: 'user@host', port: null },
    { target: 'user@::1', port: 2222 },
  ])('round-trips saved connection identity including explicit default ports', connection => {
    expect(parseClaudeSshAddress(formatClaudeSshAddress(connection))).toEqual(connection);
  });
});
