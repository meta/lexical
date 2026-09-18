/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  EditorModeAnnounceExtension,
  FocusManagerExtension,
  FocusTrapExtension,
  HistoryAnnounceExtension,
  RovingTabIndexExtension,
} from '@lexical/a11y';
import {$isCodeNode} from '@lexical/code';
import {
  $defaultShouldInsertAfter,
  AutoFocusExtension,
  ClearEditorExtension,
  ClickAfterLastBlockExtension,
  DecoratorTextExtension,
  HorizontalRuleExtension,
  SelectBlockExtension,
  SelectionAlwaysOnDisplayExtension,
  TabIndentationExtension,
  WatchEditableExtension,
} from '@lexical/extension';
import {HashtagExtension} from '@lexical/hashtag';
import {HistoryExtension} from '@lexical/history';
import {
  $createLinkNode,
  ClickableLinkExtension,
  LinkExtension,
} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  CheckListExtension,
  ListExtension,
} from '@lexical/list';
import {PlainTextExtension} from '@lexical/plain-text';
import {LexicalCollaboration} from '@lexical/react/LexicalCollaborationContext';
import {
  CollaborationPlugin,
  CollaborationPluginV2__EXPERIMENTAL,
} from '@lexical/react/LexicalCollaborationPlugin';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {Analytics} from '@vercel/analytics/react';
import {SpeedInsights} from '@vercel/speed-insights/react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
} from 'lexical';
import {type JSX, useMemo} from 'react';
import {Doc} from 'yjs';

import {isDevPlayground} from './appSettings';
import {
  createWebsocketProvider,
  createWebsocketProviderWithDoc,
  skipCollaborationInit,
} from './collaboration';
import {FlashMessageContext} from './context/FlashMessageContext';
import {SettingsContext, useSettings} from './context/SettingsContext';
import {ToolbarContext} from './context/ToolbarContext';
import Editor from './Editor';
import {registerSettingsSynchronization} from './hooks/useSynchronizeSettings';
import {KeywordsExtension} from './nodes/KeywordNode';
import {PlaygroundImportExtension} from './nodes/PlaygroundImportExtension';
import PlaygroundNodes from './nodes/PlaygroundNodes';
import {PlaygroundDOMRenderExtension} from './PlaygroundDOMRenderExtension';
import {AutocompleteExtension} from './plugins/AutocompleteExtension';
import {PlaygroundAutoLinkExtension} from './plugins/AutoLinkExtension';
import {CardExtension} from './plugins/CardExtension';
import {CodeHighlightExtension} from './plugins/CodeHighlightExtension';
import {CollapsibleExtension} from './plugins/CollapsibleExtension';
import {DateTimeExtension} from './plugins/DateTimeExtension';
import DocsPlugin from './plugins/DocsPlugin';
import {DragDropPasteExtension} from './plugins/DragDropPasteExtension';
import {EmojisExtension} from './plugins/EmojisExtension';
import {EquationsExtension} from './plugins/EquationsExtension';
import {ExcalidrawExtension} from './plugins/ExcalidrawExtension';
import {FigmaExtension} from './plugins/FigmaExtension';
import {ReactFindReplaceExtension} from './plugins/FindReplaceExtension';
import {ImagesExtension} from './plugins/ImagesExtension';
import {LayoutExtension} from './plugins/LayoutExtension/LayoutExtension';
import {PlaygroundMarkdownShortcutsExtension} from './plugins/MarkdownShortcutsExtension';
import {MaxLengthExtension} from './plugins/MaxLengthPlugin';
import {MentionsExtension} from './plugins/MentionsExtension';
import {PageBreakExtension} from './plugins/PageBreakExtension';
import {PagesReactExtension} from './plugins/PagesReactExtension';
import PasteLogPlugin from './plugins/PasteLogPlugin';
import {PollExtension} from './plugins/PollExtension';
import {PullQuoteExtension} from './plugins/PullQuoteExtension';
import {ReactReviewExtension} from './plugins/ReviewExtension';
import {RubyExtension} from './plugins/RubyExtension';
import {ShortcutsExtension} from './plugins/ShortcutsExtension';
import {SpecialTextExtension} from './plugins/SpecialTextExtension';
import {TabFocusExtension} from './plugins/TabFocusExtension';
import {TerseExportExtension} from './plugins/TerseExportExtension';
import TestRecorderPlugin from './plugins/TestRecorderPlugin';
import {TwitterExtension} from './plugins/TwitterExtension';
import TypingPerfPlugin from './plugins/TypingPerfPlugin';
import {VersionsPlugin} from './plugins/VersionsPlugin';
import {VisibleNonPrintingExtension} from './plugins/VisibleNonPrintingExtension';
import {YouTubeExtension} from './plugins/YouTubeExtension';
import Settings from './Settings';
import PlaygroundEditorTheme from './themes/PlaygroundEditorTheme';
import ShadowDomWrapper from './ui/ShadowDomWrapper';
import {validateUrl} from './utils/url';

