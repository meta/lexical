/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import * as ComposerContext from '@lexical/react/LexicalComposerContext';
import {type LexicalComposerContextWithEditor} from '@lexical/react/LexicalComposerContext';
import {
  KEY_ARROW_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {createTestEditor} from 'lexical/src/__tests__/utils';
import * as React from 'react';
import {act} from 'react';
import ReactDOM from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import {
  LexicalMenu,
  MenuOption,
  type MenuRenderFn,
  type MenuResolution,
  useDynamicPositioning,
} from '../../shared/LexicalMenu';

// Mock the composer context to provide a test editor
vi.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [createTestEditor()],
}));

// The real hook reads AriaLiveRegionExtension off the editor, which a bare
// test editor does not have. Standing in for it makes announcements
// observable, including the ones that must not happen.
const {announce} = vi.hoisted(() => ({announce: vi.fn()}));
vi.mock('@lexical/react/useLexicalAriaLiveRegion', () => ({
  useLexicalAriaLiveRegion: () => announce,
}));

class TestOption extends MenuOption {
  title: string;
  constructor(title: string) {
    super(title);
    this.title = title;
  }
}

function createTestResolution(matchingString?: string): MenuResolution {
  return {
    getRect: () =>
      ({
        bottom: 100,
        height: 20,
        left: 10,
        right: 110,
        top: 80,
        width: 100,
        x: 10,
        y: 80,
      }) as DOMRect,
    match: matchingString
      ? {
          leadOffset: 0,
          matchingString,
          replaceableString: matchingString,
        }
      : undefined,
  };
}

describe('MenuOption', () => {
  it('should set key from constructor', () => {
    const option = new MenuOption('test-key');
    expect(option.key).toBe('test-key');
  });

  it('should initialize ref with null current', () => {
    const option = new MenuOption('test-key');
    expect(option.ref).toBeDefined();
    expect(option.ref!.current).toBeNull();
  });

  it('should update ref via setRefElement', () => {
    const option = new MenuOption('test-key');
    const el = document.createElement('div');
    option.setRefElement(el);
    expect(option.ref!.current).toBe(el);
  });

  it('should support optional icon property', () => {
    const option = new MenuOption('test-key');
    expect(option.icon).toBeUndefined();
    option.icon = <i className="test-icon" />;
    expect(option.icon).toBeDefined();
  });

  it('should support optional title property', () => {
    const option = new MenuOption('test-key');
    expect(option.title).toBeUndefined();
    option.title = 'Test Title';
    expect(option.title).toBe('Test Title');
  });

  it('should support JSX Element as title', () => {
    const option = new MenuOption('test-key');
    option.title = <span>Rich Title</span>;
    expect(option.title).toBeDefined();
  });
});

describe('MenuRenderFn type export', () => {
  it('MenuRenderFn should be importable and usable as a type', () => {
    // This test validates that MenuRenderFn is properly exported and has the
    // correct shape. If the type were removed or broken, this file would fail
    // to compile.
    const fn: MenuRenderFn<TestOption> = (
      anchorElementRef,
      itemProps,
      matchingString,
    ) => {
      // Verify the shape of itemProps at runtime
      expect(typeof itemProps.selectOptionAndCleanUp).toBe('function');
      expect(typeof itemProps.setHighlightedIndex).toBe('function');
      expect(Array.isArray(itemProps.options)).toBe(true);
      return null;
    };
    expect(fn).toBeDefined();
  });
});

