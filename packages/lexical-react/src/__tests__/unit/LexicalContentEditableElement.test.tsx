/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ContentEditableElement} from '@lexical/react/LexicalContentEditable';
import {axe, toHaveNoViolations} from 'jest-axe';
import {createEditor, type LexicalEditor} from 'lexical';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('ContentEditableElement tests', () => {
  let container: HTMLDivElement | null = null;
  let reactRoot: Root;
  let editor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);

    editor = createEditor({
      namespace: 'ContentEditableElement',
      onError: error => {
        throw error;
      },
    });
  });

  afterEach(async () => {
    if (container) {
      await act(async () => {
        reactRoot.unmount();
      });
      document.body.removeChild(container);
    }
    editor.setRootElement(null); //editor cleanup
  });

  it('renders the correct ARIA attributes when editable', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          ariaLabelledBy="test-label"
          role="textbox"
        />,
      );
    });

    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('aria-labelledby')).toBe('test-label');
    expect(element.getAttribute('contenteditable')).toBe('true');
  });

  it('renders aria-labelledby attribute correctly', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          aria-labelledby="TEST" // original  issue
          className="ContentEditable__root"
        />,
      );
    });

    const element = container!.querySelector('.ContentEditable__root')!;
    expect(element.getAttribute('aria-labelledby')).toBe('TEST');
  });

  it('renders the correct ARIA attributes for different roles', async () => {
    const roles = ['textbox', 'combobox', 'listbox', 'spinbutton'];

    for (const role of roles) {
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} role={role} />,
        );
      });

      const element = container!.querySelector(`[role="${role}"]`)!;
      expect(element.getAttribute('role')).toBe(role);
    }
  });
  it('renders optional ARIA attributes when provided', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          ariaDescribedBy="test-description"
          role="textbox"
        />,
      );
    });

    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('aria-describedby')).toBe('test-description'); // Check aria-describedby
  });

  it('renders aria-expanded correctly for role combobox', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          role="combobox"
          ariaExpanded={true} // Provide ariaExpanded
        />,
      );
    });

    const element = container!.querySelector('[role="combobox"]')!;

    expect(element.getAttribute('aria-expanded')).toBe('true'); // Verify that aria-expanded is correctly set.
  });

  it('renders aria-invalid and aria-required correctly', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          ariaInvalid="true" // Mark as invalid
          ariaRequired={true} // Mark as required
          role="textbox"
        />,
      );
    });

    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('aria-invalid')).toBe('true'); // Verify aria-invalid
    expect(element.getAttribute('aria-required')).toBe('true'); // Verify aria-required
  });

  it('applies custom attributes and styles correctly', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          role="textbox"
          data-testid="test-element"
          style={{color: 'red', fontSize: '16px'}}
        />,
      );
    });

    const element = container!.querySelector('[role="textbox"]') as HTMLElement;
    expect(element.getAttribute('data-testid')).toBe('test-element'); // Verify custom data attribute
    expect(element.style.color).toBe('red'); // Verify inline styles
    expect(element.style.fontSize).toBe('16px'); // Verify inline styles
  });

  it('renders aria-invalid and aria-required correctly when set to false', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          ariaInvalid="false" // Not invalid
          ariaRequired={false} // Not required
          role="textbox"
        />,
      );
    });

    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('aria-invalid')).toBe('false'); // Verify aria-invalid
    expect(element.getAttribute('aria-required')).toBe('false'); // Verify aria-required
  });

  it('renders custom data attributes correctly', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          role="textbox"
          data-testid="test-element"
          data-custom-attribute="custom-value"
        />,
      );
    });

    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('data-testid')).toBe('test-element'); // Verify custom data attribute
    expect(element.getAttribute('data-custom-attribute')).toBe('custom-value'); // Verify custom data attribute
  });

  it('registers and cleans up root element properly', async () => {
    let rootElement: HTMLElement | null = null;
    editor.setRootElement = vi.fn(element => {
      rootElement = element;
    });

    await act(async () => {
      reactRoot.render(
        <ContentEditableElement editor={editor} role="textbox" />,
      );
    });

    const element = container!.querySelector('[role="textbox"]')!;
    expect(rootElement).toBe(element); // Verify registration.

    await act(async () => {
      reactRoot.unmount(); // Unmount the component.
    });

    expect(rootElement).toBeNull(); // Verify cleanup.
  });

  it('renders the correct spellCheck attribute for different values', async () => {
    const spellCheckValues = [true, false];

    for (const spellCheck of spellCheckValues) {
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            spellCheck={spellCheck}
            role="textbox"
          />,
        );
      });

      const element = container!.querySelector('[role="textbox"]')!;
      expect(element.getAttribute('spellcheck')).toBe(spellCheck.toString());
    }
  });

  it('should have no accessibility violations', async () => {
    expect.extend(toHaveNoViolations);

    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          role="textbox"
          ariaLabel="Text editor"
        />,
      );
    });

    const results = await axe(container!);
    expect(results).toHaveNoViolations();
  });

  it('renders tabindex="-1" when not editable', async () => {
    editor.setEditable(false);
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement editor={editor} role="textbox" />,
      );
    });
    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('tabindex')).toBe('-1');
    expect(element.getAttribute('contenteditable')).toBe('false');
  });

  it('does not render tabindex when editable', async () => {
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement editor={editor} role="textbox" />,
      );
    });
    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('tabindex')).toBeNull();
  });

  it('allows custom tabIndex to override default when not editable', async () => {
    editor.setEditable(false);
    await act(async () => {
      reactRoot.render(
        <ContentEditableElement editor={editor} role="textbox" tabIndex={0} />,
      );
    });
    const element = container!.querySelector('[role="textbox"]')!;
    expect(element.getAttribute('tabindex')).toBe('0');
  });

  it('should have no accessibility violations when not editable', async () => {
    expect.extend(toHaveNoViolations);
    editor.setEditable(false);

    await act(async () => {
      reactRoot.render(
        <ContentEditableElement
          editor={editor}
          role="textbox"
          ariaLabel="Text editor"
        />,
      );
    });

    const results = await axe(container!);
    expect(results).toHaveNoViolations();
  });

  describe('default role', () => {
    it('defaults to role="textbox" when editable', async () => {
      await act(async () => {
        reactRoot.render(<ContentEditableElement editor={editor} />);
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('role')).toBe('textbox');
      expect(element.getAttribute('aria-autocomplete')).toBe(null);
    });

    it('renders no role and no widget ARIA when not editable and unnamed', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(<ContentEditableElement editor={editor} />);
      });
      const element = container!.querySelector('div[contenteditable]')!;
      // Nothing can name it, so a widget role would be an
      // aria-input-field-name violation; the widget-only ARIA goes with it.
      expect(element.getAttribute('role')).toBe(null);
      expect(element.getAttribute('aria-autocomplete')).toBe(null);
      expect(element.getAttribute('aria-readonly')).toBe(null);
    });

    it('keeps the role and its widget ARIA when not editable but named', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} ariaLabel="Notes" />,
        );
      });
      const element = container!.querySelector('[role="textbox"]')!;
      // A named read-only editor is a read-only form field: it keeps exactly
      // the markup it had before this change. Dropping the role here would
      // leave aria-label on a roleless element (aria-prohibited-attr).
      expect(element.getAttribute('aria-label')).toBe('Notes');
      expect(element.getAttribute('aria-readonly')).toBe('true');
      expect(element.getAttribute('aria-autocomplete')).toBe('none');
    });

    it('keeps the role when named via aria-labelledby', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} ariaLabelledBy="label-id" />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('role')).toBe('textbox');
    });

    it('keeps the role when named via the hyphenated aria-label', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} aria-label="Notes" />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('role')).toBe('textbox');
      expect(element.getAttribute('aria-label')).toBe('Notes');
    });

    it('keeps the widget ARIA when a role is passed explicitly', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            role="textbox"
            ariaLabel="Notes"
          />,
        );
      });
      const element = container!.querySelector('[role="textbox"]')!;
      expect(element.getAttribute('aria-readonly')).toBe('true');
      expect(element.getAttribute('aria-autocomplete')).toBe('none');
    });

    it('drops consumer widget-only ARIA when it resolves to no role', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            ariaMultiline={true}
            ariaRequired="true"
          />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('role')).toBe(null);
      expect(element.getAttribute('aria-multiline')).toBe(null);
      expect(element.getAttribute('aria-required')).toBe(null);
    });

    it('drops hyphenated widget-only ARIA too, not just the camelCase aliases', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            aria-activedescendant="choice"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-multiline={true}
            aria-required={true}
            aria-placeholder="Type here"
            aria-readonly={true}
          />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      // These reach the element through the prop spread, which runs last, so
      // gating only the camelCase aliases would let every one of them past.
      expect(element.getAttribute('role')).toBe(null);
      expect(element.getAttribute('aria-activedescendant')).toBe(null);
      expect(element.getAttribute('aria-autocomplete')).toBe(null);
      expect(element.getAttribute('aria-expanded')).toBe(null);
      expect(element.getAttribute('aria-multiline')).toBe(null);
      expect(element.getAttribute('aria-required')).toBe(null);
      expect(element.getAttribute('aria-placeholder')).toBe(null);
      expect(element.getAttribute('aria-readonly')).toBe(null);
    });

    it('keeps aria-placeholder when a role is resolved', async () => {
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            aria-label="Notes"
            aria-placeholder="Type here"
          />,
        );
      });
      const element = container!.querySelector('[role="textbox"]')!;
      expect(element.getAttribute('aria-placeholder')).toBe('Type here');
    });

    it('prefers the hyphenated spelling over the camelCase alias', async () => {
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            ariaLabel="camel"
            aria-label="hyphenated"
          />,
        );
      });
      const element = container!.querySelector('[role="textbox"]')!;
      expect(element.getAttribute('aria-label')).toBe('hyphenated');
    });

    it('follows the editor when editability changes', async () => {
      await act(async () => {
        reactRoot.render(<ContentEditableElement editor={editor} />);
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('role')).toBe('textbox');

      await act(async () => {
        editor.setEditable(false);
      });
      expect(element.getAttribute('role')).toBe(null);

      await act(async () => {
        editor.setEditable(true);
      });
      expect(element.getAttribute('role')).toBe('textbox');
    });

    it('keeps a named editor stable across editability changes', async () => {
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} ariaLabel="Notes" />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('role')).toBe('textbox');

      await act(async () => {
        editor.setEditable(false);
      });
      expect(element.getAttribute('role')).toBe('textbox');
      expect(element.getAttribute('aria-readonly')).toBe('true');

      await act(async () => {
        editor.setEditable(true);
      });
      expect(element.getAttribute('role')).toBe('textbox');
      expect(element.getAttribute('aria-readonly')).toBe(null);
    });

    it('has no accessibility violations when not editable and unnamed', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);

      await act(async () => {
        reactRoot.render(<ContentEditableElement editor={editor} />);
      });

      // Previously this rendered an unnamed role="textbox", which axe reports
      // as aria-input-field-name (serious).
      const results = await axe(container!);
      expect(results).toHaveNoViolations();
    });

    it('has no accessibility violations when not editable and named', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);

      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} ariaLabel="Notes" />,
        );
      });

      // The other half of the invariant: were the role dropped here, the name
      // would remain on a roleless element (aria-prohibited-attr).
      const results = await axe(container!);
      expect(results).toHaveNoViolations();
    });

    it('does not count an empty aria-label as a name', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} aria-label="" />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      // An empty label names nothing, so it cannot keep the widget role: the
      // element would be an unnamed textbox (aria-input-field-name).
      expect(element.getAttribute('role')).toBe(null);
      const results = await axe(container!);
      expect(results).toHaveNoViolations();
    });

    it('counts title as an accessible name', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement editor={editor} title="Notes" />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      // `title` supplies the accessible name when no ARIA label does, so this
      // is a named read-only field and keeps the role it had before.
      expect(element.getAttribute('role')).toBe('textbox');
      expect(element.getAttribute('title')).toBe('Notes');
      const results = await axe(container!);
      expect(results).toHaveNoViolations();
    });

    it('keeps aria-expanded on a read-only combobox', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <>
            <div id="listbox-id" role="listbox" />
            <ContentEditableElement
              editor={editor}
              role="combobox"
              aria-label="Notes"
              aria-expanded={false}
              aria-controls="listbox-id"
            />
          </>,
        );
      });
      const element = container!.querySelector('[role="combobox"]')!;
      // A combobox requires aria-expanded whether or not it is editable;
      // without it axe reports aria-required-attr.
      expect(element.getAttribute('aria-expanded')).toBe('false');
      const results = await axe(container!);
      expect(results).toHaveNoViolations();
    });

    it('reads the string "false" on aria-expanded as false', async () => {
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            role="combobox"
            aria-label="Notes"
            aria-expanded="false"
          />,
        );
      });
      const element = container!.querySelector('[role="combobox"]')!;
      // React's own type for this attribute allows the string, and ARIA reads
      // it as false; `!!` would render it as "true".
      expect(element.getAttribute('aria-expanded')).toBe('false');
    });

    it('reads the string "true" on aria-expanded as true', async () => {
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            role="combobox"
            aria-label="Notes"
            aria-expanded="true"
          />,
        );
      });
      const element = container!.querySelector('[role="combobox"]')!;
      expect(element.getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('standard ARIA overrides', () => {
    it('keeps aria-expanded on a tree item', async () => {
      expect.extend(toHaveNoViolations);
      await act(async () => {
        reactRoot.render(
          <div role="tree" aria-label="Outline">
            <ContentEditableElement
              editor={editor}
              role="treeitem"
              aria-label="Section"
              aria-expanded={false}
            />
          </div>,
        );
      });
      const element = container!.querySelector('[role="treeitem"]')!;
      expect(element.getAttribute('aria-expanded')).toBe('false');
      expect(await axe(container!)).toHaveNoViolations();
    });

    it('keeps combobox attributes across editability changes', async () => {
      expect.extend(toHaveNoViolations);
      await act(async () => {
        reactRoot.render(
          <>
            <ContentEditableElement
              editor={editor}
              role="combobox"
              aria-label="Choices"
              aria-expanded={true}
              aria-controls="choices"
              aria-activedescendant="choice"
              aria-autocomplete="list"
            />
            <div role="listbox" id="choices" aria-label="Options">
              <div role="option" id="choice" aria-selected={true}>
                One
              </div>
            </div>
          </>,
        );
      });
      const element = container!.querySelector('[role="combobox"]')!;
      for (const editable of [false, true]) {
        await act(async () => {
          editor.setEditable(editable);
        });
        expect(element.getAttribute('aria-expanded')).toBe('true');
        expect(element.getAttribute('aria-activedescendant')).toBe('choice');
        expect(element.getAttribute('aria-autocomplete')).toBe('list');
        expect(await axe(container!)).toHaveNoViolations();
      }
    });

    it('lets an undefined standard label clear a legacy label', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            ariaLabel="Old label"
            aria-label={undefined}
            title="Current label"
          />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('aria-label')).toBe(null);
      expect(element.getAttribute('title')).toBe('Current label');
      expect(element.getAttribute('role')).toBe('textbox');
      expect(await axe(container!)).toHaveNoViolations();
    });

    it('uses the overridden name when resolving the default role', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            ariaLabel="Old label"
            aria-label={undefined}
          />,
        );
      });
      const element = container!.querySelector('div[contenteditable]')!;
      expect(element.getAttribute('aria-label')).toBe(null);
      expect(element.getAttribute('role')).toBe(null);
      expect(await axe(container!)).toHaveNoViolations();
    });

    it('lets undefined standard props clear defaults and aliases', async () => {
      expect.extend(toHaveNoViolations);
      editor.setEditable(false);
      await act(async () => {
        reactRoot.render(
          <ContentEditableElement
            editor={editor}
            aria-label="Notes"
            ariaMultiline={true}
            ariaRequired={true}
            aria-autocomplete={undefined}
            aria-multiline={undefined}
            aria-readonly={undefined}
            aria-required={undefined}
          />,
        );
      });
      const element = container!.querySelector('[role="textbox"]')!;
      expect(element.getAttribute('aria-autocomplete')).toBe(null);
      expect(element.getAttribute('aria-multiline')).toBe(null);
      expect(element.getAttribute('aria-readonly')).toBe(null);
      expect(element.getAttribute('aria-required')).toBe(null);
      expect(await axe(container!)).toHaveNoViolations();
    });
  });
});
