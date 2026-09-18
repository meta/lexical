/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableNodeWithDimensions,
  getTableObserverFromTableElement,
  type HTMLTableElementWithWithTableSelectionState,
  TableExtension,
} from '@lexical/table';
import {
  $getRoot,
  defineExtension,
  type LexicalEditorWithDispose,
} from 'lexical';
import {afterEach, assert, beforeEach, describe, expect, it, vi} from 'vitest';

interface TrackedObserver {
  disconnectCount: number;
  targets: Node[];
}

describe('TableObserver tracking MutationObserver teardown (#9073)', () => {
  let editor: LexicalEditorWithDispose;
  let container: HTMLDivElement;
  let trackedObservers: TrackedObserver[];
  let RealMutationObserver: typeof MutationObserver;

  beforeEach(() => {
    // Instrument MutationObserver so the test can see the observer that
    // TableObserver.trackTable() creates (it is not otherwise reachable).
    trackedObservers = [];
    RealMutationObserver = globalThis.MutationObserver;
    globalThis.MutationObserver = class extends RealMutationObserver {
      tracked: TrackedObserver = {disconnectCount: 0, targets: []};
      constructor(callback: MutationCallback) {
        super(callback);
        trackedObservers.push(this.tracked);
      }
      observe(target: Node, options?: MutationObserverInit) {
        this.tracked.targets.push(target);
        super.observe(target, options);
      }
      disconnect() {
        this.tracked.disconnectCount++;
        super.disconnect();
      }
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [TableExtension],
        name: 'table-observer-test',
        theme: {tableScrollableWrapper: 'table-scrollable-wrapper'},
      }),
    );
    editor.setRootElement(container);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createTableNodeWithDimensions(2, 2, false));
      },
      {discrete: true},
    );
  });

  afterEach(() => {
    editor.dispose();
    document.body.removeChild(container);
    globalThis.MutationObserver = RealMutationObserver;
  });

  function getTableElement(): HTMLTableElementWithWithTableSelectionState {
    const tableElement = container.querySelector('table');
    assert(tableElement !== null, 'Expected table element');
    return tableElement as HTMLTableElementWithWithTableSelectionState;
  }

  function getTrackingObserver(
    tableElement: HTMLTableElement,
  ): TrackedObserver {
    const tracking = trackedObservers.filter(tracked =>
      tracked.targets.includes(tableElement),
    );
    expect(tracking.length).toBe(1);
    return tracking[0];
  }

  it('disconnects the tracking MutationObserver in removeListeners()', () => {
    const tableElement = getTableElement();
    const trackingObserver = getTrackingObserver(tableElement);
    expect(trackingObserver.disconnectCount).toBe(0);

    const tableObserver = getTableObserverFromTableElement(tableElement);
    assert(tableObserver !== null, 'Expected TableObserver on table element');
    tableObserver.removeListeners();

    expect(trackingObserver.disconnectCount).toBe(1);
  });

  it('does not fire the tracking MutationObserver for mutations of the detached table after editor teardown', async () => {
    const tableElement = getTableElement();
    const trackingObserver = getTrackingObserver(tableElement);

    // Swallow errors reported from MutationObserver microtasks (they bypass
    // editor onError) so a regression fails this test's assertions instead
    // of crashing the run with an unhandled error.
    const uncaughtErrors: string[] = [];
    const onWindowError = (event: ErrorEvent) => {
      uncaughtErrors.push(event.message);
      event.preventDefault();
    };
    window.addEventListener('error', onWindowError);
    try {
      // Queue a mutation record in the same task as teardown; disconnect()
      // must also clear the record queue so it is never delivered.
      tableElement.classList.add('queued-before-teardown');
      editor.dispose();
      expect(trackingObserver.disconnectCount).toBe(1);

      // The leaked-observer callback ran through editor.read(); after
      // teardown it must not run at all.
      const readSpy = vi.spyOn(editor, 'read');
      tableElement.classList.add('mutated-after-teardown');
      // Flush the MutationObserver microtask checkpoint.
      await Promise.resolve();
      await Promise.resolve();

      expect(readSpy).not.toHaveBeenCalled();
      expect(uncaughtErrors).toEqual([]);
    } finally {
      window.removeEventListener('error', onWindowError);
    }
  });
});
