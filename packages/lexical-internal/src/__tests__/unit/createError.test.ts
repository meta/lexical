/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {expect, test} from 'vitest';

import createDevError from '../../createDevError';
import createError from '../../createError';
import createProdError from '../../createProdError';
import formatProdErrorMessage from '../../formatProdErrorMessage';

test('constructs a development error without throwing and interpolates literal arguments', () => {
  const error = createError('Expected %s, got %s.', '$& %s', 'a%b');
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('Expected $& %s, got a%b.');
  // Runtime formatting must preserve placeholders introduced by arguments.
  expect(createDevError(error.message).message).toBe(error.message);
});

test('constructs a production error with a decoder URL and encoded arguments', () => {
  const error = createProdError('123', 'a & b', 'é/%');
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('Minified Lexical error #123;');
  expect(error.message).toContain(
    'https://lexical.dev/docs/error?code=123&v=a+%26+b&v=%C3%A9%2F%25',
  );
  expect(() => formatProdErrorMessage('123', 'a & b', 'é/%')).toThrow(
    error.message,
  );
});

test('leaves reporting and throwing to the caller', () => {
  const failure = new Error('handler failed');
  const report = (error: Error) => {
    expect(error.message).toBe('warning');
    throw failure;
  };
  expect(() => report(createError('warning'))).toThrow(failure);
});
