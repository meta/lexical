/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {vi} from 'vitest';

// `warnOnlyOnce` is auto-mocked so each test observes the warning
// independently — the real implementation dedupes via a module-level
// closure that would otherwise leak state across tests. `invariant` and
// `devInvariant` are NOT mocked: their real implementations interpolate
// `%s` and throw without the build-time transform, so tests exercise the
// shipped behavior directly.
vi.mock('@lexical/internal/warnOnlyOnce');

// jsdom workarounds for the unit-test environment. Real browsers (and the
// playwright e2e suite) do not need any of these patches, so we gate on the
// jsdom-specific user-agent string and only patch when running there.
//
// Each patch is applied per realm (see patchRealm): jsdom gives every iframe
// its own realm with its own HTMLElement/Range/... constructors, so a patch
// installed on the top realm's prototypes does not reach nodes created inside
// an iframe document. The top realm is patched eagerly; iframe realms are
// patched lazily the first time their window/document is accessed.
//
// 1. jsdom >= 24.1.1 collapses an existing text-node DOM selection to the
//    start of the focused element when HTMLElement.focus() is called on a
//    contenteditable ancestor. Real browsers (and happy-dom) preserve the
//    selection. Restore the pre-focus selection when this happens.
// 2. jsdom does not implement Range.prototype.getBoundingClientRect, so
//    Lexical's scroll-into-view path throws when reading it. Stub it.
const isJsdom =
  typeof navigator !== 'undefined' && /\bjsdom\//.test(navigator.userAgent);
