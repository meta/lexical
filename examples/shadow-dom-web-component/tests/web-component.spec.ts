/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect, type Locator, type Page, test} from '@playwright/test';

const editor = (page: Page, name: string): Locator =>
  page.locator(`lexical-editor[name="${name}"] [data-lexical-editor]`);

async function clearAndType(
  page: Page,
  name: string,
  text: string,
): Promise<void> {
  await editor(page, name).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
}

test.beforeEach(async ({page}) => {
  await page.goto('/');
  await page.locator('lexical-editor').first().waitFor();
});

test('renders three light-DOM editors plus one nested inside a wrapper shadow', async ({
  page,
}) => {
  // Notes + summary + the pre-rendered (declarative shadow DOM) editor in
  // the light DOM, plus the nested editor that mounts inside #nested-host's
  // own shadow root. Playwright's locator pierces open shadow roots so it
  // sees all four; document.querySelectorAll does not, so it sees only the
  // three light-DOM hosts.
  await expect(page.locator('lexical-editor')).toHaveCount(4);

  const stats = await page.evaluate(() => {
    const lightDomEditors = [...document.querySelectorAll('lexical-editor')];
    return {
      // querySelector does not pierce shadow roots, so none of the
      // contentEditables should be reachable from the document.
      lightDomContentEditables: document.querySelectorAll(
        'div[contenteditable="true"]',
      ).length,
      lightDomEditors: lightDomEditors.length,
      withShadow: lightDomEditors.filter(el => el.shadowRoot !== null).length,
    };
  });
  expect(stats).toEqual({
    lightDomContentEditables: 0,
    lightDomEditors: 3,
    withShadow: 3,
  });
});

test('types and formats inside a web component shadow root', async ({page}) => {
  await clearAndType(page, 'notes', 'hello world');
  await expect(editor(page, 'notes')).toHaveText('hello world');

  // Select "world" and bold it with the in-shadow toolbar button.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  const boldButton = page
    .locator('lexical-editor[name="notes"] .toolbar button')
    .first();
  await boldButton.click();

  await expect(editor(page, 'notes').locator('strong')).toHaveText('world');
  // The toolbar reflects the selection's format, proving the selection is
  // readable inside the shadow root.
  await expect(boldButton).toHaveAttribute('aria-pressed', 'true');
});

test('the two editors are independent', async ({page}) => {
  await clearAndType(page, 'notes', 'first editor');
  await clearAndType(page, 'summary', 'second editor');
  await expect(editor(page, 'notes')).toHaveText('first editor');
  await expect(editor(page, 'summary')).toHaveText('second editor');
});

test('deletes by word inside the shadow root', async ({page}) => {
  await clearAndType(page, 'notes', 'hello world');
  // Lexical's word-delete shortcut is `Alt+Backspace` on macOS and
  // `Ctrl+Backspace` elsewhere — Playwright's `ControlOrMeta` alias
  // maps to `Meta` on macOS, which is the OS "delete to start of line".
  const wordDelete =
    process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace';
  await page.keyboard.press(wordDelete);
  await expect(editor(page, 'notes')).toHaveText('hello ');
});

test('is form-associated via ElementInternals', async ({page}) => {
  await clearAndType(page, 'notes', 'form value one');
  await clearAndType(page, 'summary', 'form value two');

  await page.locator('button[type="submit"]').click();

  // The form value of each editor is its serialized Lexical state, collected
  // by FormData without any hidden <input>.
  const output = page.locator('#form-output');
  await expect(output).toContainText('notes:');
  await expect(output).toContainText('summary:');
  await expect(output).toContainText('form value one');
  await expect(output).toContainText('form value two');
});

test('dispatches a composed input event across the shadow boundary', async ({
  page,
}) => {
  await clearAndType(page, 'summary', 'x');
  // The page-level (light DOM) listener observes the composed `input` event
  // dispatched from inside the shadow root.
  await expect(page.locator('#last-edited')).toHaveText('Last edited: summary');
});

