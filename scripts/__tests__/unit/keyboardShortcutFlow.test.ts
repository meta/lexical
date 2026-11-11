/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import {createRequire} from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, expect, it} from 'vitest';

const require = createRequire(import.meta.url);
const flowBinary: string = require('flow-bin');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-keyboard-flow-'));
  fs.copyFileSync(
    'packages/lexical/flow/Lexical.js.flow',
    path.join(dir, 'Lexical.js.flow'),
  );
  fs.cpSync('flow-typed', path.join(dir, 'flow-typed'), {recursive: true});
  fs.writeFileSync(
    path.join(dir, '.flowconfig'),
    `[declarations]\n.*/flow-typed/.*\n[libs]\n./flow-typed\n[options]\nmodule.name_mapper='^lexical$' -> '<PROJECT_ROOT>/Lexical.js.flow'\n`,
  );
});

afterEach(() => fs.rmSync(dir, {force: true, recursive: true}));

it.each([
  {
    code: `
      import type {CompiledKeyboardShortcuts, KeyboardShortcutMatch} from 'lexical';
      import {compileKeyboardShortcuts} from 'lexical';
      const shortcuts: CompiledKeyboardShortcuts<KeyboardShortcutMatch> = compileKeyboardShortcuts([{key: 'x'}]);
      shortcuts.add({key: 'y'});
    `,
    message: 'Found 0 errors',
    name: 'accepts the type and runtime factory',
    status: 0,
  },
  {
    code: `import {CompiledKeyboardShortcuts} from 'lexical'; new CompiledKeyboardShortcuts();`,
    message: '[import-type-as-value]',
    name: 'rejects construction through a nonexistent runtime export',
    status: 2,
  },
])(
  'keyboard shortcut Flow API $name',
  ({code, message, status}) => {
    fs.writeFileSync(path.join(dir, 'consumer.js'), `// @flow\n${code}\n`);
    const result = spawnSync(flowBinary, ['full-check', dir], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(result.stdout).toContain(message);
  },
  25_000,
);