console.warn(
  'If you are profiling the playground app, please ensure you turn off the debug view. You can disable it by pressing on the settings control in the bottom-left of your screen and toggling the debug view setting.',
);

const COLLAB_DOC_ID = 'main';

function $prepopulatedRichText() {
  const root = $getRoot();
  if (root.getFirstChild() === null) {
    const heading = $createHeadingNode('h1');
    heading.append($createTextNode('Welcome to the playground'));
    root.append(heading);
    const quote = $createQuoteNode();
    quote.append(
      $createTextNode(
        `In case you were wondering what the black box at the bottom is – it's the debug view, showing the current state of the editor. ` +
          `You can disable it by pressing on the settings control in the bottom-left of your screen and toggling the debug view setting.`,
      ),
    );
    root.append(quote);
    const paragraph = $createParagraphNode();
    paragraph.append(
      $createTextNode('The playground is a demo environment built with '),
      $createTextNode('@lexical/react').toggleFormat('code'),
      $createTextNode('.'),
      $createTextNode(' Try typing in '),
      $createTextNode('some text').toggleFormat('bold'),
      $createTextNode(' with '),
      $createTextNode('different').toggleFormat('italic'),
      $createTextNode(' formats.'),
    );
    root.append(paragraph);
    const paragraph2 = $createParagraphNode();
    paragraph2.append(
      $createTextNode(
        'Make sure to check out the various plugins in the toolbar. You can also use #hashtags or @-mentions too!',
      ),
    );
    root.append(paragraph2);
    const paragraph3 = $createParagraphNode();
    paragraph3.append(
      $createTextNode(`If you'd like to find out more about Lexical, you can:`),
    );
    root.append(paragraph3);
    const list = $createListNode('bullet');
    list.append(
      $createListItemNode().append(
        $createTextNode(`Visit the `),
        $createLinkNode('https://lexical.dev/').append(
          $createTextNode('Lexical website'),
        ),
        $createTextNode(` for documentation and more information.`),
      ),
      $createListItemNode().append(
        $createTextNode(`Check out the code on our `),
        $createLinkNode('https://github.com/facebook/lexical').append(
          $createTextNode('GitHub repository'),
        ),
        $createTextNode(`.`),
      ),
      $createListItemNode().append(
        $createTextNode(`Playground code can be found `),
        $createLinkNode(
          'https://github.com/facebook/lexical/tree/main/packages/lexical-playground',
        ).append($createTextNode('here')),
        $createTextNode(`.`),
      ),
      $createListItemNode().append(
        $createTextNode(`Join our `),
        $createLinkNode('https://discord.com/invite/KmG4wQnnD9').append(
          $createTextNode('Discord Server'),
        ),
        $createTextNode(` and chat with the team.`),
      ),
    );
    root.append(list);
    const paragraph4 = $createParagraphNode();
    paragraph4.append(
      $createTextNode(
        `Lastly, we're constantly adding cool new features to this playground. So make sure you check back here when you next get a chance :).`,
      ),
    );
    root.append(paragraph4);
  }
}