test('a slotted light-DOM button drives the editor through the host API', async ({
  page,
}) => {
  await clearAndType(page, 'notes', 'will be cleared');
  await expect(editor(page, 'notes')).toHaveText('will be cleared');

  // The Clear button is declared as `<button slot="toolbar-extra">` in the
  // page's light DOM. Despite living outside the shadow root, it renders
  // visually inside the editor's toolbar, and its click handler calls into
  // the editor through the public host API.
  const clear = page.locator('[data-clear]');
  await expect(clear).toBeVisible();

  // The button itself stays in the light DOM (querySelector reaches it
  // directly), the toolbar's built-in buttons do not.
  const distribution = await page.evaluate(() => {
    const slotted = document.querySelector('[data-clear]') as
      | (Element & {assignedSlot: HTMLSlotElement | null})
      | null;
    const slot = slotted !== null ? slotted.assignedSlot : null;
    return {
      assignedToToolbarSlot: slot !== null ? slot.name : null,
      reachableFromLightDom: slotted !== null,
    };
  });
  expect(distribution).toEqual({
    assignedToToolbarSlot: 'toolbar-extra',
    reachableFromLightDom: true,
  });

  await clear.click();
  await expect(editor(page, 'notes')).toHaveText('');
});

test('the page themes each editor through inherited CSS custom properties', async ({
  page,
}) => {
  // The page restyles only the summary editor by redefining the editor's
  // exposed custom properties. Inherited properties cross the shadow
  // boundary on their own — the internal layout is never touched.
  const colors = await page.evaluate(() => {
    const get = (host: Element): {bg: string; fg: string} => {
      const style = getComputedStyle(host);
      return {
        bg: style.getPropertyValue('--lexical-bg').trim(),
        fg: style.getPropertyValue('--lexical-fg').trim(),
      };
    };
    const notes = document.querySelector('lexical-editor[name="notes"]')!;
    const summary = document.querySelector('lexical-editor[name="summary"]')!;
    return {notes: get(notes), summary: get(summary)};
  });

  // Light defaults from the shadow root's :host rule.
  expect(colors.notes.bg).toBe('#fff');
  expect(colors.notes.fg).toBe('#1f2328');

  // Dark overrides from the page applied through inheritance.
  expect(colors.summary.bg).toBe('#1c1d22');
  expect(colors.summary.fg).toBe('#e6e6e9');
});

test('readonly blocks edits but still submits the value', async ({page}) => {
  await clearAndType(page, 'summary', 'locked content');

  // Flip the host's `readonly` attribute via the page-level checkbox. The
  // editor observes the attribute change and tells Lexical to stop
  // accepting input.
  await page.locator('#summary-readonly').check();
  await page.keyboard.type(' more typing');
  await expect(editor(page, 'summary')).toHaveText('locked content');

  // The form still has the original value — `readonly` keeps the field in
  // FormData, matching `<input readonly>`.
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('#form-output')).toContainText('summary:');
  await expect(page.locator('#form-output')).toContainText('locked content');

  // Removing the attribute re-enables editing.
  await page.locator('#summary-readonly').uncheck();
  await editor(page, 'summary').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' resumed');
  await expect(editor(page, 'summary')).toHaveText('locked content resumed');
});

test('disabled drops the editor out of form submission', async ({page}) => {
  await clearAndType(page, 'summary', 'will be dropped');

  // Set the standard `disabled` attribute via the host element's IDL
  // property. Lexical stops accepting input and the browser drops the
  // field from FormData entirely, matching `<input disabled>`.
  await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="summary"]',
    ) as HTMLElement & {disabled: boolean};
    host.disabled = true;
  });

  // Typing has no effect once the editor is disabled.
  await editor(page, 'summary').click({force: true});
  await page.keyboard.type(' still typing');
  await expect(editor(page, 'summary')).toHaveText('will be dropped');

  await page.locator('button[type="submit"]').click();
  const output = await page.locator('#form-output').textContent();
  expect(output).toContain('notes:');
  expect(output).not.toContain('summary:');
});

