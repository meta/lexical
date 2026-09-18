/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {describe, expect, test} from 'vitest';

import {sanitizeUrl, validateUrl} from '../../utils/url';

describe('validateUrl', () => {
  // Ports, parenthesised paths, hash routes and a comma in the query are the
  // cases an anchored hand written pattern kept getting wrong. The URL parser
  // gets all of them right because it is a parser.
  test.each([
    'https://example.com',
    'http://localhost:3000',
    'https://example.com:8080/path',
    'https://en.wikipedia.org/wiki/Foo_(bar)',
    'https://example.com/#/spa/route',
    'https://example.com/?a=1,2',
    'https://ru.wikipedia.org/wiki/Кириллица',
    'www.example.com',
    'mailto:someone@example.com',
    // tel: and sms: are on the supported protocol list but never validated
    // before: the old pattern wanted a host after the scheme and `+` was not
    // in its host class.
    'tel:+15551234',
    'sms:+15551234',
  ])('accepts %j', url => {
    expect(validateUrl(url)).toBe(true);
  });

  // A URL copied off its own line carries a newline. The URL parser ignores
  // trailing whitespace, and so does the `href` attribute, so the link still
  // resolves to the URL and nothing here has to trim.
  test.each(['https://example.com\n', 'https://example.com  '])(
    'accepts the trailing whitespace in %j',
    url => {
      expect(validateUrl(url)).toBe(true);
    },
  );

  // Leading whitespace is a different case, because the caller stores the
  // string as it arrived and `formatUrl` in @lexical/link prepends a scheme in
  // front of the whitespace at render: `  https://example.com` becomes the href
  // `https://  https://example.com`, which resolves to nothing, and a leading
  // tab or newline becomes a link to the host `https`.
  test.each([
    '  https://example.com  ',
    '\thttps://example.com',
    '\nhttps://example.com',
  ])('rejects the leading whitespace in %j', url => {
    expect(validateUrl(url)).toBe(false);
  });

  // A string that merely contains a URL is not a URL.
  test.each([
    'check out https://example.com today',
    'see https://example.com',
    'https://example.com and then some',
    'just some prose',
    'aspect ratio:3 is best',
    'ratio:3',
    'a b',
  ])('rejects %j', url => {
    expect(validateUrl(url)).toBe(false);
  });

  // Interior whitespace has to be rejected here rather than left to the
  // parser: the parser deletes every ASCII tab and newline anywhere in its
  // input, which splices a two line paste into a single host.
  test.each([
    'https://example.com\nfoo',
    'https://example.com\nhttps://other.example.com',
    'https://exam\tple.com',
    'https://example.com/a b',
  ])('rejects %j, which the parser would otherwise splice', url => {
    expect(validateUrl(url)).toBe(false);
  });

  // Validation now uses the protocol list `sanitizeUrl` already uses, so a
  // scheme that would be neutralized at render is refused when the link is
  // created rather than being created dead.
  test.each([
    // eslint-disable-next-line no-script-url
    'javascript:alert(1)',
    // eslint-disable-next-line no-script-url
    'JaVaScRiPt:alert(1)',
    'data:text/html,hello',
    'vbscript:msgbox(1)',
    'ftp://example.com/file.txt',
    'file:///etc/hosts',
    // A bare host and port is a scheme and a path to the parser, and to
    // `LinkNode.sanitizeUrl` at render, which is why all three of these are
    // already `about:blank` links today rather than working ones.
    'localhost:3000',
    'www.example.com:8080',
  ])('rejects the unsupported protocol in %j', url => {
    expect(validateUrl(url)).toBe(false);
  });

  // `www.` on its own is a prefix, not a host.
  test('rejects a bare "www."', () => {
    expect(validateUrl('www.')).toBe(false);
  });

  // The link insertion UI seeds its input with this placeholder, so it has to
  // pass validation even though it is not a URL. See the TODO in url.ts.
  test('accepts the "https://" placeholder', () => {
    expect(validateUrl('https://')).toBe(true);
  });

  // `registerLink` hands this whatever `clipboardData.getData()` returned, and
  // that is not always a string: a DataTransfer stand in can return undefined
  // for a type it was never given. It has to stay falsy rather than throw
  // inside the paste listener, which is where the value arrives.
  test.each([undefined, null])(
    'returns false for %j rather than throwing',
    value => {
      expect(validateUrl(value as unknown as string)).toBe(false);
    },
  );
});

describe('sanitizeUrl', () => {
  test.each(['https://example.com', 'mailto:someone@example.com', 'tel:+1555'])(
    'passes %j through unchanged',
    url => {
      expect(sanitizeUrl(url)).toBe(url);
    },
  );

  test.each([
    // eslint-disable-next-line no-script-url
    'javascript:alert(1)',
    'data:text/html,hello',
    'ftp://example.com',
  ])('neutralizes %j', url => {
    expect(sanitizeUrl(url)).toBe('about:blank');
  });

  // Unparseable input comes back as it went in, which is what the callers that
  // feed it a half typed URL depend on.
  test('returns an unparseable string unchanged', () => {
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });
});
