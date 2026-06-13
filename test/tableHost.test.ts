import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTableHost, TableData, TableHostDeps } from '../src/tableHost';
import { CHUNK_SIZE, HostMessage } from '../src/shared/protocol';

/** Lets all pending microtasks/timers settle (reload is fire-and-forget). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeData(rows: number, tag = '', colors: TableData['colors'] = null): TableData {
  return {
    fileName: `f${tag}`,
    columns: ['', 'a'],
    rows: Array.from({ length: rows }, (_, i) => [String(i), `v${tag}${i}`]),
    colors,
  };
}

/** Captures everything the host sends, with a controllable load(). */
function harness(load: TableHostDeps['load']) {
  const posts: HostMessage[] = [];
  const errors: string[] = [];
  const handle = createTableHost({
    load,
    post: (m) => posts.push(m),
    reportError: (m) => errors.push(m),
  });
  return { handle, posts, errors };
}

test('ready loads once and posts init with a 100-row sample', async () => {
  let loads = 0;
  const { handle, posts } = harness(async () => {
    loads++;
    return makeData(250);
  });

  handle({ type: 'ready' });
  await flush();

  assert.equal(loads, 1);
  const init = posts.find((m) => m.type === 'init');
  assert.ok(init && init.type === 'init');
  assert.equal(init.rowCount, 250);
  assert.equal(init.sample.length, 100);
  assert.deepEqual(init.columns, ['', 'a']);
});

test('init carries the truncation note when present', async () => {
  const { handle, posts } = harness(async () => ({ ...makeData(5), note: 'showing first 5' }));
  handle({ type: 'ready' });
  await flush();
  const init = posts.find((m) => m.type === 'init');
  assert.equal(init?.type === 'init' ? init.note : undefined, 'showing first 5');
});

test('rows requests before the first load are ignored', () => {
  const { handle, posts } = harness(async () => makeData(10));
  handle({ type: 'rows', chunk: 0 });
  assert.equal(posts.length, 0);
});

test('rows requests after init return the right chunk slice', async () => {
  const total = CHUNK_SIZE + 3;
  const { handle, posts } = harness(async () => makeData(total));
  handle({ type: 'ready' });
  await flush();
  posts.length = 0;

  handle({ type: 'rows', chunk: 0 });
  handle({ type: 'rows', chunk: 1 });

  const [first, second] = posts;
  assert.ok(first.type === 'rows' && second.type === 'rows');
  assert.equal(first.rows.length, CHUNK_SIZE);
  assert.deepEqual(first.rows[0], ['0', 'v0']);
  // The last chunk is the remainder past one full chunk.
  assert.equal(second.rows.length, 3);
  assert.deepEqual(second.rows[0], [String(CHUNK_SIZE), `v${CHUNK_SIZE}`]);
});

test('heatmap colors are sliced alongside rows', async () => {
  const total = CHUNK_SIZE + 2;
  const colors = Array.from({ length: total }, (_, i) => [null, i % 2 ? '#abcabc' : null]);
  const { handle, posts } = harness(async () => makeData(total, '', colors));

  handle({ type: 'ready' });
  await flush();
  const init = posts.find((m) => m.type === 'init');
  assert.ok(init?.type === 'init' && init.sampleColors);
  assert.deepEqual(init.sampleColors[1], [null, '#abcabc']);

  posts.length = 0;
  handle({ type: 'rows', chunk: 1 });
  const rows = posts.find((m) => m.type === 'rows');
  assert.ok(rows?.type === 'rows' && rows.colors);
  assert.equal(rows.colors.length, 2);
  assert.deepEqual(rows.colors[0], colors[CHUNK_SIZE]);
});

test('null colors (no heatmap) stay null through init and rows', async () => {
  const { handle, posts } = harness(async () => makeData(CHUNK_SIZE + 1));
  handle({ type: 'ready' });
  await flush();
  const init = posts.find((m) => m.type === 'init');
  assert.ok(init?.type === 'init' && init.sampleColors === null);

  posts.length = 0;
  handle({ type: 'rows', chunk: 0 });
  const rows = posts.find((m) => m.type === 'rows');
  assert.ok(rows?.type === 'rows' && rows.colors === null);
});

test('refresh reloads and posts a fresh init reflecting the new data', async () => {
  let call = 0;
  const { handle, posts } = harness(async () => (++call === 1 ? makeData(2, 'A') : makeData(3, 'B')));

  handle({ type: 'ready' });
  await flush();
  handle({ type: 'refresh' });
  await flush();

  const inits = posts.filter((m) => m.type === 'init');
  assert.equal(inits.length, 2);
  assert.equal(inits[0].type === 'init' && inits[0].rowCount, 2);
  assert.equal(inits[1].type === 'init' && inits[1].rowCount, 3);
});

test('a load failure reports the error and posts an error message, not init', async () => {
  const { handle, posts, errors } = harness(async () => {
    throw new Error('boom');
  });

  handle({ type: 'ready' });
  await flush();

  assert.deepEqual(errors, ['boom']);
  const err = posts.find((m) => m.type === 'error');
  assert.ok(err && err.type === 'error' && err.message === 'boom');
  assert.ok(!posts.some((m) => m.type === 'init'));
});

test('non-Error rejections are stringified', async () => {
  const { handle, errors } = harness(async () => {
    throw 'plain string failure';
  });
  handle({ type: 'ready' });
  await flush();
  assert.deepEqual(errors, ['plain string failure']);
});

test('forwards the colormap and center flag from ready/refresh to load', async () => {
  const seen: { colormap?: string; center?: boolean }[] = [];
  const handle = createTableHost({
    load: async (options) => {
      seen.push({ colormap: options.colormap, center: options.center });
      return makeData(1);
    },
    post: () => {},
    reportError: () => {},
  });

  handle({ type: 'ready', colormap: 'viridis', center: false });
  await flush();
  handle({ type: 'refresh', colormap: 'coolwarm', center: true });
  await flush();

  assert.deepEqual(seen, [
    { colormap: 'viridis', center: false },
    { colormap: 'coolwarm', center: true },
  ]);
});

test('overlapping reloads are ignored while one is in flight', async () => {
  const gate = deferred<TableData>();
  let loads = 0;
  const { handle, posts } = harness(() => {
    loads++;
    return gate.promise;
  });

  handle({ type: 'ready' }); // starts load #1, now busy
  handle({ type: 'refresh' }); // must be swallowed while busy
  await flush();
  assert.equal(loads, 1, 'second request must not start another load');
  assert.equal(posts.length, 0, 'nothing posted until the load resolves');

  gate.resolve(makeData(1));
  await flush();
  assert.ok(posts.some((m) => m.type === 'init'));

  // Once settled, a further refresh can load again.
  handle({ type: 'refresh' });
  await flush();
  assert.equal(loads, 2);
});
