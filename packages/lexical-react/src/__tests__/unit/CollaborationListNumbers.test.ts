/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A peer applies a remote list edit without the list's transforms, so the
// numbers it draws come only from the items it reconciles. Each case from
// the list's drawn-number tests is made on one client and checked on the
// other: the number the browser draws for every item (its `value`, else the
// list's count) must be the item's own, after the edit, its undo and its redo.

import {ListItemNode, ListNode} from '@lexical/list';
import {$createTextNode, $getRoot, REDO_COMMAND, UNDO_COMMAND} from 'lexical';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  $item,
  $wrapperList,
  drawnAndModel,
  LIST_EDIT_CASES,
} from '../../../../lexical-list/src/__tests__/unit/listEditCases';
import {
  connectClients,
  createTestConnection,
  disconnectClients,
  waitForReact,
} from '../utils';

describe.each([[false], [true]])(
  'Collaboration list numbers (useCollabV2: %s)',
  (useCollabV2: boolean) => {
    let container: HTMLDivElement | null = null;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      document.body.removeChild(container!);
      container = null;
    });

    it.each(LIST_EDIT_CASES.map(c => [c.name, c] as const))(
      '%s: the peer draws every item’s own number',
      async (_name, c) => {
        const connector = createTestConnection(useCollabV2);
        const client1 = connector.createClient('1');
        const client2 = connector.createClient('2');
        const nodes = [ListNode, ListItemNode];
        client1.start(container!, undefined, {nodes});
        client2.start(container!, undefined, {nodes});
        await Promise.resolve().then();

        const check = (label: string) => {
          const local = drawnAndModel(client1.getEditor());
          const peer = drawnAndModel(client2.getEditor());
          expect(peer.model, `${label}: peer has the same numbers`).toEqual(
            local.model,
          );
          expect(peer.drawn, `${label}: peer draws them`).toEqual(peer.model);
          expect(local.drawn, `${label}: local draws them`).toEqual(
            local.model,
          );
        };

        await waitForReact(() => {
          client1.update(() => {
            const root = $getRoot();
            root.clear();
            root.append(...c.$build());
          });
        });
        check('built');

        await waitForReact(() => {
          client1.update(c.$edit);
        });
        check('edited');

        await waitForReact(() => {
          client1.getEditor().dispatchCommand(UNDO_COMMAND, undefined);
        });
        check('undone');

        await waitForReact(() => {
          client1.getEditor().dispatchCommand(REDO_COMMAND, undefined);
        });
        check('redone');

        client1.stop();
        client2.stop();
      },
    );

    it('concurrent edits on both clients (insert above a wrapper, remove the first item): both draw their own numbers', async () => {
      const connector = createTestConnection(useCollabV2);
      const client1 = connector.createClient('1');
      const client2 = connector.createClient('2');
      const nodes = [ListNode, ListItemNode];
      client1.start(container!, undefined, {nodes});
      client2.start(container!, undefined, {nodes});
      await Promise.resolve().then();
      await waitForReact(() => {
        client1.update(() => {
          $getRoot().clear().append($wrapperList());
        });
      });
      disconnectClients([client1, client2]);
      await waitForReact(() => {
        client1.update(() => {
          const list = $getRoot().getFirstChildOrThrow() as ListNode;
          list.getFirstChildOrThrow().insertAfter($item('b'));
        });
        client2.update(() => {
          const list = $getRoot().getFirstChildOrThrow() as ListNode;
          list.getFirstChildOrThrow().remove();
        });
      });
      await waitForReact(() => {
        connectClients([client1, client2]);
      });
      for (const client of [client1, client2]) {
        const {drawn, model} = drawnAndModel(client.getEditor());
        // Asserts only that each client draws its own model's numbers: merged
        // values applied without the list's transforms can differ from the
        // items' positions, which this change does not touch.
        expect(drawn, `client ${client._id} draws its own numbers`).toEqual(
          model,
        );
      }
      expect(drawnAndModel(client2.getEditor()).model).toEqual(
        drawnAndModel(client1.getEditor()).model,
      );
      client1.stop();
      client2.stop();
    });

    it('a remote renumber while the peer has its own dirty item in the same list', async () => {
      const connector = createTestConnection(useCollabV2);
      const client1 = connector.createClient('1');
      const client2 = connector.createClient('2');
      const nodes = [ListNode, ListItemNode];
      client1.start(container!, undefined, {nodes});
      client2.start(container!, undefined, {nodes});
      await Promise.resolve().then();
      await waitForReact(() => {
        client1.update(() => {
          $getRoot()
            .clear()
            .append(LIST_EDIT_CASES[0].$build()[0] as ListNode);
        });
      });
      await waitForReact(() => {
        // The peer edits its last item while the bot's edit arrives.
        client2.update(() => {
          const list = $getRoot().getFirstChildOrThrow() as ListNode;
          (list.getLastChildOrThrow() as ListItemNode).append(
            $createTextNode('!'),
          );
        });
        client1.update(LIST_EDIT_CASES[0].$edit);
      });
      for (const client of [client1, client2]) {
        const {drawn, model} = drawnAndModel(client.getEditor());
        expect(drawn, `client ${client._id} draws its own numbers`).toEqual(
          model,
        );
      }
      client1.stop();
      client2.stop();
    });
  },
);
