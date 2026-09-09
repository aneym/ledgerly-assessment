import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const nextRoot = path.dirname(require.resolve('next/package.json'));
assert.equal(require('next/package.json').version, '16.3.4');
const patchText = readFileSync(new URL('../../../patches/next@16.3.4.patch', import.meta.url), 'utf8');

function loadMiddleware(format, original = false) {
  const relative = `dist/${format === 'esm' ? 'esm/' : ''}server/dev/hot-middleware.js`;
  const file = path.join(nextRoot, relative);
  let source = readFileSync(file, 'utf8');
  const marker = `this.publishToClient(client, {\n                    type: ${format === 'esm' ? '' : '_hotreloadertypes.'}HMR_MESSAGE_SENT_TO_BROWSER.SYNC,`;
  assert.equal(source.split(marker).length, 2, 'installed exact Next patch must be present once');
  assert.ok(patchText.includes(`diff --git a/${relative} b/${relative}`));
  if (original) source = source.replace(marker, marker.replace('this.publishToClient(client, {', 'this.publish({'));
  // ESM is compiled only in memory; relative imports resolve to the equivalent CJS dependencies.
  const cjsFile = path.join(nextRoot, 'dist/server/dev/hot-middleware.js');
  if (format === 'esm') source = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, allowJs: true },
  }).outputText;
  const mod = new Module(cjsFile);
  mod.filename = cjsFile;
  mod.paths = Module._nodeModulePaths(path.dirname(cjsFile));
  mod._compile(source, cjsFile);
  return mod.exports.WebpackHotMiddleware;
}
function fixture(Constructor) {
  const compiler = () => ({ hooks: { invalid: { tap() {} }, done: { tap() {} } } });
  const middleware = new Constructor([compiler(), compiler(), compiler()], {}, '', { experimental: {} }, {});
  const client = () => ({ messages: [], send(value) { this.messages.push(JSON.parse(value)); }, addEventListener() {}, terminate() {} });
  const stats = (hash, errors = [], warnings = []) => ({ toJson: () => ({ hash, errors, warnings }), hasErrors: () => errors.length > 0 });
  const old = [client(), client()];
  middleware.clientLatestStats = { ts: 1, stats: stats('first') };
  middleware.onHMR(old[0], 'request-one');
  middleware.onHMR(old[1], null);
  old.forEach(c => { c.messages.length = 0; });
  middleware.clientLatestStats = { ts: 2, stats: stats('second', [{ message: 'build error' }], ['build warning']) };
  const fresh = client();
  middleware.onHMR(fresh, 'request-three');
  return { middleware, old, fresh, stats };
}
for (const format of ['cjs', 'esm']) {
  test(`${format}: original broadcast reproduces changed SYNC on existing clients`, () => {
    const { old } = fixture(loadMiddleware(format, true));
    for (const client of old) assert.equal(client.messages[0].hash, 'second');
  });
  test(`${format}: initial SYNC targets the new client; later builds and errors reach all clients`, () => {
    const { middleware, old, fresh, stats } = fixture(loadMiddleware(format));
    for (const client of old) assert.deepEqual(client.messages, []);
    assert.equal(fresh.messages.length, 1);
    assert.deepEqual({ type: fresh.messages[0].type, hash: fresh.messages[0].hash, errors: fresh.messages[0].errors, warnings: fresh.messages[0].warnings }, {
      type: 'sync', hash: 'second', errors: [{ message: 'build error' }], warnings: ['build warning'],
    });
    assert.equal(middleware.getClient('request-three'), fresh);
    assert.equal(middleware.getClient('request-one'), old[0]);
    middleware.publishStats(stats('third', [{ message: 'later error' }], ['later warning']));
    for (const client of [...old, fresh]) assert.deepEqual(client.messages.at(-1), {
      type: 'built', hash: 'third', errors: [{ message: 'later error' }], warnings: ['later warning'],
    });
  });
}
console.log(`Verified isolated patched Next: ${realpathSync(nextRoot)}`);