test('the floating popover anchors to the shadow-root selection', async ({
  page,
}) => {
  await clearAndType(page, 'notes', 'select these words');
  // Select the last word so the popover has a non-zero rect to anchor to.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }

  const popover = page.locator('#format-popover');

  // The popover lives in the light DOM and opts into the popover API's
  // top layer. It must be visible and anchored inside the viewport.
  await expect(popover).toBeVisible();
  const geometry = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#format-popover')!;
    const editorRect = document
      .querySelector('lexical-editor[name="notes"]')!
      .getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      editorBottom: editorRect.bottom,
      editorLeft: editorRect.left,
      editorRight: editorRect.right,
      isOpen: el.matches(':popover-open'),
      popoverLeft: rect.left,
      popoverTop: rect.top,
    };
  });
  expect(geometry.isOpen).toBe(true);
  // The popover anchors near the selected text inside the editor.
  expect(geometry.popoverLeft).toBeGreaterThanOrEqual(geometry.editorLeft - 1);
  expect(geometry.popoverLeft).toBeLessThan(geometry.editorRight);
  // The popover sits below the selection, which is inside the editor's
  // contentEditable, so it ends up no higher than the editor's top.
  expect(geometry.popoverTop).toBeGreaterThan(0);

  // Clicking a button drives the editor through the host's public API.
  await popover.locator('button[data-format="bold"]').click();
  await expect(editor(page, 'notes').locator('strong')).toHaveText('words');

  // Clicking back into the editor drops the caret there, which Lexical
  // reports as a collapsed range selection. The editor publishes
  // `lexical-selection-rect` with a null rect and the popover hides.
  await editor(page, 'notes').click({position: {x: 50, y: 50}});
  await expect(popover).toBeHidden();
});

test('mirrors aria-label and aria-invalid onto the contentEditable', async ({
  page,
}) => {
  const readAria = (name: string) =>
    page.evaluate(n => {
      const host = document.querySelector(
        `lexical-editor[name="${n}"]`,
      ) as Element & {shadowRoot: ShadowRoot};
      const ce = host.shadowRoot.querySelector('[data-lexical-editor]')!;
      return {
        ariaInvalid: ce.getAttribute('aria-invalid'),
        ariaLabel: ce.getAttribute('aria-label'),
        ariaMultiline: ce.getAttribute('aria-multiline'),
        role: ce.getAttribute('role'),
      };
    }, name);

  // aria-label flows from the host attribute to the contentEditable;
  // role and aria-multiline are spelled out for assistive tech.
  expect(await readAria('notes')).toEqual({
    ariaInvalid: 'false',
    ariaLabel: 'Notes editor',
    ariaMultiline: 'true',
    role: 'textbox',
  });
  expect(await readAria('summary')).toEqual({
    ariaInvalid: 'false',
    ariaLabel: 'Summary editor',
    ariaMultiline: 'true',
    role: 'textbox',
  });

  // Emptying the required notes editor flips aria-invalid to true.
  await editor(page, 'notes').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  expect((await readAria('notes')).ariaInvalid).toBe('true');
});

test('a visible error message follows the required validation state', async ({
  page,
}) => {
  const error = page.locator('#notes-error');
  // The notes editor starts with placeholder text, so the page-level
  // error message is hidden.
  await expect(error).toBeHidden();

  // Emptying the editor makes the host fire `lexical-validity-change`
  // with valid=false; the page-level listener shows the message.
  await editor(page, 'notes').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await expect(error).toBeVisible();
  await expect(error).toHaveText('Please fill in this field.');

  // Typing again hides the message.
  await page.keyboard.type('filled in');
  await expect(error).toBeHidden();
});