describe('LexicalMenu', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;
  let anchorElement: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);

    // Create anchor element that portals render into
    anchorElement = document.createElement('div');
    anchorElement.id = 'typeahead-menu';
    document.body.appendChild(anchorElement);

    editor = createTestEditor();
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);
    editor.setRootElement(rootElement);
  });

  afterEach(() => {
    document.body.removeChild(container);
    if (anchorElement.parentNode) {
      document.body.removeChild(anchorElement);
    }
    const rootEl = editor.getRootElement();
    if (rootEl && rootEl.parentNode) {
      document.body.removeChild(rootEl);
    }
    vi.restoreAllMocks();
  });

  describe('default rendering (without menuRenderFn)', () => {
    it('should render menu items using default MenuItem component', async () => {
      const options = [
        new TestOption('Option A'),
        new TestOption('Option B'),
        new TestOption('Option C'),
      ];

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={options}
            onSelectOption={vi.fn()}
          />,
        );
      });

      // Default rendering creates a portal into the anchor element
      const portal = anchorElement.querySelector('.typeahead-popover');
      expect(portal).not.toBeNull();

      const items = anchorElement.querySelectorAll('li[role="option"]');
      expect(items.length).toBe(3);

      // Verify text content
      const texts = Array.from(items).map(
        item => item.querySelector('.text')?.textContent,
      );
      expect(texts).toEqual(['Option A', 'Option B', 'Option C']);
    });

    it('should apply selected class to preselected first item', async () => {
      const options = [new TestOption('First'), new TestOption('Second')];

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={options}
            onSelectOption={vi.fn()}
            preselectFirstItem={true}
          />,
        );
      });

      const items = anchorElement.querySelectorAll('li[role="option"]');
      expect(items[0].className).toContain('selected');
      expect(items[1].className).not.toContain('selected');
    });

    it('should render nothing when options array is empty', async () => {
      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={[]}
            onSelectOption={vi.fn()}
          />,
        );
      });

      const portal = anchorElement.querySelector('.typeahead-popover');
      expect(portal).toBeNull();
    });

    it('should not select an option when Enter is pressed with Shift (line break / fall-through)', async () => {
      const onSelectOption = vi.fn();
      const options = [new TestOption('Option A'), new TestOption('Option B')];

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={options}
            onSelectOption={onSelectOption}
            preselectFirstItem={true}
          />,
        );
      });

      const shiftEnter = {
        preventDefault: vi.fn(),
        shiftKey: true,
        stopImmediatePropagation: vi.fn(),
      } as unknown as KeyboardEvent;

      await act(async () => {
        editor.dispatchCommand(KEY_ENTER_COMMAND, shiftEnter);
      });

      expect(onSelectOption).not.toHaveBeenCalled();
    });

    it('should select an option when Enter is pressed without Shift', async () => {
      const onSelectOption = vi.fn();
      const options = [new TestOption('Option A'), new TestOption('Option B')];

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={options}
            onSelectOption={onSelectOption}
            preselectFirstItem={true}
          />,
        );
      });

      const enter = {
        preventDefault: vi.fn(),
        shiftKey: false,
        stopImmediatePropagation: vi.fn(),
      } as unknown as KeyboardEvent;

      await act(async () => {
        editor.dispatchCommand(KEY_ENTER_COMMAND, enter);
      });

      expect(onSelectOption).toHaveBeenCalledTimes(1);
      expect(onSelectOption.mock.calls[0][0]).toBe(options[0]);
    });

    it('should render icon and title in default MenuItem', async () => {
      const option = new TestOption('With Icon');
      option.icon = <i className="custom-icon" />;

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={[option]}
            onSelectOption={vi.fn()}
          />,
        );
      });

      const icon = anchorElement.querySelector('.custom-icon');
      expect(icon).not.toBeNull();

      const text = anchorElement.querySelector('.text');
      expect(text?.textContent).toBe('With Icon');
    });
  });

  describe('custom rendering (with menuRenderFn)', () => {
    it('should use menuRenderFn when provided', async () => {
      const options = [new TestOption('Custom A'), new TestOption('Custom B')];

      const customRenderFn: MenuRenderFn<TestOption> = (
        anchorElementRef,
        itemProps,
        matchingString,
      ) => {
        return anchorElementRef.current
          ? ReactDOM.createPortal(
              <div className="custom-menu" data-testid="custom-menu">
                {itemProps.options.map((option, i) => (
                  <button
                    key={option.key}
                    className={
                      itemProps.selectedIndex === i ? 'active' : 'inactive'
                    }
                    onClick={() => itemProps.selectOptionAndCleanUp(option)}>
                    {option.title}
                  </button>
                ))}
                <span className="matching-string">{matchingString}</span>
              </div>,
              anchorElementRef.current,
            )
          : null;
      };

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('hello')}
            options={options}
            menuRenderFn={customRenderFn}
            onSelectOption={vi.fn()}
          />,
        );
      });

      // Custom rendering should be used, NOT the default
      const defaultMenu = anchorElement.querySelector('.typeahead-popover');
      expect(defaultMenu).toBeNull();

      const customMenu = anchorElement.querySelector('.custom-menu');
      expect(customMenu).not.toBeNull();

      const buttons = anchorElement.querySelectorAll('button');
      expect(buttons.length).toBe(2);
      expect(buttons[0].textContent).toBe('Custom A');
      expect(buttons[1].textContent).toBe('Custom B');

      // Verify matchingString is passed through
      const matchingStr = anchorElement.querySelector('.matching-string');
      expect(matchingStr?.textContent).toBe('hello');
    });

    it('should pass selectedIndex to menuRenderFn', async () => {
      const options = [new TestOption('A'), new TestOption('B')];
      let capturedSelectedIndex: number | null = null;

      const customRenderFn: MenuRenderFn<TestOption> = (
        _anchorRef,
        itemProps,
      ) => {
        capturedSelectedIndex = itemProps.selectedIndex;
        return null;
      };

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={options}
            menuRenderFn={customRenderFn}
            onSelectOption={vi.fn()}
            preselectFirstItem={true}
          />,
        );
      });

      // With preselectFirstItem=true, selectedIndex should be 0
      expect(capturedSelectedIndex).toBe(0);
    });

    it('should pass options array to menuRenderFn', async () => {
      const options = [
        new TestOption('X'),
        new TestOption('Y'),
        new TestOption('Z'),
      ];
      let capturedOptions: TestOption[] = [];

      const customRenderFn: MenuRenderFn<TestOption> = (
        _anchorRef,
        itemProps,
      ) => {
        capturedOptions = itemProps.options;
        return null;
      };

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution('test')}
            options={options}
            menuRenderFn={customRenderFn}
            onSelectOption={vi.fn()}
          />,
        );
      });

      expect(capturedOptions).toHaveLength(3);
      expect(capturedOptions.map(o => o.title)).toEqual(['X', 'Y', 'Z']);
    });

    it('should pass empty string as matchingString when no match', async () => {
      let capturedMatchingString: string | null = 'NOT_SET';

      const customRenderFn: MenuRenderFn<TestOption> = (
        _anchorRef,
        _itemProps,
        matchingString,
      ) => {
        capturedMatchingString = matchingString;
        return null;
      };

      await act(async () => {
        reactRoot.render(
          <LexicalMenu<TestOption>
            close={vi.fn()}
            editor={editor}
            anchorElementRef={{current: anchorElement}}
            resolution={createTestResolution()}
            options={[new TestOption('A')]}
            menuRenderFn={customRenderFn}
            onSelectOption={vi.fn()}
          />,
        );
      });

      // When resolution.match is undefined, matchingString should be ''
      expect(capturedMatchingString).toBe('');
    });
  });
});

