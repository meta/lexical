/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/migrate/1to2: the frozen step from layout 1 to layout 2.
// EXPERIMENTAL. FROZEN: a change to what it writes bumps `revision` and
// adds golden fixtures; the existing ones are never regenerated.
//
// It writes nothing but what the runner records (`lexical-y:2` and the
// epoch): layout 2 only adds member entries of set-valued NodeState, and
// the binding reads every layout 1 document the same at layout 2 (see
// ./1to2/frozen/read.ts). It keeps the chain uniform, so a layout 1
// document reaches any later layout through the same links as a layout 2
// one. A stamped document opens read only in releases that read layout 1
// only, as any document with a member entry already does.

import type {YLayoutMigration} from '../internal/Runner';
import type {Node as YNode, Transaction} from '@y/y';

import {readLayout12} from './1to2/frozen/read';

const step1to2: YLayoutMigration = {
  checkAfter(_container: YNode): readonly string[] {
    // Layout 2 adds no invariant a layout 1 container could break.
    return [];
  },
  from: 1,
  id: 'lexical-y/layout/1to2',
  migrateContainer(_tr: Transaction, _container: YNode): void {
    // Nothing: the runner records layout 2 and the epoch.
  },
  readAfter: readLayout12,
  readBefore: readLayout12,
  revision: 1,
  rewrites(_key: string): boolean {
    return false;
  },
  to: 2,
  v: 1,
};

export default step1to2;