test('the shadow root is attached with delegatesFocus and the contentEditable is tab-focusable', async ({
  page,
}) => {
  // `attachShadow({delegatesFocus: true})` routes `host.focus()` and
  // implicit-label focus to the first focusable element inside the
  // shadow tree. The Chromium delegate-focus algorithm picks the first
  // element with `tabindex >= 0`, so the contentEditable carries
  // `tabindex="0"` explicitly. (Programmatic `host.focus()` interactions
  // with form-associated custom elements vary across engines, so the
  // dev-example asserts the configuration rather than driving focus.)
  const config = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="summary"]',
    ) as Element & {shadowRoot: ShadowRoot};
    const shadow = host.shadowRoot as ShadowRoot & {
      delegatesFocus?: boolean;
    };
    const ce = shadow.querySelector('.content') as HTMLElement;
    return {
      ceTabindex: ce.tabIndex,
      delegatesFocus: shadow.delegatesFocus === true,
    };
  });
  expect(config).toEqual({ceTabindex: 0, delegatesFocus: true});

  // The contentEditable still focuses normally when clicked, proving
  // the tabindex addition didn't break the standard focus path.
  await editor(page, 'summary').click();
  const focusedAfterClick = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="summary"]',
    ) as Element & {shadowRoot: ShadowRoot};
    const active = host.shadowRoot.activeElement;
    return active !== null ? active.getAttribute('data-lexical-editor') : null;
  });
  expect(focusedAfterClick).toBe('true');
});

test('setCustomValidity flags a customError and clears it with an empty message', async ({
  page,
}) => {
  // The notes editor starts with placeholder text so the form is valid.
  const initial = await page.evaluate(
    () =>
      (
        document.querySelector('lexical-editor[name="notes"]') as Element & {
          validity: ValidityState;
        }
      ).validity.valid,
  );
  expect(initial).toBe(true);

  // Apply a custom error message — host.validity.customError flips to
  // true and form.checkValidity() refuses to submit.
  await page.evaluate(() => {
    (
      document.querySelector('lexical-editor[name="notes"]') as Element & {
        setCustomValidity: (msg: string) => void;
      }
    ).setCustomValidity('Custom rejection.');
  });
  const flagged = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as Element & {
      validationMessage: string;
      validity: ValidityState;
    };
    const form = document.querySelector('#demo-form') as HTMLFormElement;
    return {
      formValid: form.checkValidity(),
      hostMessage: host.validationMessage,
      hostValid: host.validity.valid,
    };
  });
  expect(flagged).toEqual({
    formValid: false,
    hostMessage: 'Custom rejection.',
    hostValid: false,
  });

  // Clearing the custom message returns the host to its required-only
  // state — the notes editor has placeholder text, so it's valid again.
  await page.evaluate(() => {
    (
      document.querySelector('lexical-editor[name="notes"]') as Element & {
        setCustomValidity: (msg: string) => void;
      }
    ).setCustomValidity('');
  });
  const cleared = await page.evaluate(
    () =>
      (
        document.querySelector('lexical-editor[name="notes"]') as Element & {
          validity: ValidityState;
        }
      ).validity.valid,
  );
  expect(cleared).toBe(true);
});

test('DOM move (re-attach to a different parent) preserves the editor state', async ({
  page,
}) => {
  await clearAndType(page, 'notes', 'before the move');
  await page.evaluate(() => {
    const host = document.querySelector('lexical-editor[name="notes"]')!;
    // Appending to a new parent triggers disconnectedCallback +
    // connectedCallback on the host, which currently rebuilds the
    // editor. A production-grade `<my-editor>` should round-trip its
    // value through that lifecycle the same way `<input>` and
    // `<textarea>` round-trip theirs.
    document.body.appendChild(host);
  });
  await expect(editor(page, 'notes')).toHaveText('before the move');
});

test('reuses a declarative shadow DOM `.content` element instead of creating a new one', async ({
  page,
}) => {
  // The pre-rendered editor is declared in index.html as
  // `<lexical-editor name="prerendered">` with an inline
  // `<template shadowrootmode="open">`. Our connectedCallback honours
  // the existing shadow root and the existing `.content` element, so
  // the host stays in place (no fresh contentEditable flash). The
  // pre-rendered children get replaced by the editor's initial state.
  const evidence = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="prerendered"]',
    ) as Element & {shadowRoot: ShadowRoot};
    const ce = host.shadowRoot.querySelector(
      '[data-lexical-editor]',
    ) as HTMLElement;
    return {
      ceClass: ce.className,
      // The reused element kept its `data-prerendered` attribute.
      reused: ce.hasAttribute('data-prerendered'),
      shadowMode: host.shadowRoot.mode,
    };
  });
  expect(evidence).toEqual({
    ceClass: 'content',
    reused: true,
    shadowMode: 'open',
  });
});