// These are only enabled for rich-text mode
const PlaygroundRichTextExtension = defineExtension({
  dependencies: [
    configExtension(RichTextExtension, {
      escapeFormatTriggers: {
        code: {arrow: true, click: true, enter: true, onlyAtBoundary: true},
      },
    }),
    // Each node extension below registers its own DOM-import rules — the
    // framework nodes (rich-text, list, table, code) and the playground block
    // hosts (Card, PullQuote, Review) alike — so the rich-text importer set
    // tracks this node set automatically (kept out of the always-on
    // PlaygroundImportExtension so plain-text mode doesn't pull in
    // RichTextExtension, which conflicts with PlainTextExtension).
    configExtension(TableExtension, {
      hasStickyScrollbar: true,
    }),
    ImagesExtension,
    HorizontalRuleExtension,
    PageBreakExtension,
    TwitterExtension,
    YouTubeExtension,
    FigmaExtension,
    TabFocusExtension,
    CollapsibleExtension,
    CodeHighlightExtension,
    configExtension(ListExtension, {
      shouldPreserveNumbering: false,
    }),
    CheckListExtension,
    PlaygroundMarkdownShortcutsExtension,
    PageBreakExtension,
    PagesReactExtension,
    PollExtension,
    EquationsExtension,
    LayoutExtension,
    ExcalidrawExtension,
    CardExtension,
    ReactReviewExtension,
    ReactFindReplaceExtension,
    PullQuoteExtension,
    RubyExtension,
    ShortcutsExtension,
    configExtension(TabIndentationExtension, {maxIndent: 7}),
  ],
  name: '@lexical/playground/RichText',
});

const AppExtension = defineExtension({
  dependencies: [
    AutoFocusExtension,
    ClearEditorExtension,
    DecoratorTextExtension,
    // Exposes editor.isEditable() as a signal; consumed by
    // registerSettingsSynchronization to drive ClickableLinkExtension.
    WatchEditableExtension,
    HistoryExtension,
    HistoryAnnounceExtension,
    EditorModeAnnounceExtension,
    KeywordsExtension,
    HashtagExtension,
    DateTimeExtension,
    MaxLengthExtension,
    SpecialTextExtension,
    DragDropPasteExtension,
    EmojisExtension,
    MentionsExtension,
    configExtension(LinkExtension, {validateUrl}),
    PlaygroundAutoLinkExtension,
    configExtension(ClickableLinkExtension, {newTab: true}),
    SelectionAlwaysOnDisplayExtension,
    configExtension(SelectBlockExtension, {
      cascadeSelection: true,
    }),
    TerseExportExtension,
    configExtension(ClickAfterLastBlockExtension, {
      $shouldInsertAfter: node =>
        $defaultShouldInsertAfter(node) || $isCodeNode(node),
    }),
    configExtension(AutocompleteExtension, {disabled: true}),
    configExtension(VisibleNonPrintingExtension, {
      disabled: true,
    }),
    // DOMImportExtension pipeline — `PlaygroundImportExtension` bundles
    // the shared `CoreImportExtension` baseline, the playground-specific
    // inline-style overlay and the `ClipboardDOMImportExtension` paste
    // handler. Per-node import rules ride along with each node extension.
    PlaygroundImportExtension,
    // Replaces the legacy `buildHTMLConfig().export` overrides.
    PlaygroundDOMRenderExtension,
    FocusTrapExtension,
    RovingTabIndexExtension,
    FocusManagerExtension,
  ],
  name: '@lexical/playground',
  namespace: 'Playground',
  nodes: PlaygroundNodes,
  theme: PlaygroundEditorTheme,
});

/**
 * The *only* settings that require tearing down and rebuilding the editor,
 * because they change the set of extensions in use (and therefore the initial
 * editor state). Building a dynamic extension from settings at all is an
 * anti-pattern — extensions should be as static as possible — and is tolerated
 * here only because the playground builds fundamentally different editors from
 * the query string.
 *
 * IMPORTANT: Do NOT add a setting here unless changing it genuinely requires a
 * different extension graph. Anything a live editor can react to through an
 * extension's config signals — table behavior toggles, link attributes,
 * character limits, autocomplete, etc. — MUST instead be synced with
 * `useSyncExtensionSignal` in `Editor.tsx`. Adding such a setting here forces a
 * full editor rebuild (discarding content, selection, and history) on every
 * toggle, which is exactly the bug that moving the table settings out of here
 * fixed.
 */
interface DynamicSettings {
  isCollab: boolean;
  emptyEditor: boolean;
  isRichText: boolean;
}