describe('useDynamicPositioning Comment 8 regression', () => {
  it('registers a scroll listener on the editor root enclosing shadow root, not on the portaled target tree', async () => {
    if (typeof document === 'undefined') {
      // Node-only `bench` project has no DOM; this scenario is DOM-only.
      return;
    }
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // Editor + scroll container live in an open shadow root, while the
    // floating menu target is portaled into document.body. The pre-fix
    // code keyed getDOMShadowRoots off the target — which sits in the
    // light DOM — so the for-loop yielded zero shadow listeners. The fix
    // keys off the editor root, so shadow.addEventListener('scroll', …)
    // fires exactly once.
    const host = document.createElement('div');
    document.body.appendChild(host);
    onTestFinished(() => host.remove());
    const shadow = host.attachShadow({mode: 'open'});

    const editorScroller = document.createElement('div');
    editorScroller.style.height = '60px';
    editorScroller.style.overflow = 'auto';
    const editorRoot = document.createElement('div');
    editorRoot.style.height = '400px';
    editorRoot.contentEditable = 'true';
    editorScroller.appendChild(editorRoot);
    shadow.appendChild(editorScroller);

    const shadowEditor = createTestEditor();
    shadowEditor.setRootElement(editorRoot);

    const target = document.createElement('div');
    document.body.appendChild(target);
    onTestFinished(() => target.remove());

    vi.spyOn(ComposerContext, 'useLexicalComposerContext').mockReturnValue([
      shadowEditor,
      {},
    ] as LexicalComposerContextWithEditor);

    const shadowAddSpy = vi.spyOn(shadow, 'addEventListener');

    function Stub() {
      useDynamicPositioning(createTestResolution(), target, () => {});
      return null;
    }

    const stubContainer = document.createElement('div');
    document.body.appendChild(stubContainer);
    const stubRoot = createRoot(stubContainer);
    onTestFinished(async () => {
      await act(async () => {
        stubRoot.unmount();
      });
      stubContainer.remove();
    });
    await act(async () => {
      stubRoot.render(<Stub />);
    });

    const scrollListenerCalls = shadowAddSpy.mock.calls.filter(
      ([eventName]) => eventName === 'scroll',
    );
    expect(scrollListenerCalls.length).toBeGreaterThan(0);
  });
});