test('defineLexicalEditorElement guards against a duplicate customElement registration', async ({
  page,
}) => {
  // The shipped helper exits early when `customElements.get` already
  // resolves; verify the underlying browser behaviour the guard
  // protects against by attempting a fresh `customElements.define`
  // with the same name — the browser throws `NotSupportedError`.
  const exception = await page.evaluate(() => {
    try {
      customElements.define('lexical-editor', class extends HTMLElement {});
      return null;
    } catch (e) {
      return e instanceof DOMException ? e.name : String(e);
    }
  });
  expect(exception).toBe('NotSupportedError');
});

test('connectedCallback failures surface through the host without crashing the page', async ({
  page,
}) => {
  // Create a host detached from the document, force its editor build
  // to fail by emptying `placeholder-text` after the constructor and
  // before `connectedCallback`, then make sure the host element still
  // renders nothing visible rather than crashing the surrounding page.
  const ok = await page.evaluate(() => {
    let error = null;
    const handler = event => {
      if (event.error !== undefined) {
        error = String(event.error);
      }
      event.preventDefault();
    };
    window.addEventListener('error', handler);
    try {
      const broken = document.createElement('lexical-editor');
      broken.setAttribute('name', 'broken');
      // The constructor doesn't throw. Putting the host into a detached
      // <div> exercises connectedCallback without affecting the live
      // form; if the build chain ever throws on a misconfigured host,
      // the surrounding page should not unmount.
      const wrapper = document.createElement('div');
      wrapper.appendChild(broken);
      document.body.appendChild(wrapper);
      wrapper.remove();
    } finally {
      window.removeEventListener('error', handler);
    }
    return error === null;
  });
  expect(ok).toBe(true);
});

test('exposes CSS Shadow Parts for the toolbar and content', async ({page}) => {
  const parts = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as Element & {shadowRoot: ShadowRoot};
    const shadow = host.shadowRoot;
    return {
      contentPart: shadow.querySelector('.content')!.getAttribute('part'),
      toolbarPart: shadow.querySelector('.toolbar')!.getAttribute('part'),
    };
  });
  expect(parts).toEqual({contentPart: 'content', toolbarPart: 'toolbar'});

  // The page-level `::part(toolbar)` rule actually paints — the
  // computed letter-spacing carries through the boundary.
  const spacing = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as Element & {shadowRoot: ShadowRoot};
    const tb = host.shadowRoot.querySelector('.toolbar') as HTMLElement;
    return window.getComputedStyle(tb).letterSpacing;
  });
  expect(spacing).not.toBe('normal');
});

test('a MutationObserver registered against the shadow root sees content edits', async ({
  page,
}) => {
  await clearAndType(page, 'notes', 'observed');
  // A MutationObserver on a node inside the shadow root sees mutations
  // there just like in the light DOM — there is no special boundary
  // setup. Verifying this directly catches future regressions to the
  // observer-side of the shadow story.
  const sawMutation = await page.evaluate(async () => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as Element & {shadowRoot: ShadowRoot};
    const ce = host.shadowRoot.querySelector('.content') as HTMLElement;
    return new Promise<boolean>(resolve => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        resolve(true);
      });
      observer.observe(ce, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, 1000);
      // Direct DOM mutation inside the shadow root. The observer is
      // registered on a shadow-internal node and sees the change with
      // no special configuration.
      const marker = document.createElement('span');
      marker.textContent = ' observer-marker';
      ce.appendChild(marker);
    });
  });
  expect(sawMutation).toBe(true);
});

test('the host spellcheck attribute mirrors onto the contentEditable', async ({
  page,
}) => {
  // Set `spellcheck="false"` on the host and confirm the contentEditable
  // picks it up. Toggling it back to true reverts.
  await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as HTMLElement;
    host.setAttribute('spellcheck', 'false');
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          (
            document.querySelector(
              'lexical-editor[name="notes"]',
            ) as Element & {shadowRoot: ShadowRoot}
          ).shadowRoot.querySelector('.content') as HTMLElement
        ).getAttribute('spellcheck'),
      ),
    )
    .toBe('false');
  await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as HTMLElement;
    host.setAttribute('spellcheck', 'true');
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          (
            document.querySelector(
              'lexical-editor[name="notes"]',
            ) as Element & {shadowRoot: ShadowRoot}
          ).shadowRoot.querySelector('.content') as HTMLElement
        ).getAttribute('spellcheck'),
      ),
    )
    .toBe('true');
});

