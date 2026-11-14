/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  ClearEditorExtension,
  effect,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  editorStateFromSerializedDocument,
  serializedDocumentFromEditorState,
} from '@lexical/file';
import {$convertFromMarkdownString} from '@lexical/mdast';
import {mergeRegister} from '@lexical/utils';
import {
  CLEAR_EDITOR_COMMAND,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalEditor,
  registerEventListener,
  safeCast,
} from 'lexical';

import {docFromHash, docToHash} from '../utils/docSerialization';
import {MdastEditorExtension} from './MdastEditorExtension';

export interface MarkdownPersistenceConfig {
  /** localStorage key the markdown document is stored under. */
  storageKey: string;
  /** Markdown to seed the editor with when nothing is stored, and the
   * value the {@link RESET_MARKDOWN_COMMAND} restores. */
  defaultMarkdown: string;
}

/**
 * Resets the document back to the configured default markdown, removes
 * the persisted copy from localStorage, and leaves repro-link mode (the
 * URL hash is dropped and persistence resumes).
 */
export const RESET_MARKDOWN_COMMAND = createCommand<void>(
  'RESET_MARKDOWN_COMMAND',
);

/**
 * A document reference parsed from the URL hash — the example's repro-link
 * convention, mirroring the playground's `#doc=`:
 *
 * - `#md=<encodeURIComponent(markdown)>` — hand-authorable Markdown.
 * - `#doc=<base64url(gzip(SerializedDocument))>` — the full editor state
 *   JSON, for repros of node/state shapes Markdown can't express.
 */
type HashDocument =
  | {kind: 'markdown'; markdown: string}
  | {kind: 'doc'; hash: string};

function readHashDocument(): HashDocument | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const hash = window.location.hash;
  const md = /^#md=([\s\S]*)$/.exec(hash);
  if (md !== null) {
    try {
      return {kind: 'markdown', markdown: decodeURIComponent(md[1])};
    } catch {
      return null;
    }
  }
  return /^#doc=./.test(hash) ? {hash, kind: 'doc'} : null;
}

/** Builds a shareable URL that seeds the editor from `#md=`. */
export function markdownShareUrl(markdown: string): string {
  const url = new URL(window.location.toString());
  url.hash = `#md=${encodeURIComponent(markdown)}`;
  return url.toString();
}

/**
 * Builds a shareable URL that seeds the editor from `#doc=` (the current
 * editor state serialized in the playground's compressed-JSON convention).
 */
export async function docShareUrl(editor: LexicalEditor): Promise<string> {
  const url = new URL(window.location.toString());
  url.hash = await docToHash(
    serializedDocumentFromEditorState(editor.getEditorState(), {
      source: 'MdastEditor',
    }),
  );
  return url.toString();
}

function readStoredMarkdown(storageKey: string): string | null {
  if (typeof window === 'undefined' || storageKey === '') {
    return null;
  }
  return window.localStorage.getItem(storageKey);
}

function $loadMarkdown(editor: LexicalEditor): void {
  const persistence = getExtensionDependencyFromEditor(
    editor,
    MarkdownPersistenceExtension,
  ).config;
  const hashDoc = readHashDocument();
  if (hashDoc !== null) {
    // A repro link outranks the persisted document. `#md=` seeds
    // synchronously; `#doc=` needs async decompression, so register()
    // fills the (empty) document in rather than flashing stored content.
    if (hashDoc.kind === 'markdown') {
      $convertFromMarkdownString(hashDoc.markdown);
    }
    return;
  }
  const stored = readStoredMarkdown(persistence.storageKey);
  $convertFromMarkdownString(stored ?? persistence.defaultMarkdown);
}

/**
 * Owns where the document comes from and where it goes:
 *
 * - Provides the editor's `$initialEditorState`: a `#md=` / `#doc=` repro
 *   link when present (see {@link HashDocument}), otherwise
 *   `localStorage[storageKey]`, falling back to `defaultMarkdown`.
 * - Persists the markdown output signal back to localStorage on every
 *   change — except while showing a repro link, so a shared document
 *   never clobbers locally persisted work.
 * - Registers {@link RESET_MARKDOWN_COMMAND} which clears the storage
 *   entry, drops the URL hash, resumes persistence, and re-imports the
 *   default markdown.
 */