describe('LexicalMenu accessibility', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;
  let anchorElement: HTMLDivElement;
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

  function render(props: Record<string, unknown>) {
    return act(async () => {
      reactRoot.render(
        <LexicalMenu<TestOption>
          close={vi.fn()}
          editor={editor}
          anchorElementRef={{current: anchorElement}}
          resolution={createTestResolution('test')}
          onSelectOption={vi.fn()}
          options={[]}
          {...props}
        />,
      );
    });
  }

  const listbox = () => anchorElement.querySelector('[role="listbox"]');
  const items = () =>
    Array.from(anchorElement.querySelectorAll('[role="option"]'));
  const root = () => editor.getRootElement()!;

  beforeEach(() => {
    announce.mockClear();
    announce.mockImplementation(() => {});
    // jsdom has no layout, so it does not implement scrollIntoView. Arrowing
    // through the menu scrolls the highlighted option into view.
    originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
    anchorElement = document.createElement('div');
    anchorElement.id = 'typeahead-menu';
    document.body.appendChild(anchorElement);
    editor = createTestEditor();
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);
    editor.setRootElement(rootElement);
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    container.remove();
    anchorElement.remove();
    const rootEl = editor.getRootElement();
    if (rootEl) {
      rootEl.remove();
    }
  });

  describe('the listbox owns its options', () => {
    it('renders the options as direct children of the listbox', async () => {
      await render({options: [new TestOption('A'), new TestOption('B')]});

      // The whole bug: anything sitting between the listbox and its options
      // is announced as an extra list, and stops the position being worked
      // out at all.
      expect(listbox()).not.toBeNull();
      expect(items()).toHaveLength(2);
      for (const item of items()) {
        expect(item.parentElement).toBe(listbox());
      }
    });

    it('exposes exactly one list, not a list inside a list', async () => {
      await render({options: [new TestOption('A'), new TestOption('B')]});

      // Heard as "list, list": the container claimed to be a listbox and the
      // <ul> inside it was a second list nobody asked for. A <ul> carries a
      // list role whether or not one is set, so counting elements that expose
      // one is the check that matters.
      const lists = anchorElement.querySelectorAll(
        '[role="listbox"], [role="list"], ul:not([role]), ol:not([role])',
      );

      expect(lists).toHaveLength(1);
      expect(lists[0]).toBe(listbox());
    });

    it('names the listbox, and lets the caller override the name', async () => {
      await render({options: [new TestOption('A')]});
      expect(listbox()!.getAttribute('aria-label')).toBe('Typeahead menu');

      await render({ariaLabel: 'Emojis', options: [new TestOption('A')]});
      expect(listbox()!.getAttribute('aria-label')).toBe('Emojis');
    });
  });

  describe('what each option says about itself', () => {
    it('marks only the highlighted option as selected', async () => {
      await render({
        options: [
          new TestOption('A'),
          new TestOption('B'),
          new TestOption('C'),
        ],
      });

      // aria-selected="false" on the rest makes some screen readers say
      // "not selected" after every arrow press.
      expect(items().map(i => i.getAttribute('aria-selected'))).toEqual([
        'true',
        null,
        null,
      ]);
    });

    it('uses ariaLabel as the spoken name when the visible text differs', async () => {
      const option = new TestOption('grinning glyph');
      option.ariaLabel = 'grinning';
      await render({options: [option]});

      expect(items()[0].getAttribute('aria-label')).toBe('grinning');
    });

    it('leaves the name to the visible text when no ariaLabel is given', async () => {
      await render({options: [new TestOption('A')]});

      expect(items()[0].hasAttribute('aria-label')).toBe(false);
    });
  });

  describe('what the editor points at', () => {
    it('owns the listbox while there are options to point at', async () => {
      await render({options: [new TestOption('A')]});

      // The menu is rendered outside the editor, so the relationship has to
      // be declared or the reference does not resolve.
      expect(root().getAttribute('aria-owns')).toBe(listbox()!.id);
      const active = root().getAttribute('aria-activedescendant');
      expect(document.getElementById(active!)).not.toBeNull();
    });

    it('stops pointing when the options run out', async () => {
      await render({options: [new TestOption('A')]});
      await render({options: []});

      expect(root().getAttribute('aria-owns')).toBeNull();
      expect(root().getAttribute('aria-activedescendant')).toBeNull();
    });

    it('points at the highlighted option when options arrive late', async () => {
      // A menu backed by a network lookup opens with nothing. The highlight
      // is clamped while the list is empty and lands back on 0 when the
      // results arrive, so it never "changes" - and anything written only on
      // change is never written, leaving the editor pointing at nothing.
      await render({options: []});
      expect(root().getAttribute('aria-activedescendant')).toBeNull();

      await render({options: [new TestOption('A'), new TestOption('B')]});

      const active = root().getAttribute('aria-activedescendant');
      expect(active).toBe(items()[0].id);
      expect(document.getElementById(active!)).not.toBeNull();
    });

    it('never claims the editor is a combobox', async () => {
      await render({options: [new TestOption('A')]});

      // Changing the role of the focused element makes a screen reader
      // re-introduce it. The editor is a text field, not a combobox.
      expect(root().getAttribute('role')).not.toBe('combobox');
      expect(root().hasAttribute('aria-expanded')).toBe(false);
    });

    it('lets go of the editor when the menu closes', async () => {
      await render({options: [new TestOption('A')]});
      await act(async () => {
        reactRoot.unmount();
      });

      expect(root().getAttribute('aria-owns')).toBeNull();
      expect(root().getAttribute('aria-activedescendant')).toBeNull();
    });
  });

  describe('saying how many matches there are', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Async so React commits any pending effect before the clock moves.
    // Advancing synchronously races the commit: the timer is set after time
    // has already passed, so it survives to fire during a later step.
    async function settle() {
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
    }

    it('says how many, once typing has settled', async () => {
      await render({options: [new TestOption('A'), new TestOption('B')]});
      await settle();

      expect(announce).toHaveBeenCalledWith('2 suggestions available');
    });

    it('counts a single suggestion in the singular', async () => {
      await render({options: [new TestOption('A')]});
      await settle();

      expect(announce).toHaveBeenCalledWith('1 suggestion available');
    });

    it('says so when nothing matches', async () => {
      await render({options: []});
      await settle();

      // Nothing else can carry this: with no matches there is no list left
      // to describe, so correct markup is silence.
      expect(announce).toHaveBeenCalledWith('No results');
    });

    it('says nothing more while the highlight moves', async () => {
      await render({
        options: [
          new TestOption('A'),
          new TestOption('B'),
          new TestOption('C'),
        ],
      });
      // Drain everything already queued, so what follows can only be new.
      await act(async () => {
        vi.runAllTimers();
      });
      announce.mockClear();

      await act(async () => {
        editor.dispatchCommand(
          KEY_ARROW_DOWN_COMMAND,
          new KeyboardEvent('keydown', {key: 'ArrowDown'}),
        );
      });
      await settle();

      // Arrowing already announces the option itself. Repeating the count
      // over the top of it is noise.
      expect(announce).not.toHaveBeenCalled();
    });

    it('ends a burst of typing on the current count', async () => {
      await render({options: [new TestOption('A')]});
      await render({options: [new TestOption('A'), new TestOption('B')]});
      await render({
        options: [
          new TestOption('A'),
          new TestOption('B'),
          new TestOption('C'),
        ],
      });
      await settle();

      // What a user is left with has to describe the list as it stands. The
      // count is not asserted here: React's act() flushes the scheduler, and
      // with fake timers that can run a queued debounce during the next
      // render, before the effect cleanup cancels it - a property of the test
      // harness, not of the editor.
      const spoken = announce.mock.calls.map(([message]) => message);
      expect(spoken[spoken.length - 1]).toBe('3 suggestions available');
    });

    it('still shows the menu when the editor cannot speak', async () => {
      announce.mockImplementation(() => {
        throw new Error('no aria live region in this editor');
      });

      await render({options: [new TestOption('A'), new TestOption('B')]});
      await settle();

      expect(items()).toHaveLength(2);
      expect(listbox()).not.toBeNull();
    });
  });
});
