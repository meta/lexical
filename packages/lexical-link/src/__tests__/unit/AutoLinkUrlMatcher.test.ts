/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {assert, describe, expect, test} from 'vitest';

import {autoLinkUrlMatcher as urlMatcher} from '../../LexicalAutoLinkExtension';

describe('autoLinkUrlMatcher', () => {
  test.for([
    {
      expected: 'https://google.com',
      input: 'https://google.com',
      label: 'https',
    },
    {
      expected: 'www.example.com',
      input: 'www.example.com',
      label: 'www prefix',
    },
    {
      expected: 'https://example.com/path?q=1#hash',
      input: 'https://example.com/path?q=1#hash',
      label: 'path+query+hash',
    },
    {
      expected: 'https://example.com:8080/api',
      input: 'https://example.com:8080/api',
      label: 'port',
    },
  ])('matches ASCII URL: $label', ({input, expected}) => {
    const result = urlMatcher(input);
    assert(result !== null);
    expect(result.text).toBe(expected);
  });

  test.for([
    {
      expected: 'https://qabilah.com/posts/عربي',
      input: 'https://qabilah.com/posts/عربي',
      label: 'Arabic path',
    },
    {
      expected: 'https://예시.한국',
      input: 'https://예시.한국',
      label: 'Korean IDN',
    },
    {
      expected: 'https://пример.рф',
      input: 'https://пример.рф',
      label: 'Cyrillic IDN',
    },
    {
      expected: 'https://例子.中国/测试',
      input: 'https://例子.中国/测试',
      label: 'CJK IDN+path',
    },
    {
      expected: 'http://예시.한국/경로?키=값#부분',
      input: 'http://예시.한국/경로?키=값#부분',
      label: 'Korean full URL',
    },
    {
      expected: 'http://مثال.موقع/مسار?مفتاح=قيمة#قسم',
      input: 'http://مثال.موقع/مسار?مفتاح=قيمة#قسم',
      label: 'Arabic full URL',
    },
  ])('matches Unicode URL: $label', ({input, expected}) => {
    const result = urlMatcher(input);
    assert(result !== null);
    expect(result.text).toBe(expected);
  });

  test.for([
    {
      expected: 'https://google.com',
      input: 'hello https://google.com world',
      label: 'ASCII surrounded',
    },
    {
      expected: 'https://qabilah.com/posts/عربي',
      input: 'مرحبا https://qabilah.com/posts/عربي end',
      label: 'Arabic surrounded',
    },
    {
      expected: 'https://예시.한국',
      input: '텍스트 https://예시.한국 끝',
      label: 'Korean surrounded',
    },
    {
      expected: 'www.예시.한국',
      input: 'go www.예시.한국 end',
      label: 'www Korean IDN',
    },
  ])('extracts URL from surrounding text: $label', ({input, expected}) => {
    const result = urlMatcher(input);
    assert(result !== null);
    expect(result.text).toBe(expected);
  });

  test.for([
    {
      expected: 'https://google.com',
      input: 'see https://google.com, ok',
      label: 'trailing comma',
    },
    {
      expected: 'https://google.com',
      input: 'see https://google.com. ok',
      label: 'trailing period',
    },
    {
      expected: 'https://예시.한국',
      input: 'see https://예시.한국, ok',
      label: 'Korean trailing comma',
    },
    {
      expected: 'https://예시.한국',
      input: 'see https://예시.한국. ok',
      label: 'Korean trailing period',
    },
  ])('excludes trailing punctuation: $label', ({input, expected}) => {
    const result = urlMatcher(input);
    assert(result !== null);
    expect(result.text).toBe(expected);
  });

  test.for([
    {
      expected: 'https://google.com',
      input: '(https://google.com)',
      label: 'wrapped in parens',
    },
    {
      expected: 'https://예시.한국',
      input: '(https://예시.한국)',
      label: 'Korean wrapped in parens',
    },
    {
      expected: 'https://en.wikipedia.org/wiki/Fish_(disambiguation)',
      input: 'https://en.wikipedia.org/wiki/Fish_(disambiguation)',
      label: 'Wikipedia balanced',
    },
    {
      expected: 'https://example.com/a_(b_(c))',
      input: 'https://example.com/a_(b_(c))',
      label: 'nested balanced',
    },
  ])('handles parentheses correctly: $label', ({input, expected}) => {
    const result = urlMatcher(input);
    assert(result !== null);
    expect(result.text).toBe(expected);
  });

  test.for([
    {
      expected: 'https://www.example.com',
      input: 'www.example.com',
      label: 'www gets https',
    },
    {
      expected: 'https://www.예시.한국',
      input: 'www.예시.한국',
      label: 'Korean www gets https',
    },
    {
      expected: 'https://google.com',
      input: 'https://google.com',
      label: 'https stays',
    },
    {
      expected: 'http://пример.рф',
      input: 'http://пример.рф',
      label: 'http stays',
    },
  ])('sets correct url for: $label', ({input, expected}) => {
    const result = urlMatcher(input);
    assert(result !== null);
    expect(result.url).toBe(expected);
  });

  test.for([
    {input: 'just text no url', label: 'plain text'},
    {input: 'http:// alone', label: 'bare protocol'},
    {input: '', label: 'empty string'},
  ])('returns null for non-URL: $label', ({input}) => {
    expect(urlMatcher(input)).toBeNull();
  });
});
