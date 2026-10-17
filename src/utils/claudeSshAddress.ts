export interface ClaudeSshAddress {
  target: string;
  port: number | null;
}

export function parseClaudeSshAddress(value: string): ClaudeSshAddress | null {
  const address = value.trim().replace(/^ssh:\/\//i, '');
  if (!address || address.length > 512 || address.startsWith('-') || /[^a-zA-Z0-9_.@\[\]:%\-]/.test(address)) return null;
  const parts = address.split('@');
  if (parts.length > 2 || (parts.length === 2 && !/^[a-zA-Z0-9_.-]+$/.test(parts[0]!))) return null;
  const user = parts.length === 2 ? `${parts[0]}@` : '';
  let host = parts[parts.length - 1]!;
  let port: number | null = null;
  if (host.startsWith('[')) {
    const match = /^\[([a-zA-Z0-9:._%\-]+)\](?::([0-9]+))?$/.exec(host);
    if (!match || !match[1]!.includes(':')) return null;
    host = match[1]!;
    if (match[2]) port = Number(match[2]);
  } else if (host.includes('[') || host.includes(']')) {
    return null;
  } else if ((host.match(/:/g) || []).length === 1) {
    const match = /^([^:]+):([0-9]+)$/.exec(host);
    if (!match) return null;
    host = match[1]!;
    port = Number(match[2]);
  }
  if (!host || host.startsWith('-') || (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) return null;
  return { target: user + host, port };
}

export function formatClaudeSshAddress({ target, port }: ClaudeSshAddress): string {
  if (port === null) return target;
  const at = target.lastIndexOf('@');
  const user = target.slice(0, at + 1);
  const host = target.slice(at + 1);
  return `${user}${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