export const MarkdownPersistenceExtension = defineExtension({
  $initialEditorState: $loadMarkdown,
  config: safeCast<MarkdownPersistenceConfig>({
    defaultMarkdown: '',
    storageKey: '',
  }),
  dependencies: [ClearEditorExtension, MdastEditorExtension],
  name: '@lexical/dev-mdast-editor-example/MarkdownPersistence',
  register(editor, {storageKey, defaultMarkdown}, state) {
    const {markdown} = state.getDependency(MdastEditorExtension).output;
    const hasStorage = typeof window !== 'undefined' && storageKey !== '';
    const hashDoc = readHashDocument();
    let suspendPersistence = hashDoc !== null;
    let disposed = false;

    // When a `#doc=` link fails to load, fall back to the normal document
    // source (localStorage, then the default) and resume persistence —
    // otherwise the editor is left empty, since the repro link suppressed
    // the stored document from seeding.
    const loadFallbackDocument = (): void => {
      suspendPersistence = false;
      const stored = readStoredMarkdown(storageKey);
      editor.update(() => {
        editor.dispatchCommand(CLEAR_EDITOR_COMMAND);
        $convertFromMarkdownString(stored ?? defaultMarkdown);
      });
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND);
    };

    const applyHashDocument = (doc: HashDocument): void => {
      suspendPersistence = true;
      if (doc.kind === 'markdown') {
        editor.update(() => {
          // Document replacement: CLEAR_EDITOR_COMMAND resets more than
          // the root's children — extensions holding document state
          // outside them hook it too (the footnote extension drops its
          // root slot). Dispatched inside the update so the clear and
          // the import land as one atomic change. (The `#doc=` path
          // below replaces the whole editor state, slots included, so
          // it needs no equivalent.)
          editor.dispatchCommand(CLEAR_EDITOR_COMMAND);
          $convertFromMarkdownString(doc.markdown);
        });
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND);
        return;
      }
      docFromHash(doc.hash)
        .then(parsed => {
          if (disposed) {
            return;
          }
          if (parsed === null) {
            loadFallbackDocument();
            return;
          }
          editor.setEditorState(
            editorStateFromSerializedDocument(editor, parsed),
          );
          editor.dispatchCommand(CLEAR_HISTORY_COMMAND);
        })
        // A malformed `#doc=` payload can reject anywhere in the chain
        // (base64 decode, gzip stream, JSON.parse, or an editor state
        // that fails to deserialize) — a shared link is user input, so
        // report it and load the fallback document instead of leaving
        // an unhandled rejection and an empty editor.
        .catch((error: unknown) => {
          console.error(
            'Failed to load the #doc= document from the URL',
            error,
          );
          if (!disposed) {
            loadFallbackDocument();
          }
        });
    };

    // The `#md=` case was already seeded synchronously by
    // $initialEditorState; `#doc=` needs the async decompression here.
    if (hashDoc !== null && hashDoc.kind === 'doc') {
      applyHashDocument(hashDoc);
    }
    let initial = true;
    return mergeRegister(
      () => {
        disposed = true;
      },
      // Pasting a repro link into an already-open tab is a same-document
      // navigation — no reload — so watch for it. Share/Reset rewrite the
      // hash via history.replaceState, which does not fire hashchange, so
      // the editor's own actions never loop through this.
      typeof window === 'undefined'
        ? () => {}
        : registerEventListener(window, 'hashchange', () => {
            const doc = readHashDocument();
            if (doc !== null) {
              applyHashDocument(doc);
            }
          }),
      effect(() => {
        const value = markdown.value;
        if (initial) {
          initial = false;
          return;
        }
        if (hasStorage && !suspendPersistence) {
          window.localStorage.setItem(storageKey, value);
        }
      }),
      editor.registerCommand(
        RESET_MARKDOWN_COMMAND,
        () => {
          if (typeof window !== 'undefined' && window.location.hash !== '') {
            window.history.replaceState(
              {},
              '',
              window.location.pathname + window.location.search,
            );
          }
          suspendPersistence = false;
          if (hasStorage) {
            window.localStorage.removeItem(storageKey);
          }
          // Document replacement, like the repro-link path above.
          editor.dispatchCommand(CLEAR_EDITOR_COMMAND);
          $convertFromMarkdownString(defaultMarkdown);
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  },
});