if (isJsdom) {
  type RealmGlobal = Window & typeof globalThis;

  // Name a stub so the cross-realm "same constructor" checks that compare by
  // function name (e.g. objectKlassEquals) keep working.
  const named =
    <Name extends string>(name: Name) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    <T extends Function>(o: T): T =>
      Object.defineProperty(o, 'name', {value: name});

  // Value globals jsdom does not implement. Defined once and shared across
  // every realm that lacks them — the constructor identity is unimportant for
  // these field-carrying stubs, and sharing keeps them in sync.
  const stubGlobals: {readonly [k: string]: unknown} = {
    ClipboardEvent: named('ClipboardEvent')(
      class ClipboardEventMock extends Event implements ClipboardEvent {
        clipboardData: null | DataTransfer;
        constructor(type: string, options?: ClipboardEventInit) {
          super(type, options);
          this.clipboardData = (options && options.clipboardData) || null;
        }
      },
    ),
    DataTransfer: named('DataTransfer')(
      class DataTransferMock implements DataTransfer {
        _data: Map<string, string> = new Map();
        #normalizeType(key: string): string {
          const lowercase = key.toLowerCase();
          return lowercase === 'text'
            ? 'text/plain'
            : lowercase === 'url'
              ? 'text/uri-list'
              : lowercase;
        }
        get dropEffect(): DataTransfer['dropEffect'] {
          throw new Error('Getter not implemented.');
        }
        get effectAllowed(): DataTransfer['effectAllowed'] {
          throw new Error('Getter not implemented.');
        }
        get files(): FileList {
          const files: File[] = [];
          return {
            item: (index: number) => files[index] || null,
            get length() {
              return files.length;
            },
            get [Symbol.iterator]() {
              return files[Symbol.iterator];
            },
          };
        }
        get items(): DataTransferItemList {
          throw new Error('Getter not implemented.');
        }
        get types(): readonly string[] {
          return [...this._data.keys()];
        }
        clearData(dataType?: string): void {
          if (dataType) {
            this._data.delete(this.#normalizeType(dataType));
          } else {
            this._data.clear();
          }
        }
        getData(dataType: string): string {
          const normalized = this.#normalizeType(dataType);
          const data = this._data.get(normalized) || '';
          return dataType === 'url'
            ? data.split(/\r?\n/).find(line => /^[^#]/.test(line)) || ''
            : data;
        }
        setData(dataType: string, data: string): void {
          this._data.set(this.#normalizeType(dataType), data);
        }
        setDragImage(image: Element, x: number, y: number): void {
          // ignored
        }
      },
    ),
    DragEvent: named('DragEvent')(
      class DragEventMock extends MouseEvent implements DragEvent {
        dataTransfer: DataTransfer | null = null;
        constructor(type: string, options?: DragEventInit) {
          super(type, options);
          this.dataTransfer = (options && options.dataTransfer) || null;
        }
      },
    ),
    PointerEvent: named('PointerEvent')(
      class PointerEventMock extends MouseEvent {
        pointerType: string;
        pointerId: number;
        constructor(type: string, options?: PointerEventInit) {
          super(type, options);
          this.pointerType = (options && options.pointerType) || 'mouse';
          this.pointerId = (options && options.pointerId) || 0;
        }
      },
    ),
    execCommand: named('execCommand')(function execCommandMock(
      commandId: string,
      showUI?: boolean,
      value?: string,
    ): boolean {
      return true;
    }),
  };

  // Apply every jsdom stub to one realm. Idempotent, so it is safe to call on
  // each access of an iframe's contentWindow/contentDocument.
  const patchedRealms = new WeakSet<object>();
  const patchRealm = (win: RealmGlobal): void => {
    if (patchedRealms.has(win)) {
      return;
    }
    patchedRealms.add(win);

    const g = win as unknown as Record<string, unknown>;
    for (const k in stubGlobals) {
      if (typeof g[k] !== 'function') {
        g[k] = stubGlobals[k];
      }
    }

    const originalFocus = win.HTMLElement.prototype.focus;
    win.HTMLElement.prototype.focus = function focusPreservingSelection(
      this: HTMLElement,
      options?: FocusOptions,
    ): void {
      const sel = this.ownerDocument.getSelection();
      const snapshot =
        sel && sel.rangeCount > 0
          ? {
              anchorNode: sel.anchorNode,
              anchorOffset: sel.anchorOffset,
              focusNode: sel.focusNode,
              focusOffset: sel.focusOffset,
            }
          : null;
      originalFocus.call(this, options);
      if (
        snapshot !== null &&
        snapshot.anchorNode !== null &&
        snapshot.focusNode !== null &&
        this.contains(snapshot.anchorNode) &&
        this.contains(snapshot.focusNode) &&
        sel !== null &&
        (sel.anchorNode !== snapshot.anchorNode ||
          sel.anchorOffset !== snapshot.anchorOffset ||
          sel.focusNode !== snapshot.focusNode ||
          sel.focusOffset !== snapshot.focusOffset)
      ) {
        try {
          sel.setBaseAndExtent(
            snapshot.anchorNode,
            snapshot.anchorOffset,
            snapshot.focusNode,
            snapshot.focusOffset,
          );
        } catch {
          // Ignore restoration failures; tests that depend on selection will
          // surface them downstream.
        }
      }
    };

    // jsdom's HTMLElement.contentEditable is a plain property that doesn't
    // synchronize with the 'contenteditable' DOM attribute. Real browsers
    // (and the spec) require them to stay in sync, so override the
    // property to delegate to getAttribute/setAttribute.
    const ceDescriptor = Object.getOwnPropertyDescriptor(
      win.HTMLElement.prototype,
      'contentEditable',
    );
    if (!ceDescriptor || ceDescriptor.configurable !== false) {
      Object.defineProperty(win.HTMLElement.prototype, 'contentEditable', {
        configurable: true,
        get(this: HTMLElement) {
          const attr = this.getAttribute('contenteditable');
          if (attr === 'true' || attr === '') {
            return 'true';
          }
          if (attr === 'false') {
            return 'false';
          }
          return 'inherit';
        },
        set(this: HTMLElement, value: string) {
          if (value === 'inherit') {
            this.removeAttribute('contenteditable');
          } else {
            this.setAttribute('contenteditable', value);
          }
        },
      });
    }

    if (typeof win.Range.prototype.getBoundingClientRect !== 'function') {
      // jsdom does not implement layout, so a zero-rect stub is sufficient
      // for code paths that only need a DOMRect-shaped value (like
      // Lexical's scroll-into-view computation).
      win.Range.prototype.getBoundingClientRect = function (): DOMRect {
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          toJSON() {
            return this;
          },
          top: 0,
          width: 0,
          x: 0,
          y: 0,
        } as DOMRect;
      };
    }

    // Patch any iframe realm the first time its window or document is read,
    // so editors mounted inside an iframe see the same stubs. Wrapping the
    // accessors on this realm's HTMLIFrameElement also covers nested iframes,
    // since the child realm is itself patched (and re-wrapped) here.
    for (const prop of ['contentWindow', 'contentDocument'] as const) {
      const proto = win.HTMLIFrameElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.get !== 'function' || !desc.configurable) {
        continue;
      }
      const originalGet = desc.get;
      Object.defineProperty(proto, prop, {
        ...desc,
        get(this: HTMLIFrameElement) {
          const node = originalGet.call(this) as Window | Document | null;
          const childWin =
            node === null
              ? null
              : prop === 'contentWindow'
                ? (node as Window)
                : (node as Document).defaultView;
          if (childWin) {
            try {
              patchRealm(childWin as RealmGlobal);
            } catch {
              // Cross-origin child realm — its globals are inaccessible and
              // the browser blocks the patch attempt. Same-origin iframes
              // (the only case the lexical browser tests use) are unaffected.
            }
          }
          return node;
        },
      });
    }
  };

  patchRealm(globalThis);
}
