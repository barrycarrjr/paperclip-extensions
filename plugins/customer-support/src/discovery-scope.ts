/** Shared by the setup form and worker. Discovery is bounded to one /24 or smaller per call. */
export function discoveryRange(value: string) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter an IPv4 network from /24 to /32, such as 192.0.2.0/24.");
  const octets = match.slice(1, 5).map(Number); const prefix = Number(match[5]);
  if (octets.some(part => part > 255) || prefix < 24 || prefix > 32 || octets[0] === 0 || octets[0] === 127 || octets[0]! >= 224 || (octets[0] === 169 && octets[1] === 254)) {
    throw new Error("Use a unicast office IPv4 network from /24 to /32.");
  }
  const size = 2 ** (32 - prefix);
  const base = octets.reduce((number, part) => number * 256 + part, 0);
  const start = Math.floor(base / size) * size;
  const ip = (number: number) => [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join(".");
  const cidr = `${ip(start)}/${prefix}`;
  // /31 and /32 are valid point-to-point and single-host discovery ranges.
  const first = prefix <= 30 ? start + 1 : start;
  const last = prefix <= 30 ? start + size - 2 : start + size - 1;
  return { cidr, addresses: Array.from({ length: last - first + 1 }, (_, index) => ip(first + index)) };
}
