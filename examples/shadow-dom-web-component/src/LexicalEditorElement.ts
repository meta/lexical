/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  FORMAT_TEXT_COMMAND,
  getDOMSelectionRangeAndPoints,
  getDOMShadowRoots,
  type LexicalEditor,
  REDO_COMMAND,
  type TextFormatType,
  UNDO_COMMAND,
} from 'lexical';

// Styles live inside the shadow root, encapsulated from the page. Colours
// and font are surfaced as CSS custom properties so the page can theme each
// editor from the outside without reaching across the shadow boundary —
// inherited properties cross naturally.
const STYLE_SHEET = `
  :host {
    --lexical-bg: #fff;
    --lexical-fg: #1f2328;
    --lexical-border: #ddd;
    --lexical-toolbar-bg: #fafafa;
    --lexical-toolbar-divider: #eee;
    --lexical-toolbar-hover-bg: #ececec;
    --lexical-toolbar-pressed-bg: #e0e7ff;
    --lexical-toolbar-pressed-border: #c7d2fe;

    display: block;
    border: 1px solid var(--lexical-border);
    border-radius: 8px;
    background: var(--lexical-bg);
    color: var(--lexical-fg);
    font-family: system-ui, -apple-system, sans-serif;
  }
  .toolbar {
    display: flex;
    gap: 4px;
    padding: 6px;
    border-bottom: 1px solid var(--lexical-toolbar-divider);
    background: var(--lexical-toolbar-bg);
    border-radius: 8px 8px 0 0;
  }
  .toolbar button {
    min-width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 13px;
  }
  .toolbar button {
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .toolbar button:hover {
    background: var(--lexical-toolbar-hover-bg);
  }
  .toolbar button[aria-pressed='true'] {
    background: var(--lexical-toolbar-pressed-bg);
    border-color: var(--lexical-toolbar-pressed-border);
  }
  .toolbar .toolbar-spacer {
    flex: 1;
  }
  .toolbar ::slotted(button) {
    min-width: 28px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--lexical-border);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 13px;
  }
  .toolbar ::slotted(button:hover) {
    background: var(--lexical-toolbar-hover-bg);
  }
  .content {
    min-height: 110px;
    padding: 10px 12px;
    outline: none;
    font-size: 15px;
    line-height: 1.5;
  }
  .content p {
    margin: 0 0 6px 0;
  }
  .bold { font-weight: bold; }
  .italic { font-style: italic; }
  .underline { text-decoration: underline; }

  /* Print stylesheet — drop the toolbar and host chrome so the
   * editor's content prints cleanly. Each shadow root carries its
   * own copy of this rule, so multi-instance pages print each
   * editor's content with consistent typography. */
  @media print {
    :host {
      border: none;
      box-shadow: none;
    }
    .toolbar {
      display: none;
    }
  }

  /* The page sees these media queries inside the shadow root the same way
   * it sees them in the light DOM. Each editor adapts to the user's OS
   * preferences on its own — the page only needs to override variables
   * when it wants to opt out of (or force) a colour scheme. */
  @media (prefers-color-scheme: dark) {
    :host {
      --lexical-bg: #1c1d22;
      --lexical-fg: #e6e6e9;
      --lexical-border: #2d2f36;
      --lexical-toolbar-bg: #25262c;
      --lexical-toolbar-divider: #2d2f36;
      --lexical-toolbar-hover-bg: #32343a;
      --lexical-toolbar-pressed-bg: #2a2f4a;
      --lexical-toolbar-pressed-border: #3a4267;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toolbar button,
    .toolbar ::slotted(button) {
      transition: none;
    }
  }
  /* Windows High Contrast / forced-colors map our custom palette to the
   * user's system colours, so the editor stays usable in the high-contrast
   * theme without losing focus indicators or borders. */
  @media (forced-colors: active) {
    :host {
      --lexical-border: CanvasText;
      --lexical-toolbar-divider: CanvasText;
      --lexical-toolbar-pressed-border: Highlight;
    }
    .toolbar button[aria-pressed='true'] {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }
  }
`;

