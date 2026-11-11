#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Integration test to verify @lexical/eslint-plugin works with every
 * supported ESLint major (9 and 10), each loading the published build through
 * the same flat eslint.config.js.
 *
 * This test uses pnpm dlx to run different ESLint versions without
 * modifying package.json or pnpm-lock.yaml
 */
/* eslint-disable no-console */

import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FLAT_CONFIG_DIR = path.join(FIXTURES_DIR, 'flat-config');
const ESLINT_VERSIONS = ['9', '10'];

// ANSI color codes
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const BOLD = '\x1b[1m';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(message, color = RESET) {
  console.log(`${color}${message}${RESET}`);
}

function logTest(name, passed, details = '') {
  totalTests++;
  if (passed) {
    passedTests++;
    log(`  ✓ ${name}`, GREEN);
  } else {
    failedTests++;
    log(`  ✗ ${name}`, RED);
    if (details) {
      log(`    ${details}`, YELLOW);
    }
  }
}

function runESLint(version, configDir, configFile, file, shouldFail = false) {
  const testName = `ESLint ${version} - ${path.basename(file)} (${shouldFail ? 'should fail' : 'should pass'})`;

  // Copy the file into the config directory to ensure consistent behavior
  // and avoid parent config file discovery issues
  const fileName = path.basename(file);
  const copiedFile = path.join(configDir, fileName);
  try {
    fs.copyFileSync(file, copiedFile);
  } catch (error) {
    logTest(testName, false, `Failed to copy test file: ${error.message}`);
    return false;
  }

  try {
    // Use -c with relative path (relative to cwd) to explicitly specify config
    const cmd = `pnpm dlx eslint@${version} --no-ignore -c "${configFile}" "${fileName}"`;
    const _output = execSync(cmd, {
      cwd: configDir,
      encoding: 'utf8',
      shell: '/bin/bash',
      stdio: 'pipe',
    });

    // Clean up copied file
    if (fs.existsSync(copiedFile)) {
      fs.unlinkSync(copiedFile);
    }

    // If we expected it to fail but it passed
    if (shouldFail) {
      logTest(
        testName,
        false,
        'Expected ESLint to report errors but it passed',
      );
      return false;
    }

    logTest(testName, true);
    return true;
  } catch (error) {
    // Clean up copied file
    if (fs.existsSync(copiedFile)) {
      fs.unlinkSync(copiedFile);
    }

    const output = error.stdout + error.stderr;

    // If we expected it to fail and it did
    if (shouldFail) {
      // Verify it failed for the right reason (rules-of-lexical)
      if (
        output.includes('@lexical/rules-of-lexical') ||
        output.includes('rules-of-lexical')
      ) {
        logTest(testName, true);
        return true;
      } else {
        logTest(testName, false, 'Failed but not due to rules-of-lexical rule');
        return false;
      }
    }

    // If we expected it to pass but it failed
    logTest(testName, false, error.message.split('\n')[0]);
    return false;
  }
}

function testFlatConfig(version) {
  log(`\n${BOLD}${BLUE}Testing ESLint ${version} (Flat Config)${RESET}`);
  log(`Directory: ${FLAT_CONFIG_DIR}`);

  // Check if config exists
  const configPath = path.join(FLAT_CONFIG_DIR, 'eslint.config.js');
  if (!fs.existsSync(configPath)) {
    log(`  ✗ Config file not found: ${configPath}`, RED);
    return false;
  }

  runESLint(
    version,
    FLAT_CONFIG_DIR,
    'eslint.config.js',
    path.join(FIXTURES_DIR, 'valid.js'),
    false,
  );
  runESLint(
    version,
    FLAT_CONFIG_DIR,
    'eslint.config.js',
    path.join(FIXTURES_DIR, 'invalid.js'),
    true,
  );
}

function setupFixtures() {
  log(`\n${BOLD}${BLUE}Setting up test fixtures...${RESET}`);

  [FLAT_CONFIG_DIR].forEach(cwd => {
    try {
      log(`  Installing dependencies for ${path.basename(cwd)} fixture...`);
      execSync('pnpm install --no-lockfile', {
        cwd,
        stdio: 'pipe',
      });
      log(`  ✓ ${path.basename(cwd)} fixture ready`, GREEN);
    } catch (error) {
      log(
        `  ✗ Failed to setup ${path.basename(cwd)} fixture: ${error.message}`,
        RED,
      );
      throw error;
    }
  });
}

function main() {
  log(`${BOLD}${'='.repeat(70)}${RESET}`);
  log(`${BOLD}ESLint Plugin Integration Tests${RESET}`);
  log(`${BOLD}${'='.repeat(70)}${RESET}`);
  log(`\nTesting @lexical/eslint-plugin compatibility with:`);
  for (const version of ESLINT_VERSIONS) {
    log(`  - ESLint ${version}.x (flat eslint.config.js)`);
  }

  try {
    setupFixtures();
    for (const version of ESLINT_VERSIONS) {
      testFlatConfig(version);
    }

    log(`\n${BOLD}${'='.repeat(70)}${RESET}`);
    log(`${BOLD}Test Summary${RESET}`);
    log(`${BOLD}${'='.repeat(70)}${RESET}`);
    log(`Total tests: ${totalTests}`);
    log(`Passed: ${passedTests}`, GREEN);

    if (failedTests > 0) {
      log(`Failed: ${failedTests}`, RED);
      log(`\n${RED}${BOLD}✗ Some tests failed${RESET}`);
      process.exit(1);
    } else {
      log(`\n${GREEN}${BOLD}✓ All tests passed!${RESET}`);
      process.exit(0);
    }
  } catch (error) {
    log(`\n${RED}${BOLD}Fatal error: ${error.message}${RESET}`, RED);
    process.exit(1);
  }
}

main();
