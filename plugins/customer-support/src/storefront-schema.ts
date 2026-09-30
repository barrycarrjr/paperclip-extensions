/** Public observations use only operator-saved URLs; no caller-selected endpoints. */
export function validPublicCheckUrl(value: string): boolean {
  try {
    const url=new URL(value);
    return url.protocol==="https:" && !url.username && !url.password && !url.search && !url.hash && !url.port &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/i.test(url.hostname);
  } catch { return false; }
}