const TEXT_FORMATS: readonly TextFormatType[] = ['bold', 'italic', 'underline'];

/**
 * `<lexical-editor>`: a self-contained rich-text editor web component.
 *
 * Everything — toolbar, contentEditable, styles — lives inside an open
 * ShadowRoot attached in `connectedCallback`, demonstrating that Lexical
 * works fully encapsulated behind a shadow boundary using platform selection
 * APIs (Selection.getComposedRanges / ShadowRoot.activeElement).
 *
 * The element is form-associated through the standard ElementInternals API:
 * its form value is the serialized Lexical editor state (JSON), updated on
 * every editor update. It also dispatches a composed `input` event so light
 * DOM listeners can observe edits.
 */
export class LexicalEditorElement extends HTMLElement {
  static formAssociated = true;
  static observedAttributes = [
    'required',
    'disabled',
    'readonly',
    'aria-label',
    'spellcheck',
  ];

  private internals: ElementInternals;
  private editor: LexicalEditor | null = null;
  private disposeEditor: (() => void) | null = null;
  private formDisabled = false;
  // Cached serialized state from the previous mount, used to round-trip
  // the editor across DOM moves the same way `<input>` and `<textarea>`
  // round-trip their `value` attribute. Reset on the initial mount and
  // refilled in `disconnectedCallback`.
  private pendingState: string | null = null;
  private customValidityMessage = '';

  constructor() {
    super();
    this.internals = this.attachInternals();
  }

  /** The serialized Lexical editor state (JSON), as submitted with forms. */
  get value(): string {
    return this.editor
      ? JSON.stringify(this.editor.getEditorState().toJSON(true))
      : '';
  }

  set value(serializedEditorState: string) {
    const editor = this.editor;
    if (editor !== null && serializedEditorState !== '') {
      editor.setEditorState(editor.parseEditorState(serializedEditorState));
      this.updateValidity();
    }
  }

  /**
   * Whether this editor's `<form>` should block submission when it has no
   * text content. Mirrors `<input required>` / `<textarea required>`.
   */
  get required(): boolean {
    return this.hasAttribute('required');
  }

  set required(value: boolean) {
    if (value) {
      this.setAttribute('required', '');
    } else {
      this.removeAttribute('required');
    }
  }