function buildExtensionFromSettings(settings: DynamicSettings) {
  const {isCollab, emptyEditor, isRichText} = settings;
  return defineExtension({
    $initialEditorState: isCollab
      ? null
      : emptyEditor
        ? undefined
        : $prepopulatedRichText,
    dependencies: [
      AppExtension,
      /* @__PURE__ */ configExtension(HistoryExtension, {disabled: isCollab}),
      isRichText ? PlaygroundRichTextExtension : PlainTextExtension,
    ],
    name: '@lexical/playground/dynamic-config',
    // Apply INITIAL_SETTINGS to the extension config signals synchronously as
    // the editor is built (and wire the editable→clickable-link signal),
    // before the React useSynchronizeSettings effect takes over live updates.
    register: registerSettingsSynchronization,
  });
}

function App(): JSX.Element {
  const {
    settings: {
      isCollab,
      useCollabV2,
      emptyEditor,
      isRichText,
      isShadowDOM,
      measureTypingPerf,
    },
  } = useSettings();

  // Only the editor-recreating settings belong in this memo's deps. Table
  // behavior toggles (and other live-reconfigurable settings) are applied
  // reactively in Editor.tsx via useSyncExtensionSignal, so they must NOT
  // appear here or they would rebuild the whole editor on every change.
  const app = useMemo(
    () => buildExtensionFromSettings({emptyEditor, isCollab, isRichText}),
    [emptyEditor, isCollab, isRichText],
  );

  return (
    <LexicalCollaboration>
      <LexicalExtensionComposer extension={app} contentEditable={null}>
        <ToolbarContext>
          <header>
            <a href="https://lexical.dev" target="_blank" rel="noreferrer">
              <span className="logo" role="img" aria-label="Lexical Logo" />
            </a>
          </header>
          {isRichText && isCollab ? (
            useCollabV2 ? (
              <CollabV2
                id={COLLAB_DOC_ID}
                shouldBootstrap={!skipCollaborationInit}
              />
            ) : (
              <CollaborationPlugin
                id={COLLAB_DOC_ID}
                providerFactory={createWebsocketProvider}
                shouldBootstrap={!skipCollaborationInit}
                selectionHighlight={true}
              />
            )
          ) : null}
          {isShadowDOM ? (
            <ShadowDomWrapper>
              <div className="editor-shell">
                <Editor />
              </div>
            </ShadowDomWrapper>
          ) : (
            <div className="editor-shell">
              <Editor />
            </div>
          )}
          <Settings />
          {isDevPlayground ? <DocsPlugin /> : null}
          {isDevPlayground ? <PasteLogPlugin /> : null}
          {isDevPlayground ? <TestRecorderPlugin /> : null}

          {measureTypingPerf ? <TypingPerfPlugin /> : null}
        </ToolbarContext>
      </LexicalExtensionComposer>
    </LexicalCollaboration>
  );
}

function CollabV2({
  id,
  shouldBootstrap,
}: {
  id: string;
  shouldBootstrap: boolean;
}) {
  // VersionsPlugin needs GC disabled.
  const doc = useMemo(() => new Doc({gc: false}), []);

  const provider = useMemo(() => {
    return createWebsocketProviderWithDoc('main', doc);
  }, [doc]);

  return (
    <>
      <CollaborationPluginV2__EXPERIMENTAL
        id={id}
        doc={doc}
        provider={provider}
        __shouldBootstrapUnsafe={shouldBootstrap}
        selectionHighlight={true}
      />
      <VersionsPlugin id={id} />
    </>
  );
}

export default function PlaygroundApp(): JSX.Element {
  return (
    <SettingsContext>
      <FlashMessageContext>
        <App />
      </FlashMessageContext>
      <a
        href="https://github.com/facebook/lexical/tree/main/packages/lexical-playground"
        className="github-corner"
        aria-label="View source on GitHub">
        <svg
          width="80"
          height="80"
          viewBox="0 0 250 250"
          style={{
            border: '0',
            color: '#eee',
            fill: '#222',
            left: '0',
            position: 'absolute',
            top: '0',
            transform: 'scale(-1,1)',
          }}
          aria-hidden="true">
          <path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z" />
          <path
            d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2"
            fill="currentColor"
            style={{
              transformOrigin: '130px 106px',
            }}
            className="octo-arm"
          />
          <path
            d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z"
            fill="currentColor"
            className="octo-body"
          />
        </svg>
      </a>
      <Analytics />
      <SpeedInsights />
    </SettingsContext>
  );
}
