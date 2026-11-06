/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-console -- This reporter intentionally writes test timings to CI logs. */

// Keep timings in successful CI logs too, so the longest matrix job can be
// optimized without relying on failure-only traces or artifacts.
export default class TimingReporter {
  tests = [];
  initialization = [];
  api = new Map();

  onStepEnd(test, result, step) {
    if (
      step.category === 'test.step' &&
      step.title === 'Initialize playground'
    ) {
      this.initialization.push(step.duration);
    }
    if (step.category === 'pw:api') {
      // Group methods, not selectors or arguments that differ between tests.
      const name = step.title.split('(')[0];
      const entry = this.api.get(name) || {count: 0, duration: 0};
      entry.count++;
      entry.duration += step.duration;
      this.api.set(name, entry);
    }
  }

  onTestEnd(test, result) {
    if (result.status !== 'skipped') {
      this.tests.push({
        duration: result.duration,
        title: test.titlePath().filter(Boolean).join(' > '),
      });
    }
  }

  onEnd(result) {
    const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
    const total = values => values.reduce((sum, value) => sum + value, 0);
    console.log(`\nE2E timings: ${seconds(result.duration)} elapsed`);
    console.log(
      `Playground initialization: ${this.initialization.length} calls, ${seconds(total(this.initialization))} summed across workers`,
    );
    console.log('Slowest test attempts (including setup and teardown):');
    for (const test of this.tests
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 20)) {
      console.log(`  ${seconds(test.duration)} ${test.title}`);
    }
    // API times may overlap with initialization and parallel calls. These are
    // attribution totals, not an additive breakdown of elapsed wall time.
    console.log('Slowest Playwright methods (summed calls, may overlap):');
    for (const [name, value] of [...this.api]
      .sort((a, b) => b[1].duration - a[1].duration)
      .slice(0, 15)) {
      console.log(
        `  ${seconds(value.duration)} / ${value.count} calls: ${name}`,
      );
    }
  }
}
