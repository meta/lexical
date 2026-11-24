/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {AnyLexicalExtension, LexicalEditor} from 'lexical';

import {
  batch,
  effect,
  getExtensionDependencyFromEditor,
  getPeerDependencyFromEditor,
  SelectBlockExtension,
  SelectionAlwaysOnDisplayExtension,
  WatchEditableExtension,
} from '@lexical/extension';
import {
  ClickableLinkExtension,
  type LinkAttributes,
  LinkExtension,
} from '@lexical/link';
import {CheckListExtension, ListExtension} from '@lexical/list';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {TableExtension} from '@lexical/table';
import {useEffect} from 'react';

import {INITIAL_SETTINGS, type Settings} from '../appSettings';
import {useSettings} from '../context/SettingsContext';
import {AutocompleteExtension} from '../plugins/AutocompleteExtension';
import {CodeHighlightExtension} from '../plugins/CodeHighlightExtension';
import {MaxLengthExtension} from '../plugins/MaxLengthPlugin';
import {SpecialTextExtension} from '../plugins/SpecialTextExtension';
import {VisibleNonPrintingExtension} from '../plugins/VisibleNonPrintingExtension';

const DEFAULT_LINK_ATTRIBUTES: LinkAttributes = {
  rel: 'noopener noreferrer',
  target: '_blank',
};

/**
 * Output of an extension that is always part of the playground editor (it
 * lives in `AppExtension` or is pulled in by the import pipeline). Presence is
 * asserted — a missing one is a wiring bug, not an expected mode difference.
 */
function output<Extension extends AnyLexicalExtension>(
  editor: LexicalEditor,
  extension: Extension,
) {
  return getExtensionDependencyFromEditor(editor, extension).output;
}

/**
 * Output of an extension that may be absent: the rich-text-only extensions
 * (`List`, `Table`, `CheckList`, and the playground `CodeHighlight`) don't
 * exist in plain-text mode, so resolve them with the optional (peer) form and
 * skip them when not built.
 */
function peerOutput<Extension extends AnyLexicalExtension>(
  editor: LexicalEditor,
  extension: Extension,
) {
  return getPeerDependencyFromEditor<Extension>(editor, extension.name)?.output;
}

/**
 * Write the playground's settings onto the live editor's reactive extension
 * config signals. These are deliberately kept OUT of App.tsx's DynamicSettings
 * (which would rebuild the whole editor); they are applied here without
 * recreating it.
 *
 * A `@preact/signals-core` write is a no-op when the value is unchanged
 * (strict `!==`), so this only does work for the signals that actually
 * changed, and `batch` coalesces the dependent extension effects (e.g.
 * TableExtension's reconcile) into one flush.
 *
 * Exposed as a plain function so the editor's root extension can run it from
 * `register` with {@link INITIAL_SETTINGS} — applying the settings
 * synchronously as the editor is built, before any React effect runs.
 */
export function synchronizeSettingsToSignals(
  editor: LexicalEditor,
  settings: Settings,
): void {
  batch(() => {
    output(editor, AutocompleteExtension).disabled.value =
      !settings.isAutocomplete;
    output(editor, VisibleNonPrintingExtension).disabled.value =
      !settings.isVisibleNonPrinting;
    output(editor, MaxLengthExtension).disabled.value = !settings.isMaxLength;
    const codeHighlight = peerOutput(editor, CodeHighlightExtension);
    if (codeHighlight) {
      codeHighlight.mode.value = !settings.isCodeHighlighted
        ? 'off'
        : settings.isCodeShiki
          ? 'shiki'
          : 'prism';
    }
    output(editor, SpecialTextExtension).disabled.value =
      !settings.shouldAllowHighlightingWithBrackets;
    output(editor, LinkExtension).attributes.value = settings.hasLinkAttributes
      ? DEFAULT_LINK_ATTRIBUTES
      : undefined;
    const list = peerOutput(editor, ListExtension);
    if (list) {
      list.hasStrictIndent.value = settings.listStrictIndent;
    }
    const table = peerOutput(editor, TableExtension);
    if (table) {
      table.hasCellMerge.value = settings.tableCellMerge;
      table.hasCellBackgroundColor.value = settings.tableCellBackgroundColor;
      table.hasHorizontalScroll.value =
        settings.tableHorizontalScroll && !settings.hasFitNestedTables;
      table.hasNestedTables.value = settings.hasNestedTables;
    }
    const checkList = peerOutput(editor, CheckListExtension);
    if (checkList) {
      checkList.disableTakeFocusOnClick.value =
        settings.shouldDisableFocusOnClickChecklist;
    }
    output(editor, SelectionAlwaysOnDisplayExtension).disabled.value =
      !settings.selectionAlwaysOnDisplay;
    output(editor, SelectBlockExtension).disabled.value = !settings.selectBlock;
  });
}

/**
 * Editor-build-time setup for the playground's settings synchronization,
 * intended to be returned from the root extension's `register`:
 *
 * - Applies {@link INITIAL_SETTINGS} synchronously so the editor matches the
 *   playground defaults from the moment it is created (no first-render flash
 *   while a React effect catches up).
 * - Links the editor's editable state (exposed as a signal by
 *   {@link WatchEditableExtension}) to {@link ClickableLinkExtension}'s
 *   `disabled` signal, so clickable links are active only in read-only mode.
 *   This is editor state rather than a setting, so it is driven by a signals
 *   `effect` (reactive, no React re-render) instead of `useLexicalEditable`.
 */
export function registerSettingsSynchronization(
  editor: LexicalEditor,
): () => void {
  synchronizeSettingsToSignals(editor, INITIAL_SETTINGS);
  const editable = output(editor, WatchEditableExtension);
  const clickableLink = output(editor, ClickableLinkExtension);
  return effect(() => {
    clickableLink.disabled.value = editable.value;
  });
}

/**
 * React side of {@link synchronizeSettingsToSignals}: re-applies the settings
 * context whenever it changes. The initial application happens synchronously
 * in {@link registerSettingsSynchronization}; this keeps the live editor in
 * sync as the user toggles settings.
 */
export function useSynchronizeSettings(): void {
  const [editor] = useLexicalComposerContext();
  const {settings} = useSettings();
  useEffect(() => {
    synchronizeSettingsToSignals(editor, settings);
  }, [editor, settings]);
}