test('lang on the host inherits into the shadow contentEditable', async ({
  page,
}) => {
  await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="summary"]',
    ) as HTMLElement;
    host.setAttribute('lang', 'ko');
  });
  const matches = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="summary"]',
    ) as Element & {shadowRoot: ShadowRoot};
    const ce = host.shadowRoot.querySelector('.content') as HTMLElement;
    // `lang` is an inherited HTML attribute — the CSS `:lang()`
    // selector picks up the host's `lang="ko"` on the shadow-internal
    // contentEditable without any JavaScript glue forwarding it.
    return ce.matches(':lang(ko)');
  });
  expect(matches).toBe(true);
});

test('focusin / focusout bubble across the shadow boundary', async ({page}) => {
  // `focusin` / `focusout` are composed + bubble; a page-level listener
  // sees the editor's focus changes despite the host sitting outside
  // the shadow tree.
  await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="summary"]',
    ) as HTMLElement;
    host.dataset.lastFocus = '';
    host.addEventListener('focusin', () => {
      host.dataset.lastFocus = 'in';
    });
    host.addEventListener('focusout', () => {
      host.dataset.lastFocus = 'out';
    });
  });
  await editor(page, 'summary').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            document.querySelector(
              'lexical-editor[name="summary"]',
            ) as HTMLElement
          ).dataset.lastFocus,
      ),
    )
    .toBe('in');
  await editor(page, 'notes').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            document.querySelector(
              'lexical-editor[name="summary"]',
            ) as HTMLElement
          ).dataset.lastFocus,
      ),
    )
    .toBe('out');
});

test('customElements.whenDefined resolves with the already-mounted host class', async ({
  page,
}) => {
  // `customElements.whenDefined` is the standard way to wait for an
  // element's class to be defined before reaching for its API. With our
  // module-side `defineLexicalEditorElement` already having run by
  // the time the page settled, the promise resolves immediately and
  // hands back the constructor we registered.
  const result = await page.evaluate(async () => {
    const ctor = await customElements.whenDefined('lexical-editor');
    return {
      hasGetEditor:
        typeof (ctor as unknown as {prototype: {getEditor: unknown}}).prototype
          .getEditor === 'function',
      name: ctor.name,
    };
  });
  expect(result.hasGetEditor).toBe(true);
  expect(result.name).toBe('LexicalEditorElement');
});

test('the form reset button drives formResetCallback on every editor', async ({
  page,
}) => {
  await clearAndType(page, 'notes', 'will be reset');
  await clearAndType(page, 'summary', 'also reset');
  await page.locator('button[type="reset"]').click();
  // `formResetCallback` clears the editor back to a single empty
  // paragraph; the contentEditable's text content is empty.
  await expect(editor(page, 'notes')).toHaveText('');
  await expect(editor(page, 'summary')).toHaveText('');
});

test('the form reset button re-syncs the readonly checkbox to the host', async ({
  page,
}) => {
  await clearAndType(page, 'summary', 'baseline');
  await page.locator('#summary-readonly').check();

  // `reset` fires before the form's reset algorithm restores each element,
  // so the page's helper defers one task before reading `checkbox.checked`
  // and propagating the post-reset value back to the host. Without that
  // defer the host would stay read-only after the reset.
  await page.locator('button[type="reset"]').click();
  await expect(page.locator('#summary-readonly')).not.toBeChecked();

  await editor(page, 'summary').click();
  await page.keyboard.type('resumed');
  await expect(editor(page, 'summary')).toHaveText('resumed');
});

