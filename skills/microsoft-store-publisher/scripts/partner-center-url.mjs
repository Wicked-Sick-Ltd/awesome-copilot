// Partner Center hosts. Subdomains count; lookalike hosts and the same text in
// a path or query do not. Compared against URL.hostname, not the raw URL.
const PARTNER_CENTER_HOSTS = [
  "partner.microsoft.com",
  "storedeveloper.microsoft.com",
];

/**
 * True when `pageUrl` parses and its hostname is a Partner Center host or a
 * subdomain of one.
 */
export function isPartnerCenterUrl(pageUrl) {
  let hostname;
  try {
    hostname = new URL(pageUrl).hostname;
  } catch {
    return false;
  }
  return PARTNER_CENTER_HOSTS.some(
    (host) => hostname === host || hostname.endsWith("." + host),
  );
}
