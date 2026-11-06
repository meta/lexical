/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './styles.css';

import {
  $createParagraphNode,
  $getRoot,
  FORMAT_TEXT_COMMAND,
  isHTMLElement,
  type TextFormatType,
} from 'lexical';

import {
  defineLexicalEditorElement,
  type LexicalEditorElement,
} from './LexicalEditorElement';

defineLexicalEditorElement();

// Mount a <lexical-editor> inside a second shadow root so the editor's
// contentEditable lives two shadow boundaries below the document. This
// exercises the multi-level getDOMShadowRoots walk and the per-shadow-root
// scroll listeners that the floating popover relies on.
const nestedHost = document.querySelector<HTMLDivElement>('#nested-host');
if (nestedHost !== null) {
  const wrapperShadow = nestedHost.attachShadow({mode: 'open'});
  const nestedEditor = document.createElement('lexical-editor');
  nestedEditor.setAttribute('name', 'nested');
  nestedEditor.setAttribute(
    'placeholder-text',
    'Editor inside two nested shadow roots',
  );
  nestedEditor.setAttribute('aria-label', 'Nested editor');
  wrapperShadow.appendChild(nestedEditor);
}

// Demonstrate the form association: submitting the form shows the value each
// editor contributed through ElementInternals.setFormValue.
const form = document.querySelector<HTMLFormElement>('#demo-form')!;
const output = document.querySelector<HTMLPreElement>('#form-output')!;
form.addEventListener('submit', event => {
  event.preventDefault();
  const lines: string[] = [];
  for (const [name, value] of new FormData(form)) {
    lines.push(
      `${name}: ${JSON.stringify(JSON.parse(String(value)), null, 2)}`,
    );
  }
  output.textContent = lines.join('\n\n');
});

// Demonstrate the composed `input` event crossing the shadow boundary.
const status = document.querySelector<HTMLElement>('#last-edited')!;
for (const editorElement of document.querySelectorAll<LexicalEditorElement>(
  'lexical-editor',
)) {
  editorElement.addEventListener('input', () => {
    status.textContent = `Last edited: ${editorElement.getAttribute('name')}`;
  });
}

// The Clear button is a light-DOM child of <lexical-editor name="notes">
// projected through the `toolbar-extra` slot. Its click stays in the page,
// crosses no shadow boundary, and drives the editor through the host's
// public API — Lexical sees nothing different from a built-in toolbar
// button click.
const clearButton = document.querySelector<HTMLButtonElement>('[data-clear]');
if (clearButton !== null) {
  clearButton.addEventListener('click', () => {
    const host = document.querySelector<LexicalEditorElement>(
      'lexical-editor[name="notes"]',
    );
    const editor = host !== null ? host.getEditor() : null;
    if (editor !== null) {
      editor.update(() => {
        $getRoot().clear().append($createParagraphNode());
      });
    }
  });
}

// Light-DOM floating popover anchored to the live selection inside either
// editor's shadow root. The page never reaches into the shadow root: the
// editor emits a composed `lexical-selection-rect` CustomEvent carrying
// viewport coordinates, and the popover positions itself from those.
type SelectionRectDetail = {
  rect: {height: number; width: number; x: number; y: number} | null;
};
const popover = document.querySelector<HTMLElement>('#format-popover')!;
let activeEditor: LexicalEditorElement | null = null;

document.addEventListener('lexical-selection-rect', event => {
  const detail = (event as CustomEvent<SelectionRectDetail>).detail;
  // `event.target` is retargeted to the outermost shadow host when the event
  // crosses multiple shadow boundaries (the nested editor's composed event
  // lands on the wrapper's host div, not on `<lexical-editor>`). Walk the
  // composed path to recover the actual `<lexical-editor>` element.
  const sourceEditor =
    (event
      .composedPath()
      .find(
        (el): el is LexicalEditorElement =>
          isHTMLElement(el) && el.tagName === 'LEXICAL-EDITOR',
      ) as LexicalEditorElement | undefined) ?? null;
  if (detail.rect === null) {
    // Every editor reports its own rect on every scroll, so a non-active
    // editor's null event (its $getSelection() is null) would close the
    // popover even while the active editor still has a valid selection.
    // Only honour null from the active editor (or when no editor is
    // active yet) — anything else is just background chatter.
    if (sourceEditor === activeEditor || activeEditor === null) {
      if (popover.matches(':popover-open')) {
        popover.hidePopover();
      }
      activeEditor = null;
    }
    return;
  }
  activeEditor = sourceEditor;
  if (activeEditor === null) {
    return;
  }
  // Anchor below the selection rect. Viewport coordinates from the editor
  // are usable directly because `position: fixed` shares the same frame.
  const left = Math.max(8, detail.rect.x);
  const top = detail.rect.y + detail.rect.height + 6;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.showPopover();
});

