/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Compare production bundles in one process, rotating measurement order to
// reduce drift between revisions. Uses the current benchmark for every ref.
// node scripts/bench-get-writable.mjs <base-ref> [other-refs...]
import {transformAsync} from '@babel/core';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {cpus, tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {getBuildBabelOptions} from './shared/buildOptions.mjs';
import {optimizeBenchmark} from './shared/optimizeBenchmark.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const refs = process.argv.slice(2);
if (refs.length === 0) {
  throw new Error(
    'Usage: node scripts/bench-get-writable.mjs <base-ref> [other-refs...]',
  );
}
/** @param {string[]} args */
const git = args =>
  execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
/** @type {Array<{label: string, sha: string | null}>} */
const revisions = refs.map(ref => ({
  label: ref,
  sha: git(['rev-parse', '--verify', `${ref}^{commit}`]),
}));
revisions.push({label: 'WORKTREE', sha: null});
const benchmark = 'packages/lexical/src/__bench__/getWritable.bench.ts';
const filter = new RegExp(process.env.LEXICAL_BENCH_FILTER || '');
const sampleCount = Number(process.env.LEXICAL_BENCH_SAMPLES || 9);
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
  throw new Error('LEXICAL_BENCH_SAMPLES must be a positive integer');
}
const temporary = await mkdtemp(join(tmpdir(), 'lexical-get-writable-'));
/** @param {number[]} values */
const median = values =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
/**
 * @param {() => void} run
 * @param {number} milliseconds
 */
const measure = (run, milliseconds) => {
  const start = performance.now();
  let count = 0;
  let elapsed;
  do {
    run();
    count++;
    elapsed = performance.now() - start;
  } while (elapsed < milliseconds);
  return (elapsed * 1000) / count;
};

try {
  const variants = [];
  const bundles = [];
  for (let i = 0; i < revisions.length; i++) {
    const {sha} = revisions[i];
    // Include working-tree edits when deciding which files to load from git.
    const changed = new Set(
      sha === null
        ? []
        : git(['diff', '--name-only', sha, '--', 'packages']).split('\n'),
    );
    const outfile = join(temporary, `${i}.mjs`);
    const result = await build({
      bundle: true,
      define: {'process.env.NODE_ENV': '"production"'},
      format: 'esm',
      outfile,
      platform: 'node',
      plugins: [
        {
          name: 'revision-benchmark',
          setup(bundler) {
            bundler.onResolve({filter: /getWritable\.bench\.ts$/}, () => ({
              path: join(root, benchmark),
              sideEffects: true,
            }));
            bundler.onResolve({filter: /^vitest$/}, () => ({
              namespace: 'benchmark',
              path: 'vitest',
            }));
            bundler.onLoad({filter: /.*/, namespace: 'benchmark'}, () => ({
              contents: `
          export const cases = [];
          export const pendingTests = [];
          let group;
          export function describe(name, run) {group = name; run();}
          export function test(name, runTest) {
            const prefix = group;
            pendingTests.push(runTest({
              bench(name, options, run) {
                return {run() {
                  cases.push({
                    name: prefix + ' / ' + name,
                    run,
                    setup: options.beforeAll,
                    teardown: options.afterAll,
                  });
                }};
              },
            }));
          }
        `,
              loader: 'js',
            }));
            bundler.onLoad({filter: /\.(ts|tsx|mjs|js)$/}, async args => {
              if (args.path.includes('/node_modules/')) return;
              const path = relative(root, args.path);
              const source =
                changed.has(path) && !path.includes('/__bench__/')
                  ? git(['show', `${sha}:${path}`])
                  : await readFile(args.path, 'utf8');
              const transformed = await transformAsync(source, {
                ...getBuildBabelOptions(true),
                filename: args.path,
              });
              if (transformed === null || !transformed.code)
                throw new Error(`No Babel output for ${path}`);
              return {contents: transformed.code, loader: 'js'};
            });
          },
        },
      ],
      stdin: {
        contents: `import './${benchmark}'; export {cases, pendingTests} from 'vitest';`,
        loader: 'js',
        resolveDir: root,
      },
      target: 'esnext',
      tsconfig: join(root, 'tsconfig.test.json'),
      write: false,
    });
    const {code, eliminatedDevConstants} = await optimizeBenchmark(
      result.outputFiles[0].text,
    );
    await writeFile(outfile, code);
    bundles.push({bytes: Buffer.byteLength(code), eliminatedDevConstants});
    const {cases, pendingTests} = await import(pathToFileURL(outfile).href);
    await Promise.all(pendingTests);
    if (cases.length !== 12) {
      throw new Error(`Expected 12 workloads, got ${cases.length}`);
    }
    variants.push(cases);
  }
  console.log(
    JSON.stringify({
      bundles,
      cpu: cpus()[0].model,
      node: process.version,
      optimizer: 'babel-preset-env + terser (ecma 2021, passes 2)',
      revisions,
      sampleCount,
    }),
  );
  for (let index = 0; index < variants[0].length; index++) {
    const cases = variants.map(variant => variant[index]);
    if (!filter.test(cases[0].name)) {
      continue;
    }
    for (const workload of cases) {
      workload.setup();
      // Verify both halves of the text/format alternation before timing.
      for (let i = 0; i < 4; i++) {
        workload.run();
        workload.teardown();
      }
    }
    for (let warmup = 0; warmup < 3; warmup++) {
      for (const workload of cases) measure(workload.run, 250);
    }
    /** @type {number[][]} */
    const samples = cases.map(() => []);
    for (let round = 0; round < sampleCount; round++) {
      for (let offset = 0; offset < cases.length; offset++) {
        const i = (round + offset) % cases.length;
        samples[i].push(measure(cases[i].run, 350));
        cases[i].teardown();
      }
    }
    console.log(
      JSON.stringify({
        microseconds: Object.fromEntries(
          revisions.map(({label}, i) => [label, median(samples[i])]),
        ),
        name: cases[0].name,
        samples: Object.fromEntries(
          revisions.map(({label}, i) => [label, samples[i]]),
        ),
      }),
    );
  }
} finally {
  await rm(temporary, {force: true, recursive: true});
}
