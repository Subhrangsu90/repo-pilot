import { annotate, commentableLines, parsePatch } from './pulls';

const PATCH = [
  '@@ -10,3 +10,4 @@ export class Auth {',
  ' keep()',
  '-old()',
  '+added()',
  '+more()',
  '\\ No newline at end of file',
  ' tail()',
].join('\n');

describe('parsePatch', () => {
  it('numbers old and new lines from the hunk header and drops no-newline markers', () => {
    expect(parsePatch(PATCH)).toEqual([
      { kind: 'hunk', text: '@@ -10,3 +10,4 @@ export class Auth {' },
      { kind: 'ctx', old: 10, new: 10, text: 'keep()' },
      { kind: 'del', old: 11, text: 'old()' },
      { kind: 'add', new: 11, text: 'added()' },
      { kind: 'add', new: 12, text: 'more()' },
      { kind: 'ctx', old: 12, new: 13, text: 'tail()' },
    ]);
  });

  it('lets comments point at added and unchanged lines only', () => {
    expect([...commentableLines(parsePatch(PATCH))]).toEqual([10, 11, 12, 13]);
  });

  it('shows the model each line with its new-file number', () => {
    expect(annotate(parsePatch(PATCH)).split('\n').slice(1, 4)).toEqual(['    10| keep()', '-     | old()', '+   11| added()']);
  });
});