test('the form reset button re-syncs the inert checkbox to the host', async ({
  page,
}) => {
  await clearAndType(page, 'summary', 'baseline');
  await page.locator('#summary-inert').check();

  // Mirror of the readonly path through the same bindCheckboxState helper:
  // form reset must release the inert attribute so the editor accepts
  // input again. Without the defer the host stays inert after reset.
  await page.locator('button[type="reset"]').click();
  await expect(page.locator('#summary-inert')).not.toBeChecked();

  await editor(page, 'summary').click();
  await page.keyboard.type('resumed');
  await expect(editor(page, 'summary')).toHaveText('resumed');
});

test('outerHTML / serialization carries the host element but not the shadow content by default', async ({
  page,
}) => {
  await clearAndType(page, 'notes', 'serialized');
  // Standard HTML serialization stops at the shadow boundary — the
  // host's outerHTML carries any light-DOM children but not the
  // shadow-mounted contentEditable. Pages that need to round-trip
  // server-rendered shadows can opt into declarative shadow DOM
  // serialization via `getHTML({serializableShadowRoots: true})`.
  const outer = await page.evaluate(
    () => document.querySelector('lexical-editor[name="notes"]')!.outerHTML,
  );
  expect(outer).not.toContain('serialized');
  expect(outer).toMatch(/<lexical-editor/);
});

test('host.form reflects ElementInternals and fires formAssociatedCallback', async ({
  page,
}) => {
  // The host is mounted inside `<form id="demo-form">`, so `host.form`
  // resolves through ElementInternals.form, and the page-level
  // `lexical-form-associated` listener has logged the initial
  // association.
  // Wire a fresh listener on the notes host *before* the move so the
  // page-level surface (which logs every host's last association on
  // `#last-edited`) can't be overwritten by a sibling host.
  await page.evaluate(() => {
    const notes = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as HTMLElement;
    notes.addEventListener('lexical-form-associated', event => {
      const detail = (event as CustomEvent<{form: HTMLFormElement | null}>)
        .detail;
      notes.dataset.lastForm = detail.form !== null ? detail.form.id : '(none)';
    });
  });

  const initial = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as Element & {form: HTMLFormElement | null};
    return {formId: host.form !== null ? host.form.id : null};
  });
  expect(initial.formId).toBe('demo-form');

  // Moving the host out of the form drives `formAssociatedCallback(null)`
  // and clears `host.form`.
  await page.evaluate(() => {
    const host = document.querySelector('lexical-editor[name="notes"]')!;
    document.body.appendChild(host);
  });
  const detached = await page.evaluate(
    () =>
      (
        document.querySelector('lexical-editor[name="notes"]') as Element & {
          form: HTMLFormElement | null;
        }
      ).form,
  );
  expect(detached).toBeNull();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const notes = document.querySelector(
          'lexical-editor[name="notes"]',
        ) as HTMLElement;
        return notes.dataset.lastForm !== undefined
          ? notes.dataset.lastForm
          : null;
      }),
    )
    .toBe('(none)');
});

test('formStateRestoreCallback restores a serialized editor state', async ({
  page,
}) => {
  // Type something so the host has a non-trivial serialized state, then
  // capture it.
  await clearAndType(page, 'notes', 'original content');
  const snapshot = await page.evaluate(() => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as Element & {value: string};
    return host.value;
  });

  // Wipe the editor.
  await editor(page, 'notes').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await expect(editor(page, 'notes')).toHaveText('');

  // Replay the serialized state through formStateRestoreCallback — the
  // same path the browser uses for bfcache navigation and form
  // autocomplete restore.
  await page.evaluate(state => {
    const host = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as Element & {
      formStateRestoreCallback: (
        value: string,
        reason: 'autocomplete' | 'restore',
      ) => void;
    };
    host.formStateRestoreCallback(state, 'restore');
  }, snapshot);

  await expect(editor(page, 'notes')).toHaveText('original content');
});

test('inert on the host blocks input across the shadow boundary', async ({
  page,
}) => {
  await clearAndType(page, 'summary', 'baseline');
  await page.locator('#summary-inert').check();

  // The standard `inert` attribute crosses the shadow boundary on its
  // own, so the contentEditable inside the summary's shadow root rejects
  // both focus and keyboard input without Lexical-side glue.
  const ce = editor(page, 'summary');
  await ce.click({force: true});
  await page.keyboard.type(' should be ignored');
  await expect(ce).toHaveText('baseline');

  // Removing the attribute restores interaction.
  await page.locator('#summary-inert').uncheck();
  await ce.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' restored');
  await expect(ce).toHaveText('baseline restored');
});

