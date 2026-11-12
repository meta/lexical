/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {FocusTrapExtension, type FocusTrapOptions} from '@lexical/a11y';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  getActiveElementDeep,
} from 'lexical';
import {afterEach, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// The selector the trap cycles through can't see what the browser won't
// focus, so these run in a real browser: jsdom has no layout and focuses
// hidden elements.

const TAB = '{Tab}';
const SHIFT_TAB = '{Shift>}{Tab}{/Shift}';

type Hide = (button: HTMLButtonElement) => HTMLElement;

const HIDES: Record<string, Hide> = {
  'a disabled <fieldset>': button => {
    const fieldset = document.createElement('fieldset');
    fieldset.disabled = true;
    fieldset.append(button);
    return fieldset;
  },
  'display: none': button => {
    button.style.display = 'none';
    return button;
  },
  hidden: button => {
    button.hidden = true;
    return button;
  },
  inert: button => {
    button.inert = true;
    return button;
  },
  'visibility: hidden': button => {
    button.style.visibility = 'hidden';
    return button;
  },
};

function createButton(id: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = id;
  button.textContent = id;
  return button;
}

function createContainer(...children: HTMLElement[]): HTMLDivElement {
  const container = document.createElement('div');
  container.tabIndex = -1;
  container.append(...children);
  document.body.append(
    createButton('before'),
    container,
    createButton('after'),
  );
  return container;
}

function trap(container: HTMLElement, options?: FocusTrapOptions) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [FocusTrapExtension, RichTextExtension, LinkExtension],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  onTestFinished(
    getExtensionDependencyFromEditor(
      editor,
      FocusTrapExtension,
    ).output.register(container, options),
  );
  return editor;
}

function activeId(): string {
  const active = getActiveElementDeep(document);
  return active === null ? 'null' : active.id || active.tagName;
}

async function press(keys: string[]): Promise<string[]> {
  const ids = [];
  for (const key of keys) {
    await userEvent.keyboard(key);
    ids.push(activeId());
  }
  return ids;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('FocusTrap passes over candidates that do not take focus', () => {
  for (const [name, hide] of Object.entries(HIDES)) {
    for (const hidden of ['a', 'b', 'd']) {
      test(`${name} on ${hidden}`, async () => {
        const ids = ['a', 'b', 'c', 'd'];
        const container = createContainer(
          ...ids.map(id =>
            id === hidden ? hide(createButton(id)) : createButton(id),
          ),
        );
        document.getElementById('before')!.focus();
        trap(container);
        const [first, second, third] = ids.filter(id => id !== hidden);
        expect(activeId()).toBe(first);
        expect(await press([TAB, TAB, TAB])).toEqual([second, third, first]);
        expect(await press([SHIFT_TAB, SHIFT_TAB])).toEqual([third, second]);
        // Focus that escapes the container is pulled back to the first
        // candidate that takes it.
        document.getElementById('after')!.focus();
        expect(activeId()).toBe(first);
      });
    }
  }

  for (const [name, key, expected] of [
    ['Tab', TAB, 'b'],
    ['Shift+Tab', SHIFT_TAB, 'c'],
  ]) {
    test(`initialFocus: 'container', then ${name} with the end candidates hidden`, async () => {
      const a = createButton('a');
      a.hidden = true;
      const d = createButton('d');
      d.hidden = true;
      const container = createContainer(
        a,
        createButton('b'),
        createButton('c'),
        d,
      );
      container.id = 'container';
      trap(container, {initialFocus: 'container'});
      expect(activeId()).toBe('container');
      expect(await press([key])).toEqual([expected]);
    });
  }

  test('no candidate takes focus: the container takes it', () => {
    const hiddenButton = createButton('a');
    hiddenButton.hidden = true;
    const container = createContainer(hiddenButton);
    container.id = 'container';
    trap(container);
    expect(activeId()).toBe('container');
    document.getElementById('after')!.focus();
    expect(activeId()).toBe('container');
  });

  test('Shift+Tab from a button inside a visibility: hidden candidate', async () => {
    const hiddenParent = document.createElement('div');
    hiddenParent.tabIndex = 0;
    hiddenParent.style.visibility = 'hidden';
    const child = createButton('child');
    child.style.visibility = 'visible';
    hiddenParent.append(child);
    const container = createContainer(
      createButton('a'),
      hiddenParent,
      createButton('c'),
    );
    trap(container);
    child.focus();
    expect(await press([SHIFT_TAB, SHIFT_TAB])).toEqual(['a', 'c']);
  });

  test('a link inside an editor in the container', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    root.contentEditable = 'true';
    const container = createContainer(
      createButton('a'),
      root,
      createButton('c'),
    );
    const editor = trap(container);
    editor.setRootElement(root);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createLinkNode('https://lexical.dev').append(
                $createTextNode('link'),
              ),
            ),
          );
      },
      {discrete: true},
    );
    expect(container.querySelector('a[href]')).not.toBe(null);
    expect(activeId()).toBe('a');
    // The link matches the selector, but the browser doesn't focus a link
    // inside a contentEditable.
    expect(await press([TAB, TAB, TAB])).toEqual(['root', 'c', 'a']);
    expect(await press([SHIFT_TAB, SHIFT_TAB])).toEqual(['c', 'root']);
  });
});

