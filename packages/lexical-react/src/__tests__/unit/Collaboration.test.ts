/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isParagraphNode,
  $isTextNode,
  $setState,
  createState,
  ParagraphNode,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {act} from 'react';
import {afterEach, assert, beforeEach, describe, expect, it, vi} from 'vitest';
import * as Y from 'yjs';

import {
  type Client,
  createTestConnection,
  type TestConnection,
  waitForReact,
} from '../utils';

const state = createState('foo', {
  parse: value => (value ? (value as string) : undefined),
});

describe('Collaboration', () => {
  let container: null | HTMLDivElement = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;
  });

  async function expectCorrectInitialContent(client1: Client, client2: Client) {
    // Should be empty, as client has not yet updated
    expect(client1.getHTML()).toEqual('');
    expect(client1.getHTML()).toEqual(client2.getHTML());

    // Wait for clients to render the initial content
    await Promise.resolve().then();

    expect(client1.getHTML()).toEqual(
      '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
    );
    expect(client1.getHTML()).toEqual(client2.getHTML());
    expect(client1.getDocJSON()).toEqual(client2.getDocJSON());
  }

  describe.each([[false], [true]])(
    'useCollabV2: %s',
    (useCollabV2: boolean) => {
      it('Should collaborate basic text insertion between two clients', async () => {
        const connector = createTestConnection(useCollabV2);

        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');

        client1.start(container!);
        client2.start(container!);

        await expectCorrectInitialContent(client1, client2);

        // Insert a text node on client 1
        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );

            const text = $createTextNode('Hello world');

            paragraph.append(text);
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        // Insert some text on client 2
        await waitForReact(() => {
          client2.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );
            const text = $assertNodeType(
              paragraph.getFirstChild(),
              $isTextNode,
            );

            text.spliceText(6, 5, 'metaverse');
          });
        });

        expect(client2.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello metaverse</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        client1.stop();
        client2.stop();
      });

      it('Should collaborate basic text insertion conflicts between two clients', async () => {
        const connector = createTestConnection(useCollabV2);

        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');

        client1.start(container!);
        client2.start(container!);

        await expectCorrectInitialContent(client1, client2);

        client1.disconnect();

        // Insert some a text node on client 1
        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );
            const text = $createTextNode('Hello world');

            paragraph.append(text);
          });
        });
        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
        );
        expect(client2.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
        );

        // Insert some a text node on client 1
        await waitForReact(() => {
          client2.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );
            const text = $createTextNode('Hello world');

            paragraph.append(text);
          });
        });

        expect(client2.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());

        await waitForReact(() => {
          client1.connect();
        });

        // Text content should be repeated, but there should only be a single node
        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello worldHello world</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        client2.disconnect();

        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );
            const text = $assertNodeType(
              paragraph.getFirstChild(),
              $isTextNode,
            );

            text.spliceText(11, 11, '');
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
        );
        expect(client2.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello worldHello world</span></p>',
        );

        await waitForReact(() => {
          client2.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );
            const text = $assertNodeType(
              paragraph.getFirstChild(),
              $isTextNode,
            );

            text.spliceText(11, 11, '!');
          });
        });

        await waitForReact(() => {
          client2.connect();
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello world!</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        client1.stop();
        client2.stop();
      });

      it('Should collaborate basic text deletion conflicts between two clients', async () => {
        const connector = createTestConnection(useCollabV2);
        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');
        client1.start(container!);
        client2.start(container!);

        await expectCorrectInitialContent(client1, client2);

        // Insert some a text node on client 1
        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );
            const text = $createTextNode('Hello world');
            paragraph.append(text);
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        client1.disconnect();

        // Delete the text on client 1
        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );
            paragraph.getFirstChild()!.remove();
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
        );
        expect(client2.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
        );

        // Insert some text on client 2
        await waitForReact(() => {
          client2.update(() => {
            const root = $getRoot();

            const paragraph = $assertNodeType(
              root.getFirstChild(),
              $isParagraphNode,
            );

            $assertNodeType(paragraph.getFirstChild(), $isTextNode).spliceText(
              11,
              0,
              'Hello world',
            );
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
        );
        expect(client2.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello worldHello world</span></p>',
        );

        await waitForReact(() => {
          client1.connect();
        });

        if (useCollabV2) {
          expect(client1.getHTML()).toEqual(
            '<p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
          );
        } else {
          // TODO we can probably handle these conflicts better. We could keep around
          // a "fallback" {Map} when we remove text without any adjacent text nodes. This
          // would require big changes in `CollabElementNode.splice` and also need adjustments
          // in `CollabElementNode.applyChildrenYjsDelta` to handle the existence of these
          // fallback maps. For now though, if a user clears all text nodes from an element
          // and another user inserts some text into the same element at the same time, the
          // deletion will take precedence on conflicts.
          expect(client1.getHTML()).toEqual(
            '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
          );
        }
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());
        client1.stop();
        client2.stop();
      });

      it('Should sync direction of element node', async () => {
        const connector = createTestConnection(useCollabV2);
        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');
        client1.start(container!);
        client2.start(container!);

        await expectCorrectInitialContent(client1, client2);

        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot().clear();
            root.append(
              $createParagraphNode().append($createTextNode('hello')),
            );
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">hello</span></p>',
        );
        expect(client2.getHTML()).toEqual(client1.getHTML());

        // Override direction
        await waitForReact(() => {
          client1.update(() => {
            const paragraph = $assertNodeType(
              $getRoot().getFirstChild(),
              $isParagraphNode,
            );
            paragraph.setDirection('rtl');
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="rtl"><span data-lexical-text="true">hello</span></p>',
        );
        expect(client2.getHTML()).toEqual(client1.getHTML());

        client1.stop();
        client2.stop();
      });

      it('Should allow the passing of arbitrary awareness data', async () => {
        const connector = createTestConnection(useCollabV2);

        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');

        const awarenessData1 = {
          foo: 'foo',
          uuid: Math.floor(Math.random() * 10000),
        };
        const awarenessData2 = {
          bar: 'bar',
          uuid: Math.floor(Math.random() * 10000),
        };

        client1.start(container!, awarenessData1);
        client2.start(container!, awarenessData2);

        await expectCorrectInitialContent(client1, client2);

        expect(client1.awareness.getLocalState()!.awarenessData).toEqual(
          awarenessData1,
        );
        expect(client2.awareness.getLocalState()!.awarenessData).toEqual(
          awarenessData2,
        );

        client1.stop();
        client2.stop();
      });

      /**
       * When a document is not bootstrapped (via `shouldBootstrap`), the document only initializes the initial paragraph
       * node upon the first user interaction. Then, both a new paragraph as well as the user character are inserted as a
       * single Yjs change. However, when the user undos this initial change, the document now has no initial paragraph
       * node. syncYjsChangesToLexical addresses this by doing a check: `$getRoot().getChildrenSize() === 0)` and if true,
       * inserts the paragraph node. However, this insertion was previously being done in an editor.update block that had
       * either the tag 'collaboration' or 'historic'. Then, when `syncLexicalUpdateToYjs` was called, because one of these
       * tags were present, the function would early-return, and this change would not be synced to other clients, causing
       * permanent desync and corruption of the doc for both users. Not only was the change not syncing to other clients,
       * but even the initiating client was not notified via the proper callbacks, and the change would fall through from
       * persistence, causing permanent desync. The fix was to move the insertion of the paragraph node outside of the
       * editor.update block that included the 'collaboration' or 'historic' tag, and instead insert it in a separate
       * editor.update block that did not have these tags.
       */
      it('Should sync to other clients when inserting a new paragraph node when document is emptied via undo', async () => {
        const connector = createTestConnection(useCollabV2);

        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');

        client1.start(container!, undefined, {shouldBootstrapEditor: false});
        client2.start(container!, undefined, {shouldBootstrapEditor: false});

        expect(client1.getHTML()).toEqual('');
        expect(client1.getHTML()).toEqual(client2.getHTML());

        // Wait for clients to render the initial content
        await Promise.resolve().then();

        expect(client1.getHTML()).toEqual('');
        expect(client1.getHTML()).toEqual(client2.getHTML());

        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();

            // Since bootstrap is false, we create our own paragraph node
            const paragraph = $createParagraphNode();
            const text = $createTextNode('Hello');
            paragraph.append(text);

            root.append(paragraph);
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        await waitForReact(() => {
          // Undo the insertion of the initial paragraph and text node
          client1.getEditor().dispatchCommand(UNDO_COMMAND);
        });

        // We expect the safety check in syncYjsChangesToLexical to
        // insert a new paragraph node and prevent the document from being empty
        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();

            const paragraph = $createParagraphNode();
            const text = $createTextNode('Hello world');
            paragraph.append(text);

            root.append(paragraph);
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p><p dir="auto"><span data-lexical-text="true">Hello world</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        client1.stop();
        client2.stop();
      });

      /**
       * When a local editor directly clears all nodes while no other peer is live,
       * syncLexicalUpdateToYjs syncs the empty state to Yjs. The observeDeep callback
       * skips events originating from the local binding, so $ensureEditorNotEmpty never
       * runs via the existing Yjs→Lexical guard. The fix adds the same recovery to the
       * Lexical→Yjs direction so the paragraph is in the Yjs doc before any peer connects.
       *
       * Isolation: client2 is registered in the connector before the clear so all of
       * client1's updates (including the recovery paragraph) queue to client2 while it is
       * not yet started. When client2 cold-starts it applies those queued updates.
       * Without the fix the last queued update leaves the root empty and client2 loads
       * an empty document. With the fix the recovery paragraph is present and client2
       * loads correctly — the assertion on client2's HTML is the regression guard.
       */
      it('Should sync recovered paragraph to a later-joining client after direct clear-all (#8086)', async () => {
        const connector = createTestConnection(useCollabV2);
        const client1 = connector.createClient('1');
        // Register client2 now so updates queue to it while client1 operates alone
        const client2 = connector.createClient('2');

        // Only client1 is active — no live peer to trigger the existing
        // Yjs→Lexical recovery guard and mask the missing Lexical→Yjs guard
        client1.start(container!);
        await Promise.resolve().then();
        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
        );

        await waitForReact(() => {
          client1.update(() => {
            const paragraph = $assertNodeType(
              $getRoot().getFirstChild(),
              $isParagraphNode,
            );
            paragraph.append($createTextNode('Hello'));
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">Hello</span></p>',
        );

        // Clear with no live peer — only syncLexicalUpdateToYjs (our fix) can
        // schedule the recovery; syncYjsChangesToLexical's existing guard cannot
        // fire because the observeDeep event is skipped for locally-originated changes
        await waitForReact(() => {
          client1.update(() => {
            $getRoot().clear();
          });
        });

        // client1's own Lexical view should recover (the fix schedules
        // $ensureEditorNotEmpty in a tag-free update that also syncs back to Yjs)
        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
        );

        // client2 cold-starts and applies all queued Yjs updates from client1.
        // Regression assertion: without the fix, client2 receives only the clear
        // and loads an empty document (getHTML() === ''). With the fix the recovery
        // paragraph is in the queue and client2 loads '<p dir="auto"><br></p>'.
        client2.start(container!);
        await Promise.resolve().then();

        expect(client2.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        // Subsequent edits must sync in both directions — the main desync symptom
        await waitForReact(() => {
          client1.update(() => {
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode('World'));
            $getRoot().append(paragraph);
          });
        });

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p><p dir="auto"><span data-lexical-text="true">World</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());
        expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

        client1.stop();
        client2.stop();
      });

      it('Should not grow a selection when a remote peer types at its right edge (#8608)', async () => {
        const connector = createTestConnection(useCollabV2);
        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');
        client1.start(container!);
        client2.start(container!);

        await expectCorrectInitialContent(client1, client2);

        // Client 1 inserts "foo bar".
        await waitForReact(() => {
          client1.update(() => {
            $getRoot().selectEnd().insertRawText('foo bar');
          });
        });
        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">foo bar</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());

        // Client 1 selects the whole word as a forward range (anchor 0 -> focus 7).
        await waitForReact(() => {
          client1.update(() => {
            const firstNode = $getRoot().getFirstDescendant();
            assert(
              $isTextNode(firstNode),
              'First descendant must be a TextNode',
            );
            expect(firstNode.getTextContent()).toBe('foo bar');
            firstNode.select(0);
          });
        });

        // The focus endpoint is stored in awareness as a Yjs relative position.
        // Capture it now, while the selection is still a live range and before any
        // remote edit arrives. The fix gives the right (focus) endpoint a left
        // association (assoc = -1) so it sticks to the last selected character
        // instead of drifting to the end of the XmlText.
        //
        // We assert on the relative position directly rather than on
        // $getSelection() afterwards because this two-editors-in-one-jsdom harness
        // shares a single global document selection, so a live RangeSelection does
        // not survive a remote round-trip here (which is also why no other test in
        // this file asserts on selection state).
        const focusPos = client1.awareness.getLocalState()!.focusPos!;
        expect(focusPos).not.toBeNull();
        expect(focusPos.assoc).toBe(-1);

        // Where does that focus position resolve to before the remote edit?
        const resolvedBefore = Y.createAbsolutePositionFromRelativePosition(
          focusPos,
          client1.getDoc(),
        )!;
        expect(resolvedBefore).not.toBeNull();

        // Client 2 types "ZZZ" immediately after the right edge of the selection.
        await waitForReact(() => {
          client2.update(() => {
            const firstNode = $getRoot().getFirstDescendant();
            assert(
              $isTextNode(firstNode),
              'First descendant must be a TextNode',
            );
            expect(firstNode.getTextContent()).toBe('foo bar');
            firstNode.select().insertRawText('ZZZ');
          });
        });

        // The edit itself propagates to both clients (document content is correct).
        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">foo barZZZ</span></p>',
        );
        expect(client1.getHTML()).toEqual(client2.getHTML());

        // Re-resolve the same focus position against the updated document. With the
        // fix it must not have moved (still at the end of "foo bar"); the pre-fix
        // behaviour drifted it right by the length of "ZZZ", swallowing the
        // remotely typed text into the selection (and therefore the clipboard).
        const resolvedAfter = Y.createAbsolutePositionFromRelativePosition(
          focusPos,
          client1.getDoc(),
        )!;
        expect(resolvedAfter).not.toBeNull();
        expect(resolvedAfter.index).toBe(resolvedBefore.index);

        client1.stop();
        client2.stop();
      });

      it('Should sync an update started by a mutation listener when another listener calls editor.read() (#7709)', async () => {
        const connector = createTestConnection(useCollabV2);
        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');
        client1.start(container!);
        client2.start(container!);

        await expectCorrectInitialContent(client1, client2);

        await waitForReact(() => {
          client1.update(() => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('hello')),
                $createParagraphNode().append($createTextNode('world')),
                $createParagraphNode().append($createTextNode('foo')),
              );
          });
        });

        const editor = client1.getEditor();
        editor.registerMutationListener(ParagraphNode, mutations => {
          if ([...mutations.values()].includes('destroyed')) {
            editor.update(() => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('bar')),
              );
            });
          }
        });
        editor.registerMutationListener(ParagraphNode, () => {
          // A force-commit read while the listeners of the commit that
          // started the update above are still being notified.
          editor.read(() => $getRoot());
        });

        // Silence the DEV warning for the read, see LexicalEditor.test.tsx.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          await waitForReact(() => {
            client1.update(() => {
              $getRoot().splice(1, 1, []);
            });
          });
        } finally {
          warnSpy.mockRestore();
        }

        expect(client1.getHTML()).toEqual(
          '<p dir="auto"><span data-lexical-text="true">hello</span></p>' +
            '<p dir="auto"><span data-lexical-text="true">foo</span></p>' +
            '<p dir="auto"><span data-lexical-text="true">bar</span></p>',
        );
        expect(client2.getHTML()).toEqual(client1.getHTML());
        expect(client2.getDocJSON()).toEqual(client1.getDocJSON());

        client1.stop();
        client2.stop();
      });
    },
  );

  it('Should handle multiple text nodes being normalized due to merge conflict', async () => {
    // Only applicable to Collab v1.
    const connector = createTestConnection(false);
    const client1 = connector.createClient('1');
    const client2 = connector.createClient('2');
    client1.start(container!);
    client2.start(container!);

    await expectCorrectInitialContent(client1, client2);

    client2.disconnect();

    // Add
    await waitForReact(() => {
      client1.getEditor().update(() => {
        const root = $getRoot();

        const paragraph = $assertNodeType(
          root.getFirstChild(),
          $isParagraphNode,
        );
        paragraph.append($createTextNode('1'));
      });
    });

    expect(client1.getHTML()).toEqual(
      '<p dir="auto"><span data-lexical-text="true">1</span></p>',
    );

    // Simulate normalization merge conflicts by inserting YMap+strings directly into Yjs.
    const yDoc = client1.getDoc();
    const rootXmlText = yDoc.get('root') as Y.XmlText;
    const paragraphXmlText = rootXmlText.toDelta()[0].insert as Y.XmlText;
    const textYMap = paragraphXmlText.toDelta()[0].insert as Y.Map<unknown>;
    yDoc.transact(() => {
      paragraphXmlText.insertEmbed(2, textYMap.clone());
      paragraphXmlText.insert(3, '2');
      paragraphXmlText.insertEmbed(4, textYMap.clone());
      paragraphXmlText.insert(5, '3');
    });

    // Note: client1 HTML won't have been updated yet here because we edited its Yjs doc directly.
    expect(client1.getHTML()).toEqual(
      '<p dir="auto"><span data-lexical-text="true">1</span></p>',
    );

    // When client2 reconnects, it will normalize the three text nodes, which syncs back to client1.
    await waitForReact(() => {
      client2.connect();
    });

    expect(client1.getHTML()).toEqual(
      '<p dir="auto"><span data-lexical-text="true">123</span></p>',
    );
    expect(client1.getHTML()).toEqual(client2.getHTML());
    expect(client1.getDocJSON()).toEqual(client2.getDocJSON());

    client1.stop();
    client2.stop();
  });

  describe('collab v2', () => {
    let connector: TestConnection;

    beforeEach(() => {
      connector = createTestConnection(true);
    });

    it('Should not sync state with object value if value is deep equal to previous value', async () => {
      const client = connector.createClient('1');
      client.start(container!);
      const editor = client.getEditor();

      act(() => {
        editor.update(
          () => {
            const root = $getRoot().clear();
            const paragraph = $createParagraphNode();
            const text = $createTextNode('Hello');
            $setState(paragraph, state, 'bar');
            paragraph.append(text);
            root.append(paragraph);
          },
          {discrete: true},
        );
      });

      const yDoc = client.getDoc();
      const paragraphYElement = yDoc
        .get('root-v2', Y.XmlElement)
        .toArray()[0] as Y.XmlElement;
      let updated = false;
      paragraphYElement.observe(() => (updated = true));

      editor.update(
        () => {
          const paragraph = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          $setState(paragraph, state, 'bar');
          // Include another update otherwise equalYTypePNode would return true
          paragraph.append($createTextNode('!'));
        },
        {discrete: true},
      );

      expect(updated).toBe(false);
    });

    it('Should sync the removal of node state from element nodes', async () => {
      const client1 = connector.createClient('1');
      const client2 = connector.createClient('2');
      client1.start(container!);
      client2.start(container!);

      await expectCorrectInitialContent(client1, client2);

      await waitForReact(() => {
        client1.update(() => {
          const root = $getRoot().clear();
          const paragraph = $createParagraphNode();
          $setState(paragraph, state, 'bar');
          root.append(paragraph);
        });
      });

      let editor2State = client2.getEditor().read('latest', () => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        return $getState(paragraph, state);
      });
      expect(editor2State).toEqual('bar');

      await waitForReact(() => {
        client1.update(() => {
          const paragraph = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          $setState(paragraph, state, undefined);
        });
      });

      editor2State = client2.getEditor().read('latest', () => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        return $getState(paragraph, state);
      });
      expect(editor2State).toBeUndefined();

      client1.stop();
      client2.stop();
    });
  });
});