for (const button of popover.querySelectorAll<HTMLButtonElement>(
  'button[data-format]',
)) {
  // Keep focus (and selection) in the active editor when the button is
  // clicked; otherwise the contenteditable would blur and the selection
  // would collapse before the command runs.
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    const format = button.dataset.format as TextFormatType | undefined;
    if (format === undefined) {
      return;
    }
    const editor = activeEditor !== null ? activeEditor.getEditor() : null;
    if (editor !== null) {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
    }
  });
}

// Mirror a checkbox's state onto a target on every toggle, plus once after
// a form reset. `reset` fires before the form restores each element, and a
// microtask queued from the listener drains in the same step, so defer one
// task to read the post-reset value.
function bindCheckboxState(
  checkbox: HTMLInputElement,
  apply: (checked: boolean) => void,
): void {
  const propagate = () => apply(checkbox.checked);
  checkbox.addEventListener('change', propagate);
  const associatedForm = checkbox.form;
  if (associatedForm !== null) {
    associatedForm.addEventListener('reset', () => setTimeout(propagate, 0));
  }
}

// Read-only toggle. Setting the standard `readonly` attribute on the host
// is enough — the element observes the attribute and flips Lexical's
// editable state to match. The form still submits the value, just like a
// `<textarea readonly>`.
const readonlyToggle =
  document.querySelector<HTMLInputElement>('#summary-readonly');
if (readonlyToggle !== null) {
  bindCheckboxState(readonlyToggle, checked => {
    const summary = document.querySelector<LexicalEditorElement>(
      'lexical-editor[name="summary"]',
    );
    if (summary !== null) {
      summary.readOnly = checked;
    }
  });
}

// `inert` toggle. The standard `inert` attribute turns the editor's
// subtree into a non-interactive region — focus, pointer events and
// selection skip it. Like `dir`, the property crosses the shadow
// boundary on its own, so no editor-side glue is needed.
const inertToggle = document.querySelector<HTMLInputElement>('#summary-inert');
if (inertToggle !== null) {
  bindCheckboxState(inertToggle, checked => {
    const summary = document.querySelector<LexicalEditorElement>(
      'lexical-editor[name="summary"]',
    );
    if (summary !== null) {
      if (checked) {
        summary.setAttribute('inert', '');
      } else {
        summary.removeAttribute('inert');
      }
    }
  });
}

// Form-associated lifecycle log. The host fires the composed
// `lexical-form-associated` event from `formAssociatedCallback`; the
// page listens once so a page-level handler could, for instance, drop
// any form-scoped state when the editor is moved into a different
// `<form>`. The last association is stashed on the status node as a
// data attribute so the Playwright suite can read it.
for (const ed of document.querySelectorAll<LexicalEditorElement>(
  'lexical-editor',
)) {
  const surface = (associatedForm: HTMLFormElement | null) => {
    const name = ed.getAttribute('name');
    const formId =
      associatedForm !== null
        ? associatedForm.id !== ''
          ? associatedForm.id
          : 'form'
        : '(none)';
    status.dataset.lastFormAssociation = `${name} → ${formId}`;
  };
  ed.addEventListener('lexical-form-associated', event => {
    surface((event as CustomEvent<{form: HTMLFormElement | null}>).detail.form);
  });
  // The initial association already fired before this listener was
  // attached, so surface it from `host.form` directly.
  surface(ed.form);
}

// Visible error message tied to the notes editor's required validation.
// The host element fires a composed `lexical-validity-change` event when
// its constraint-validation state changes; the page toggles the visible
// message based on the live state. (ARIA's `aria-describedby` can't
// reference IDs across the shadow boundary, so the page handles its own
// visible message and Lexical sets `aria-invalid` on the contentEditable
// for screen readers.)
const notesError = document.querySelector<HTMLElement>('#notes-error');
const notesHost = document.querySelector<LexicalEditorElement>(
  'lexical-editor[name="notes"]',
);
if (notesError !== null && notesHost !== null) {
  notesHost.addEventListener('lexical-validity-change', event => {
    const detail = (event as CustomEvent<{message: string; valid: boolean}>)
      .detail;
    notesError.hidden = detail.valid;
    notesError.textContent =
      detail.message !== '' ? detail.message : "This field can't be empty.";
  });
}