describe('FocusTrap keeps focus where a candidate hands it on', () => {
  test('a delegatesFocus shadow host', async () => {
    const host = document.createElement('div');
    host.id = 'host';
    host.tabIndex = 0;
    host
      .attachShadow({delegatesFocus: true, mode: 'open'})
      .append(createButton('inner'));
    const container = createContainer(
      createButton('a'),
      host,
      createButton('c'),
    );
    trap(container);
    expect(await press([TAB])).toEqual(['inner']);
  });

  test('focus already inside a delegatesFocus host that is the first candidate', () => {
    const host = document.createElement('div');
    host.tabIndex = 0;
    const inner = createButton('inner');
    host.attachShadow({delegatesFocus: true, mode: 'open'}).append(inner);
    const container = createContainer(host, createButton('b'));
    inner.focus();
    trap(container);
    expect(activeId()).toBe('inner');
  });

  test('Tab leaves a delegatesFocus host that is the first candidate', async () => {
    const host = document.createElement('div');
    host.tabIndex = 0;
    host
      .attachShadow({delegatesFocus: true, mode: 'open'})
      .append(createButton('inner'));
    const container = createContainer(
      host,
      createButton('b'),
      createButton('c'),
    );
    trap(container);
    expect(activeId()).toBe('inner');
    expect(await press([TAB, TAB])).toEqual(['b', 'c']);
  });

  test('a focus handler that moves focus to a descendant', async () => {
    const inner = document.createElement('span');
    inner.id = 'inner';
    inner.tabIndex = -1;
    const b = createButton('b');
    b.addEventListener('focus', () => inner.focus());
    const container = createContainer(
      createButton('a'),
      b,
      inner,
      createButton('c'),
    );
    trap(container);
    expect(await press([TAB])).toEqual(['inner']);
  });

  test('a focus handler that moves focus to an allowOutside popup', async () => {
    const popup = createButton('popup');
    const b = createButton('b');
    b.addEventListener('focus', () => popup.focus());
    const container = createContainer(createButton('a'), b, createButton('c'));
    document.body.append(popup);
    trap(container, {allowOutside: target => target === popup});
    expect(await press([TAB])).toEqual(['popup']);
  });

  test('a focus handler that sends focus back is passed over', async () => {
    const a = createButton('a');
    const b = createButton('b');
    b.addEventListener('focus', () => a.focus());
    const container = createContainer(a, b, createButton('c'));
    trap(container);
    expect(await press([TAB])).toEqual(['c']);
  });

  test('focus already on the first candidate when the trap activates', () => {
    const container = createContainer(
      createButton('a'),
      createButton('b'),
      createButton('c'),
    );
    document.getElementById('a')!.focus();
    trap(container);
    expect(activeId()).toBe('a');
  });
});
