/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Captures screenshots of each example for the gallery page.
 *
 * Usage:
 *   pnpm run capture-gallery-screenshots                # all examples
 *   pnpm run capture-gallery-screenshots markdown-editor # one or more
 *   pnpm run capture-gallery-screenshots website-toolbar website-rich-input
 *
 * Each positional argument is matched against the example's `dir`
 * (the folder name under examples/). Unknown names exit non-zero so
 * typos don't silently no-op.
 *
 * Prerequisites:
 *   - Playwright browsers installed (npx playwright install chromium)
 *
 * Output:
 *   Screenshots are saved to packages/lexical-website/static/img/gallery/
 *
 * Example list is defined in packages/lexical-website/src/components/Gallery/galleryExamples.ts.
 */

import {type ChildProcess, execSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, unlinkSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  type GalleryExample,
  galleryExamples,
} from '../packages/lexical-website/src/components/Gallery/galleryExamples';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GALLERY_DIR = resolve(
  ROOT,
  'packages/lexical-website/static/img/gallery',
);

// Only screenshot examples that have a waitForSelector configured
const SCREENSHOTABLE = galleryExamples.filter(
  (ex): ex is GalleryExample & {waitForSelector: string} =>
    ex.waitForSelector != null,
);

// Optional positional args: example dir names to refresh. If none
// are provided, all screenshotable examples are captured.
const requestedDirs = process.argv.slice(2);
const unknown = requestedDirs.filter(
  dir => !galleryExamples.some(ex => ex.dir === dir),
);
if (unknown.length > 0) {
  const known = galleryExamples
    .map(ex => `  ${ex.dir}`)
    .sort()
    .join('\n');
  console.error(
    `Unknown example name(s): ${unknown.join(', ')}\n` +
      `Available examples:\n${known}`,
  );
  process.exit(1);
}
const EXAMPLES =
  requestedDirs.length === 0
    ? SCREENSHOTABLE
    : SCREENSHOTABLE.filter(ex => requestedDirs.includes(ex.dir));
if (EXAMPLES.length === 0) {
  console.error(
    'None of the requested examples have a waitForSelector configured.',
  );
  process.exit(1);
}

const PORT = 5180;
const IS_WINDOWS = process.platform === 'win32';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function waitForServer(port: number, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  return new Promise((onResolve, onReject) => {
    const check = async () => {
      try {
        const resp = await fetch(`http://localhost:${port}`);
        if (resp.ok || resp.status === 304) {
          onResolve();
          return;
        }
      } catch {
        // Server not ready yet
      }
      if (Date.now() - start > timeoutMs) {
        onReject(
          new Error(
            `Server on port ${port} did not start within ${timeoutMs}ms`,
          ),
        );
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

function installDeps(exampleDir: string): void {
  // The example's own pnpm-workspace.yaml makes its directory the workspace
  // root, so this installs the example's own deps rather than running the
  // monorepo workspace install. --ignore-workspace would suppress that file
  // along with the example's overrides and build-script decisions.
  // shell: true isolates the child from the tsx loader. @types/node narrows
  // `ExecSyncOptions.shell` to `string`, but Node forwards a boolean to the
  // underlying spawnSync at runtime, so the value is cast to satisfy the types.
  execSync('pnpm install', {
    cwd: exampleDir,
    shell: true as unknown as string,
    stdio: 'pipe',
  });
  // Run the prepare script if it exists (e.g. svelte-kit sync)
  try {
    execSync('pnpm run --if-present prepare', {
      cwd: exampleDir,
      shell: true as unknown as string,
      stdio: 'pipe',
    });
  } catch {
    // prepare is optional
  }
  // Remove the lockfile created for this standalone install
  const lockfile = resolve(exampleDir, 'pnpm-lock.yaml');
  if (existsSync(lockfile)) {
    unlinkSync(lockfile);
  }
}

function getViteConfig(exampleDir: string, explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const monorepo = resolve(exampleDir, 'vite.config.monorepo.ts');
  return existsSync(monorepo) ? 'vite.config.monorepo.ts' : 'vite.config.ts';
}

function startDevServer(
  exampleDir: string,
  port: number,
  viteConfig: string,
): ChildProcess {
  const child = spawn(
    IS_WINDOWS ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'vite', '-c', viteConfig, '--port', String(port), '--strictPort'],
    {
      cwd: exampleDir,
      env: {...process.env, NODE_ENV: 'development'},
      stdio: 'pipe',
      // On Unix, create a process group so we can kill the tree
      ...(IS_WINDOWS ? {} : {detached: true}),
    },
  );

  child.stderr.on('data', (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes('ERROR') || msg.includes('error')) {
      console.error(`  [vite stderr] ${msg.trim()}`);
    }
  });

  return child;
}

function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid == null) {
    return;
  }
  try {
    if (IS_WINDOWS) {
      // taskkill /T kills the process tree on Windows
      execSync(`taskkill /T /F /PID ${child.pid}`, {stdio: 'pipe'});
    } else {
      // Kill the process group (negative pid) on Unix
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // Process may already be dead
  }
}

async function main(): Promise<void> {
  // Ensure output dir exists
  mkdirSync(GALLERY_DIR, {recursive: true});

  // Import chromium from @playwright/test (a direct dependency)
  const {chromium} = await import('@playwright/test');

  const browser = await chromium.launch();

  console.warn(`Capturing screenshots for ${EXAMPLES.length} examples...\n`);

  for (let i = 0; i < EXAMPLES.length; i++) {
    const example = EXAMPLES[i];
    const exampleDir = resolve(ROOT, 'examples', example.dir);
    const outPath = resolve(GALLERY_DIR, `${example.dir}.png`);

    console.warn(`[${i + 1}/${EXAMPLES.length}] ${example.dir}`);

    if (!existsSync(exampleDir)) {
      console.error(`  Example directory not found: ${exampleDir}`);
      continue;
    }

    // Install deps if needed
    if (!existsSync(resolve(exampleDir, 'node_modules'))) {
      console.warn(`  Installing dependencies...`);
      installDeps(exampleDir);
    }

    // Start dev server
    const viteConfig = getViteConfig(exampleDir, example.viteConfig);
    console.warn(`  Starting dev server on port ${PORT} (${viteConfig})...`);
    const child = startDevServer(exampleDir, PORT, viteConfig);

    try {
      await waitForServer(PORT);
      console.warn('  Server is ready.');

      const page = await browser.newPage({
        viewport: {height: 800, width: 1200},
      });

      await page.goto(`http://localhost:${PORT}`, {
        waitUntil: 'networkidle',
      });

      // Wait for the editor content to render
      await page.waitForSelector(example.waitForSelector, {timeout: 15000});
      // Give a moment for any animations/styles to settle
      await page.waitForTimeout(1000);

      await page.screenshot({fullPage: false, path: outPath});
      console.warn(`  Screenshot saved: ${outPath}`);

      await page.close();
    } catch (err) {
      console.error(
        `  Error capturing ${example.dir}: ${(err as Error).message}`,
      );
    } finally {
      killProcessTree(child);
      // Brief pause to let the port free up before the next server
      await sleep(500);
    }
  }

  await browser.close();
  console.warn('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