  /**
   * Mirrors `<input disabled>`. A disabled editor is non-editable, drops out
   * of `FormData` (the standard form-associated custom-element behaviour),
   * and skips constraint validation.
   */
  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    if (value) {
      this.setAttribute('disabled', '');
    } else {
      this.removeAttribute('disabled');
    }
  }

  /**
   * Mirrors `<input readonly>`. A read-only editor is non-editable but still
   * submits its value and participates in constraint validation.
   */
  get readOnly(): boolean {
    return this.hasAttribute('readonly');
  }

  set readOnly(value: boolean) {
    if (value) {
      this.setAttribute('readonly', '');
    } else {
      this.removeAttribute('readonly');
    }
  }

  /** The underlying LexicalEditor, for programmatic access from the page. */
  getEditor(): LexicalEditor | null {
    return this.editor;
  }

  // Mirror the standard constraint-validation surface from `<input>` /
  // `<textarea>`. ElementInternals tracks the state but does not auto-expose
  // it on the host element.
  get validity(): ValidityState {
    return this.internals.validity;
  }

  get validationMessage(): string {
    return this.internals.validationMessage;
  }

  get willValidate(): boolean {
    return this.internals.willValidate;
  }

  checkValidity(): boolean {
    return this.internals.checkValidity();
  }

  reportValidity(): boolean {
    return this.internals.reportValidity();
  }

  /**
   * Mirror `<input>.setCustomValidity()`: a non-empty message marks the
   * host as having a `customError`, an empty string clears it. The
   * built-in `required` check still runs underneath, but the custom
   * message wins when both apply (matches the platform behaviour).
   */
  setCustomValidity(message: string): void {
    this.customValidityMessage = message;
    this.updateValidity();
  }

  /**
   * The editor's text content, used for the `required` empty check. Mirrors
   * what a server-side validator would see when stripping the rich-text JSON
   * down to plain text.
   */
  private getPlainText(): string {
    return this.editor
      ? this.editor.read('latest', () => $getRoot().getTextContent())
      : '';
  }

  private updateValidity(): void {
    if (this.customValidityMessage !== '') {
      const shadow = this.shadowRoot;
      const anchor =
        shadow !== null
          ? ((shadow.querySelector('.content') as HTMLElement | null) ?? this)
          : this;
      this.internals.setValidity(
        {customError: true},
        this.customValidityMessage,
        anchor,
      );
    } else if (!this.required) {
      this.internals.setValidity({});
    } else if (this.getPlainText().trim().length === 0) {
      // Find the toolbar's first focusable button as the anchor for the
      // browser's validation tooltip when the editor itself isn't focusable.
      const shadow = this.shadowRoot;
      const anchor =
        shadow !== null
          ? ((shadow.querySelector('.content') as HTMLElement | null) ?? this)
          : this;
      this.internals.setValidity(
        {valueMissing: true},
        'Please fill in this field.',
        anchor,
      );
    } else {
      this.internals.setValidity({});
    }
    // Reflect the validity state on the contentEditable through
    // `aria-invalid`, which screen readers expose on focus, and let the
    // page hook a visible error message through a composed CustomEvent.
    // (ARIA's `aria-describedby` can't reference IDs across the shadow
    // boundary in practice, so the page side has to wire up its own
    // visible message and Lexical can't do that part for it.)
    const contentEditable = this.findContentEditable();
    if (contentEditable !== null) {
      contentEditable.setAttribute(
        'aria-invalid',
        this.internals.validity.valid ? 'false' : 'true',
      );
    }
    this.dispatchEvent(
      new CustomEvent('lexical-validity-change', {
        bubbles: true,
        composed: true,
        detail: {
          message: this.internals.validationMessage,
          valid: this.internals.validity.valid,
        },
      }),
    );
  }

  /**
   * Mirror the host's `aria-label` onto the contentEditable so screen
   * readers announce the editor with the page-supplied label rather than
   * the generic "edit text" prompt.
   */
  private syncAriaLabel(): void {
    const contentEditable = this.findContentEditable();
    if (contentEditable === null) {
      return;
    }
    const fromAria = this.getAttribute('aria-label');
    const fromName = this.getAttribute('name');
    const label =
      fromAria !== null
        ? fromAria
        : fromName !== null
          ? fromName
          : 'Rich text editor';
    contentEditable.setAttribute('aria-label', label);
  }

  private findContentEditable(): HTMLElement | null {
    const shadow = this.shadowRoot;
    if (shadow === null) {
      return null;
    }
    return shadow.querySelector<HTMLElement>('.content');
  }

  attributeChangedCallback(name: string): void {
    if (name === 'required') {
      this.updateValidity();
    } else if (name === 'disabled' || name === 'readonly') {
      this.updateEditableState();
    } else if (name === 'aria-label') {
      this.syncAriaLabel();
    } else if (name === 'spellcheck') {
      this.syncSpellcheck();
    }
  }

  /**
   * Mirror the host's `spellcheck` attribute onto the contentEditable so
   * the browser's native spell checking is opt-in / opt-out from the
   * page just like it is on `<input>` and `<textarea>`.
   */
  private syncSpellcheck(): void {
    const contentEditable = this.findContentEditable();
    if (contentEditable === null) {
      return;
    }
    const attr = this.getAttribute('spellcheck');
    contentEditable.setAttribute(
      'spellcheck',
      attr !== 'false' ? 'true' : 'false',
    );
  }

  formResetCallback(): void {
    if (this.editor !== null) {
      this.editor.update(() => {
        $getRoot().clear().append($createParagraphNode());
      });
      this.internals.setFormValue(this.value);
      this.updateValidity();
    }
  }

  // Form-associated custom elements receive this when an ancestor `<form>`
  // or `<fieldset>` toggles its disabled state. Treated the same as the
  // element's own `disabled` attribute.
  formDisabledCallback(isDisabled: boolean): void {
    this.formDisabled = isDisabled;
    this.updateEditableState();
  }

  /**
   * Fires whenever the host associates with or disassociates from a
   * `<form>` (e.g. the element is moved into / out of one programmatically).
   * Surfaced as a composed CustomEvent so a page-level handler can drop
   * form-scoped listeners as the host changes forms without having to
   * walk the DOM itself.
   */
  formAssociatedCallback(form: HTMLFormElement | null): void {
    this.dispatchEvent(
      new CustomEvent('lexical-form-associated', {
        bubbles: true,
        composed: true,
        detail: {form},
      }),
    );
  }

  /**
   * Form state restore — fires on bfcache navigation (`reason: 'restore'`)
   * and on the browser's autocomplete restore (`reason: 'autocomplete'`).
   * The state argument is whatever this host last passed to
   * `internals.setFormValue` (a serialized editor state JSON string in
   * our case), so a round-trip through `parseEditorState` brings the
   * editor back to where it was before the navigation.
   */
  formStateRestoreCallback(
    state: File | string | FormData,
    _reason: 'autocomplete' | 'restore',
  ): void {
    if (typeof state !== 'string' || state === '' || this.editor === null) {
      return;
    }
    this.editor.setEditorState(this.editor.parseEditorState(state));
    this.internals.setFormValue(this.value);
    this.updateValidity();
  }

  /** The `<form>` the host is currently associated with, or null. */
  get form(): HTMLFormElement | null {
    return this.internals.form;
  }

  private updateEditableState(): void {
    if (this.editor !== null) {
      this.editor.setEditable(
        !this.disabled && !this.readOnly && !this.formDisabled,
      );
    }
  }

  connectedCallback(): void {
    // On re-attach the shadowRoot persists from the previous mount but
    // disconnectedCallback has disposed the editor. Reuse the existing
    // shadow root and clear its children so the flow below rebuilds them
    // cleanly instead of leaving the element with editor === null.
    // `delegatesFocus: true` makes `host.focus()` (and labelled-field
    // focus from `<label for="...">`) route to the first focusable
    // element inside the shadow root — for us that's the contentEditable.
    // `:focus-within` on the host also lights up while focus is anywhere
    // inside the shadow tree, which keeps Tab navigation feeling like a
    // built-in form control.
    const shadow =
      this.shadowRoot !== null
        ? this.shadowRoot
        : this.attachShadow({delegatesFocus: true, mode: 'open'});
    // Honour a shadow root left behind by a [Declarative Shadow
    // DOM](https://developer.mozilla.org/docs/Web/API/Web_components/Using_shadow_DOM#declarative_shadow_dom)
    // (`<template shadowrootmode="open">`): if the SSR layer already
    // pre-rendered a `.content` div we reuse the element node so the
    // page doesn't flash a fresh contentEditable on hydration. The
    // editor's initial state still replaces the pre-rendered children
    // — `@lexical/html`'s `$generateNodesFromDOM` would let downstream
    // users keep that content, but pulling it in here would balloon
    // the example beyond the shadow integration story.
    const prerendered = shadow.querySelector<HTMLElement>('.content');
    while (shadow.firstChild !== null) {
      shadow.removeChild(shadow.firstChild);
    }

    const style = this.ownerDocument.createElement('style');
    style.textContent = STYLE_SHEET;
    shadow.appendChild(style);

    const toolbar = this.ownerDocument.createElement('div');
    toolbar.className = 'toolbar';
    // Expose the toolbar through the [CSS Shadow Parts]
    // (https://developer.mozilla.org/docs/Web/CSS/::part) API so the
    // page can style it with `lexical-editor::part(toolbar)` without
    // reaching through the shadow boundary.
    toolbar.setAttribute('part', 'toolbar');
    toolbar.setAttribute('role', 'toolbar');
    shadow.appendChild(toolbar);
    // A named slot at the end of the toolbar lets the page project its own
    // buttons (`<button slot="toolbar-extra">…</button>`) into the editor's
    // toolbar row. Slotted nodes stay in the light DOM — their events bubble
    // out to page-level listeners — but they render visually inside the
    // shadow root alongside our built-in toolbar buttons.
    const toolbarSpacer = this.ownerDocument.createElement('span');
    toolbarSpacer.className = 'toolbar-spacer';
    const toolbarSlot = this.ownerDocument.createElement('slot');
    toolbarSlot.name = 'toolbar-extra';

    const contentEditable =
      prerendered !== null
        ? prerendered
        : this.ownerDocument.createElement('div');
    contentEditable.className = 'content';
    contentEditable.contentEditable = 'true';
    // Surface the editor to assistive tech the same way a built-in
    // `<input type="text">` would. `contenteditable="true"` already gets an
    // implicit textbox role, but spelling it out keeps the intent visible
    // and makes the ARIA review at PR time simple. `aria-multiline` is
    // what tells screen readers to announce Enter as "newline" instead of
    // "submit".
    contentEditable.setAttribute('part', 'content');
    contentEditable.setAttribute('role', 'textbox');
    contentEditable.setAttribute('aria-multiline', 'true');
    // `delegatesFocus: true` on the shadow root routes `host.focus()` to
    // the first focusable element inside; the focus-delegate algorithm
    // checks `tabindex` first, so make the contentEditable explicitly
    // focusable.
    contentEditable.tabIndex = 0;
    shadow.appendChild(contentEditable);

    const initialText =
      this.getAttribute('placeholder-text') !== null
        ? (this.getAttribute('placeholder-text') as string)
        : '';
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode(initialText)),
          );
        },
        dependencies: [RichTextExtension, HistoryExtension],
        name: `lexical-editor/${this.getAttribute('name') || 'anonymous'}`,
        namespace: 'lexical-editor-element',
        theme: {
          text: {bold: 'bold', italic: 'italic', underline: 'underline'},
        },
      }),
    );
    editor.setRootElement(contentEditable);
    // Mirror `@lexical/react`'s ContentEditable: flip the DOM attribute when
    // Lexical's editable flag changes, so toggling `disabled` / `readonly`
    // on the host actually blocks input on the contentEditable.
    const removeEditableListener = editor.registerEditableListener(editable => {
      contentEditable.contentEditable = editable ? 'true' : 'false';
    });
    this.editor = editor;
    // Round-trip the editor state across DOM moves. `disconnectedCallback`
    // cached the last serialized state before disposal; restore it here so
    // re-attaching the host to a different parent doesn't drop the user's
    // content the way a naive rebuild would.
    if (this.pendingState !== null) {
      editor.setEditorState(editor.parseEditorState(this.pendingState));
      this.pendingState = null;
    }
    // Initialize the form value so a submit before the user types still
    // produces a non-empty serialized state, mirroring `<input value="...">`.
    this.internals.setFormValue(this.value);
    this.syncAriaLabel();
    this.syncSpellcheck();
    this.updateValidity();
    this.updateEditableState();

    const formatButtons = new Map<TextFormatType, HTMLButtonElement>();
    const addButton = (label: string, onClick: () => void) => {
      const button = this.ownerDocument.createElement('button');
      button.type = 'button';
      button.textContent = label;
      // Keep focus (and therefore selection) in the editor when clicked.
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', onClick);
      toolbar.appendChild(button);
      return button;
    };
    for (const format of TEXT_FORMATS) {
      formatButtons.set(
        format,
        addButton(format[0].toUpperCase(), () =>
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, format),
        ),
      );
    }
    addButton('↺', () => editor.dispatchCommand(UNDO_COMMAND));
    addButton('↻', () => editor.dispatchCommand(REDO_COMMAND));
    toolbar.appendChild(toolbarSpacer);
    toolbar.appendChild(toolbarSlot);

    // Surface the live selection rect to the page so a light-DOM floating
    // popover can anchor to text inside the shadow root. Called from the
    // update listener (selection change) and the scroll listeners below
    // (selection unchanged but its viewport position moved).
    // `getDOMSelectionRangeAndPoints` un-retargets the boundary points across
    // the shadow boundary and returns a live Range, so `getBoundingClientRect()`
    // gives viewport coordinates the page can use directly. Collapsed (or no)
    // range -> rect is null.
    const dispatchSelectionRect = (): void => {
      editor.read('latest', () => {
        const selection = $getSelection();
        let rect: DOMRectInit | null = null;
        if ($isRangeSelection(selection) && !selection.isCollapsed()) {
          const native = contentEditable.ownerDocument.getSelection();
          if (native !== null) {
            const {range} = getDOMSelectionRangeAndPoints(
              native,
              contentEditable,
            );
            const measured =
              range !== null ? range.getBoundingClientRect() : null;
            if (
              measured !== null &&
              (measured.width !== 0 || measured.height !== 0)
            ) {
              const view = contentEditable.ownerDocument.defaultView;
              const viewportHeight = view !== null ? view.innerHeight : 0;
              const inViewport =
                measured.bottom > 0 && measured.top < viewportHeight;
              if (inViewport) {
                rect = {
                  height: measured.height,
                  width: measured.width,
                  x: measured.x,
                  y: measured.y,
                };
              }
            }
          }
        }
        this.dispatchEvent(
          new CustomEvent('lexical-selection-rect', {
            bubbles: true,
            composed: true,
            detail: {rect},
          }),
        );
      });
    };

    const removeUpdateListener = editor.registerUpdateListener(
      ({editorState, dirtyElements, dirtyLeaves}) => {
        // Reflect the selection's formats in the toolbar, proving selection
        // reads work inside the shadow root. Runs on every update so pure
        // selection changes still refresh the active-format indicators.
        editorState.read(
          () => {
            const selection = $getSelection();
            for (const [format, button] of formatButtons) {
              button.setAttribute(
                'aria-pressed',
                String(
                  $isRangeSelection(selection) && selection.hasFormat(format),
                ),
              );
            }
          },
          {editor},
        );
        dispatchSelectionRect();
        // Form value + bubbling input event mirror an HTMLInputElement: only
        // fire on real content changes, not on pure selection updates, so
        // page-level form/input listeners aren't woken up for caret moves.
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
          return;
        }
        // Standard form association: the form value is the serialized state.
        this.internals.setFormValue(JSON.stringify(editorState.toJSON(true)));
        // Re-evaluate `required` validity now that the text content changed.
        this.updateValidity();
        // Composed so it crosses the shadow boundary to page listeners.
        this.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
      },
    );

    // Scroll-aware popover anchoring. The lexical-selection-rect event above
    // only fires on editor updates, so once the user scrolls the popover
    // stays anchored to a stale viewport coordinate. Listen for scroll on the
    // editor's window + every enclosing shadow root (per the LexicalMenu
    // pattern from R3) so the page-side popover follows the selection as it
    // moves through the viewport.
    const win = contentEditable.ownerDocument.defaultView;
    const scrollTargets: EventTarget[] = win !== null ? [win] : [];
    for (const root of getDOMShadowRoots(contentEditable)) {
      scrollTargets.push(root);
    }
    const onScroll = (): void => {
      dispatchSelectionRect();
    };
    for (const target of scrollTargets) {
      target.addEventListener('scroll', onScroll, {
        capture: true,
        passive: true,
      });
    }

    this.disposeEditor = () => {
      removeUpdateListener();
      removeEditableListener();
      for (const target of scrollTargets) {
        target.removeEventListener('scroll', onScroll, true);
      }
      editor.dispose();
    };
  }

  disconnectedCallback(): void {
    if (this.disposeEditor !== null) {
      // Cache the serialized editor state before tearing the editor
      // down, so a subsequent `connectedCallback` (DOM move) can rebuild
      // the editor and restore the user's content from where they left
      // off.
      this.pendingState = this.value;
      this.disposeEditor();
      this.disposeEditor = null;
      this.editor = null;
    }
  }
}

export function defineLexicalEditorElement(tagName = 'lexical-editor'): void {
  if (customElements.get(tagName) === undefined) {
    customElements.define(tagName, LexicalEditorElement);
  }
}
