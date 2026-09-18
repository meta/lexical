/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

const SUPPORTED_URL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'sms:',
  'tel:',
]);

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function sanitizeUrl(url: string): string {
  const parsedUrl = parseUrl(url);

  if (parsedUrl !== null && !SUPPORTED_URL_PROTOCOLS.has(parsedUrl.protocol)) {
    return 'about:blank';
  }
  return url;
}

// A URL is a single token, and the caller stores the string exactly as it
// arrived, so what is validated here is that string rather than a tidied up
// copy of it.
//
// Trailing whitespace is tolerated: a URL copied off its own line carries a
// newline, and the URL parser and the `href` attribute both ignore it, so the
// link still resolves to the URL. Leading whitespace is not tolerated, because
// the stored string keeps it and `formatUrl` in @lexical/link then prepends a
// scheme in front of it: `  https://example.com` becomes the unresolvable href
// `https://  https://example.com`, and a leading tab or newline becomes a link
// to the host `https`.
//
// Interior whitespace is the one place the parser cannot be trusted on its own.
// It deletes every ASCII tab and newline anywhere in its input, so a two line
// paste of `https://example.com` followed by `foo` would otherwise parse as the
// single host `example.comfoo`.
//
// Anchored, and the two quantifiers match disjoint character classes, so no
// input makes them backtrack.
const SINGLE_TOKEN_REGEXP = /^\S*\s*$/;

// A `www.` host carries no scheme for the parser to find, so it is given the
// one `formatUrl` would give it at render. `\S` keeps a bare `www.` out.
const WWW_HOST_REGEXP = /^www\.\S/;

export function validateUrl(url: string): boolean {
  // TODO Fix UI for link insertion; it should never default to an invalid URL such as https://.
  // Maybe show a dialog where they user can type the URL before inserting it.

  // Callers reach this with whatever `clipboardData.getData()` returned, and
  // that is not always a string: a DataTransfer stand in can hand back
  // undefined for a type it was never given.
  if (typeof url !== 'string') {
    return false;
  }
  if (url === 'https://') {
    return true;
  }
  if (!SINGLE_TOKEN_REGEXP.test(url)) {
    return false;
  }
  // `new URL()` consumes the whole string or throws, so it is anchored by
  // construction, and it is the same parser `sanitizeUrl` above already trusts
  // to decide which protocols are safe to render.
  let parsed = parseUrl(url);
  if (parsed === null && WWW_HOST_REGEXP.test(url)) {
    parsed = parseUrl(`https://${url}`);
  }
  return parsed !== null && SUPPORTED_URL_PROTOCOLS.has(parsed.protocol);
}