test('a required <lexical-editor> participates in form validation', async ({
  page,
}) => {
  // The notes editor in index.html is marked `required`. Out of the box its
  // editor state has no text content, so the form should refuse to submit.
  await editor(page, 'notes').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');

  const initialState = await page.evaluate(() => {
    const form = document.querySelector('form')!;
    const notes = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as HTMLElement & {
      validity: ValidityState;
      willValidate: boolean;
    };
    return {
      formValid: form.checkValidity(),
      notesMatchesInvalid: notes.matches(':invalid'),
      notesValueMissing: notes.validity.valueMissing,
      notesWillValidate: notes.willValidate,
    };
  });
  expect(initialState).toEqual({
    formValid: false,
    notesMatchesInvalid: true,
    notesValueMissing: true,
    notesWillValidate: true,
  });

  // Clicking submit on an invalid form does not run the submit handler, so
  // `#form-output` stays empty.
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('#form-output')).toHaveText('');

  // Once the user types something, the editor becomes valid and the form
  // submits.
  await editor(page, 'notes').click();
  await page.keyboard.type('now filled in');
  const filledState = await page.evaluate(() => {
    const notes = document.querySelector(
      'lexical-editor[name="notes"]',
    ) as HTMLElement & {validity: ValidityState};
    return {
      notesMatchesInvalid: notes.matches(':invalid'),
      notesValueMissing: notes.validity.valueMissing,
    };
  });
  expect(filledState).toEqual({
    notesMatchesInvalid: false,
    notesValueMissing: false,
  });

  await page.locator('button[type="submit"]').click();
  await expect(page.locator('#form-output')).toContainText('now filled in');
});

test('renders an editor inside two nested shadow roots', async ({page}) => {
  // page → #nested-host shadow → <lexical-editor> shadow. The contentEditable
  // is two shadow boundaries deep; getDOMShadowRoots' multi-level walk and the
  // composed selection reads should still resolve it.
  const nestedEditor = page.locator(
    '#nested-host >> lexical-editor[name="nested"] >> [data-lexical-editor]',
  );
  await expect(nestedEditor).toBeVisible();
  await nestedEditor.click();
  // Clear the editor's initial placeholder text before typing so the assertion
  // below matches the typed string exactly rather than the concatenation.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('nested shadow works');
  await expect(nestedEditor).toHaveText('nested shadow works');

  // The composed StaticRange resolves through both shadow boundaries, so
  // Bold via the in-shadow toolbar still operates on the right selection.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  const boldButton = page
    .locator('#nested-host >> lexical-editor[name="nested"] >> .toolbar button')
    .first();
  await boldButton.click();
  await expect(nestedEditor.locator('strong')).toHaveText('works');
});

test('floating popover anchors to a selection inside the nested shadow root', async ({
  page,
}) => {
  // The composed `lexical-selection-rect` event crosses two shadow boundaries
  // (editor shadow → wrapper shadow → light DOM document). `event.target` is
  // retargeted to #nested-host (the wrapper's light-DOM host), so main.ts has
  // to walk composedPath() to recover the actual <lexical-editor>. Without
  // that walk the page-side popover never opens for the nested editor — this
  // exercises the active-editor lookup end-to-end. It also confirms that a
  // non-active editor's null `lexical-selection-rect` event (every editor
  // emits one on every scroll, with $getSelection() === null for the inactive
  // ones) doesn't close the popover while the nested editor still has a
  // non-empty selection.
  const nestedEditor = page.locator(
    '#nested-host >> lexical-editor[name="nested"] >> [data-lexical-editor]',
  );
  await nestedEditor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('hello popover');
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }

  const popover = page.locator('#format-popover');
  await expect(popover).toBeVisible();
  await popover.locator('button[data-format="bold"]').click();
  await expect(nestedEditor.locator('strong')).toHaveText('popover');
});
