/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {transformAsync} from '@babel/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {
  getBuildBabelOptions,
  shouldExtractCodes,
} from '../../shared/buildOptions.mjs';

test('preserves native fields and lowers static blocks for supported browsers', async () => {
  const result = await transformAsync(
    `export class Example {
      value: string = 'ok';
      static { this.ready = true; }
    }`,
    {...getBuildBabelOptions(true), filename: 'Example.ts'},
  );
  expect(result?.code).toContain("value = 'ok'");
  expect(result?.code).not.toMatch(/static\s*\{/);
  expect(result?.code).toContain('export class Example');
});

describe('shouldExtractCodes', () => {
  test('is off by default', () => {
    expect(shouldExtractCodes(undefined, {})).toBe(false);
    expect(shouldExtractCodes(false, {})).toBe(false);
  });

  test('is on with --codes', () => {
    expect(shouldExtractCodes(true, {})).toBe(true);
    expect(shouldExtractCodes(true, {LEXICAL_EXTRACT_CODES: 'false'})).toBe(
      true,
    );
  });

  test.each(['true', '1', 'yes', 'on', 'TRUE', ' true '])(
    'is on with LEXICAL_EXTRACT_CODES=%j',
    value => {
      expect(
        shouldExtractCodes(undefined, {LEXICAL_EXTRACT_CODES: value}),
      ).toBe(true);
    },
  );

  test.each(['false', '0', 'no', 'off', ''])(
    'is off with LEXICAL_EXTRACT_CODES=%j',
    value => {
      expect(
        shouldExtractCodes(undefined, {LEXICAL_EXTRACT_CODES: value}),
      ).toBe(false);
    },
  );

  test('refuses a value it does not recognize', () => {
    expect(() =>
      shouldExtractCodes(undefined, {LEXICAL_EXTRACT_CODES: 'ture'}),
    ).toThrow('Unrecognized LEXICAL_EXTRACT_CODES="ture"');
  });
});

describe('package.json scripts', () => {
  const {scripts} = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../package.json'),
      'utf8',
    ),
  );

  test('release builds do not extract codes unless asked to', () => {
    expect(scripts['build-release']).not.toMatch(/--codes\b/);
  });

  test('extract-codes extracts them', () => {
    expect(scripts['extract-codes']).toMatch(/--codes\b/);
  });
});

describe('production build of an error message', () => {
  // A copy of the real codes.json per build, so each build starts from a
  // fresh ErrorMap the way a separate CI run does, and nothing writes to the
  // repository's codes.json.
  const realCodesPath = path.resolve(
    import.meta.dirname,
    '../../error-codes/codes.json',
  );
  const codes: Record<string, string> = JSON.parse(
    fs.readFileSync(realCodesPath, 'utf8'),
  );
  const unknownMessage = 'A message codes.json does not have %s';

  let tmpdir: string;
  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-codes-'));
  });
  afterEach(() => {
    fs.rmSync(tmpdir, {force: true, recursive: true});
  });

  function knownMessage(): [string, string] {
    const counts = new Map<string, number>();
    for (const message of Object.values(codes)) {
      counts.set(message, (counts.get(message) ?? 0) + 1);
    }
    return Object.entries(codes).find(
      ([, message]) => !message.includes('%s') && counts.get(message) === 1,
    )!;
  }

  async function build(
    name: string,
    env: Record<string, string>,
  ): Promise<{code: string; codes: Record<string, string>}> {
    const errorCodesPath = path.join(tmpdir, `${name}.json`);
    fs.copyFileSync(realCodesPath, errorCodesPath);
    // `pnpm run build-release` passes no --codes.
    const options = getBuildBabelOptions(
      true,
      shouldExtractCodes(undefined, env),
    );
    const result = await transformAsync(
      `invariant(condition, ${JSON.stringify(knownMessage()[1])});
       invariant(condition, ${JSON.stringify(unknownMessage)}, detail);`,
      {
        ...options,
        filename: 'Example.ts',
        plugins: options.plugins!.map(plugin => {
          const [fn, opts] = plugin as [unknown, object];
          return [fn, {...opts, errorCodesPath}];
        }),
      },
    );
    // The ErrorMap flushes new codes in a microtask.
    await new Promise<void>(resolve => queueMicrotask(resolve));
    return {
      code: result!.code!,
      codes: JSON.parse(fs.readFileSync(errorCodesPath, 'utf8')),
    };
  }

  test('by default, keeps an unknown message as text in every build', async () => {
    expect(Object.values(codes)).not.toContain(unknownMessage);
    const first = await build('first', {});
    const second = await build('second', {});
    expect(second.code).toBe(first.code);
    expect(first.code).toMatch(
      new RegExp(`formatProdErrorMessage\\w*\\)?\\(${knownMessage()[0]}\\)`),
    );
    expect(first.code).toContain(
      'FIXME (minify-errors-in-prod): Unminified error message in production build!',
    );
    expect(first.code).toContain(
      'A message codes.json does not have ${detail}',
    );
    expect(first.codes).toEqual(codes);
    expect(second.codes).toEqual(codes);
  });

  test('with LEXICAL_EXTRACT_CODES=true, assigns the unknown message a new code', async () => {
    const {code, codes: after} = await build('extract', {
      LEXICAL_EXTRACT_CODES: 'true',
    });
    const newCode = String(Math.max(...Object.keys(codes).map(Number)) + 1);
    expect(after).toEqual({...codes, [newCode]: unknownMessage});
    expect(code).toMatch(
      new RegExp(`formatProdErrorMessage\\w*\\)?\\(${newCode}, detail\\)`),
    );
    expect(code).not.toContain('A message codes.json does not have');
  });
});
