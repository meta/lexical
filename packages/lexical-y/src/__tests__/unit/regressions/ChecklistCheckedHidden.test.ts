/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A check-list item a client checked, joined with the next item while a
// collaborator turned the list into a numbered list, then indented, kept its
// checked value hidden on that client: ListItemNode's transform, which
// clears it outside a check list, never fired
// (https://github.com/meta/lexical/issues/9820). That client then stored the
// item unchecked while still holding it checked; once the list was a check
// list again, its editor showed the item checked and its document did not
// (the remote self-check: "listitem checked: editor true != shared false").
// delivered causally):
//
// round 0: C turns the list into a check list and checks the first item;
//   B types in the second.
// round 1: C presses Enter in a paragraph.
// round 2: C deletes forward at the end of the checked item (joining the
//   two) while B turns the list into a numbered list; C indents the joined
//   item and types at its start; B indents.
// round 3: A turns the list back into a check list; C deletes forward in a
//   paragraph and adds a comment.

import {describe, expect, test} from 'vitest';

import {runScript, type Script} from '../../utils/fuzz';

const SCRIPT: Script = {
  fd: 0.46023823763243854,
  final: 'causal',
  ids: [2, 1, 3],
  rounds: [
    {
      d: 0.11326147615909576,
      mode: 'causal',
      ops: [
        {
          id: 8,
          k: 'ltype',
          p: 2,
          r: [
            0.09511681599542499, 0.701608925126493, 0.7761099908966571,
            0.04711447795853019, 0.7759899937082082, 0.3971928951796144,
          ],
        },
        {
          id: 9,
          k: 'type',
          p: 1,
          r: [
            0.26785568334162235, 0.22417774936184287, 0.08412919216789305,
            0.5416263605002314, 0.7664212104864419, 0.5980585056822747,
          ],
        },
        {
          id: 10,
          k: 'check',
          p: 2,
          r: [
            0.4253558903001249, 0.9511308092623949, 0.6358324058819562,
            0.7371639756020159, 0.7006399387028068, 0.6785349233541638,
          ],
        },
      ],
    },
    {
      d: 0.5658352728933096,
      mode: 'causal',
      ops: [
        {
          id: 16,
          k: 'enter',
          p: 2,
          r: [
            0.3106732969172299, 0.2698216191492975, 0.9296917233150452,
            0.7941958636511117, 0.6593191085848957, 0.7989864363335073,
          ],
        },
      ],
    },
    {
      d: 0.1689943408127874,
      mode: 'causal',
      ops: [
        {
          id: 20,
          k: 'delfwd',
          p: 2,
          r: [
            0.38755709817633033, 0.47265690728090703, 0.34667409397661686,
            0.9973442608024925, 0.322417498100549, 0.10953367897309363,
          ],
        },
        {
          id: 22,
          k: 'ltype',
          p: 1,
          r: [
            0.00836629280820489, 0.5509593249298632, 0.7353294622153044,
            0.16820075386203825, 0.5218201004900038, 0.5245190116111189,
          ],
        },
        {
          id: 24,
          k: 'indent',
          p: 2,
          r: [
            0.8950219822581857, 0.25254747876897454, 0.06783026549965143,
            0.9652791360858828, 0.023412398993968964, 0.07082409621216357,
          ],
        },
        {
          id: 26,
          k: 'type',
          p: 2,
          r: [
            0.20448113232851028, 0.23837511497549713, 0.3988575995899737,
            0.33002506545744836, 0.32880867808125913, 0.7648678936529905,
          ],
        },
        {
          id: 27,
          k: 'indent',
          p: 1,
          r: [
            0.9546815867070109, 0.5740668908692896, 0.7137492969632149,
            0.8238518084399402, 0.539188606897369, 0.2219534683972597,
          ],
        },
      ],
    },
    {
      d: 0.3375648446381092,
      mode: 'causal',
      ops: [
        {
          id: 32,
          k: 'ltype',
          p: 0,
          r: [
            0.5574650834314525, 0.8845740978140384, 0.31820157426409423,
            0.8974302287679166, 0.800101712346077, 0.8004845732357353,
          ],
        },
        {
          id: 33,
          k: 'delfwd',
          p: 2,
          r: [
            0.2985410389956087, 0.03261416684836149, 0.9966746722348034,
            0.16163634066469967, 0.3811659950297326, 0.7154162337537855,
          ],
        },
        {
          id: 34,
          k: 'cAdd',
          p: 2,
          r: [
            0.13059464655816555, 0.7746783301699907, 0.8964947846252471,
            0.7262169099412858, 0.017171207815408707, 0.3968767432961613,
          ],
        },
      ],
    },
  ],
  seed: 200318036,
};

describe.each([false, true])(
  'a check-list item joined while the list became numbered, gc %s',
  gc => {
    test.fails('its editor and its document agree on checked', () => {
      const prevGc = process.env.FUZZ_GC;
      const prevSeeded = process.env.FUZZ_SEEDED;
      process.env.FUZZ_GC = gc ? '1' : '';
      process.env.FUZZ_SEEDED = '1';
      try {
        const result = runScript(SCRIPT);
        expect(result.failures.map(f => f.sig)).toEqual([]);
      } finally {
        process.env.FUZZ_GC = prevGc;
        process.env.FUZZ_SEEDED = prevSeeded;
      }
    });
  },
);
