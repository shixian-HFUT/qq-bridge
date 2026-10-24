import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PiMaintenance } from '../src/pi-maintenance.js';
import { PiMediaStore } from '../src/pi-media-store.js';
import { projectPiContext, repairToolPairs } from '../src/pi-context.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const DAY = 86400000;
const id = 'pi-session-11111111-1111-1111-1111-111111111111';
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pi-clean-'));
  const dir = path.join(root, 'state', 'pi'); fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const file = path.join(dir, 'sessions', id + '.json');
  const session = { sessionId: id, messages: [], records: [], running: false, queue: [] };
  const live = new Map([[id, session]]);
  const save = s => fs.writeFileSync(file, JSON.stringify(s)); save(session);
  const cleanup = new PiMaintenance({ directory: dir, config, index: () => ({ sessions: { [id]: {} } }), live, saveSession: save });
  t.after(() => {
    cleanup.stop();
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'qq-pi-clean-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dir, file, session, live, save, cleanup };
}
function turn(n) {
  return [{ role: 'user', content: [{ type: 'text', text: 'question ' + n }], timestamp: n },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-' + n, name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'call-' + n, toolName: 'read', content: [{ type: 'text', text: 'result ' + n }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer ' + n }] }];
}

test('hot history is bounded by complete turns, cold history is lossless, and the latest memory snapshot survives', t => {
  const f = fixture(t, { maxHotTurns: 2, maxHotMessages: 8 });
  f.session.messages = [1, 2, 3, 4].flatMap(turn);
  f.session.messages[0].bridgeMemory = { version: 'memory-v1', text: 'keep memory' };
  const original = structuredClone(f.session.messages); f.save(f.session);
  const report = f.cleanup.run();
  assert.deepEqual(report.errors, []);
  assert.equal(report.archivedMessages, 8);
  assert.equal(f.session.messages.length, 8);
  assert.equal(repairToolPairs(f.session.messages).length, 8);
  assert.ok(JSON.stringify(projectPiContext(f.session.messages)).includes('keep memory'));
  const files = fs.readdirSync(path.join(f.dir, 'history', id));
  const cold = JSON.parse(gunzipSync(fs.readFileSync(path.join(f.dir, 'history', id, files[0]))));
  assert.deepEqual(cold.messages, original.slice(0, 8));
  assert.equal(f.cleanup.run().archivedMessages, 0);
  assert.equal(fs.readdirSync(path.join(f.dir, 'history', id)).length, 1);
});

test('media collection protects both hot and compressed cold references and keeps the grace period', t => {
  const f = fixture(t, { maxHotTurns: 2 });
  const media = new PiMediaStore(path.join(f.dir, 'media'));
  const images = ['cold', 'hot', 'orphan', 'fresh'].map(data => ({ type: 'image', mimeType: 'image/png', data }));
  for (const image of images) { const blocks = [image]; media.externalizeContent(blocks); Object.assign(image, blocks[0]); delete image.data; }
  f.session.messages = [1, 2, 3].flatMap(turn);
  f.session.messages[0].content.push(images[0]);
  f.session.messages.at(-1).content.push(images[1]); f.save(f.session);
  const old = new Date(Date.now() - 8 * DAY);
  for (const image of images.slice(0, 3)) fs.utimesSync(path.join(f.dir, 'media', image.bridgeImageRef + '.b64'), old, old);
  const oldTemp = path.join(f.dir, 'media', 'a'.repeat(64) + '.b64.1111.tmp');
  fs.writeFileSync(oldTemp, 'stale'); fs.utimesSync(oldTemp, old, old);
  const newTemp = path.join(f.dir, 'media', 'b'.repeat(64) + '.b64.2222.tmp'); fs.writeFileSync(newTemp, 'new');
  const report = f.cleanup.run();
  assert.deepEqual(report.errors, []);
  assert.equal(report.deletedMedia, 1); assert.equal(report.deletedTemps, 1);
  for (const i of [0, 1, 3]) assert.ok(fs.existsSync(path.join(f.dir, 'media', images[i].bridgeImageRef + '.b64')));
  assert.ok(!fs.existsSync(oldTemp)); assert.ok(fs.existsSync(newTemp));
  assert.equal(media.hydrateMessages(f.session.messages).at(-1).content.at(-1).data, 'hot');
});

test('a corrupt session prevents collection instead of deleting potentially referenced images', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'media'));
  const orphan = path.join(f.dir, 'media', 'c'.repeat(64) + '.b64'); fs.writeFileSync(orphan, 'keep');
  const old = new Date(Date.now() - 8 * DAY); fs.utimesSync(orphan, old, old);
  fs.writeFileSync(path.join(f.dir, 'sessions', 'pi-session-2222.json'), '{broken');
  const report = f.cleanup.run();
  assert.ok(report.errors.length); assert.equal(report.deletedMedia, 0); assert.ok(fs.existsSync(orphan));
});

test('failed hot checkpoint restores memory and retains a durable recoverable archive', t => {
  const f = fixture(t, { maxHotTurns: 2 });
  f.session.messages = [1, 2, 3].flatMap(turn); f.save(f.session);
  const original = f.session.messages;
  f.cleanup.saveSession = () => { throw Error('fixture checkpoint failure'); };
  const report = f.cleanup.run();
  assert.match(report.errors[0], /checkpoint failure/);
  assert.equal(f.session.messages, original);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).messages.length, 12);
  assert.equal(fs.readdirSync(path.join(f.dir, 'history', id)).length, 1);
  f.cleanup.saveSession = f.save;
  assert.equal(f.cleanup.run().archivedMessages, 4);
  assert.equal(fs.readdirSync(path.join(f.dir, 'history', id)).length, 1);
});

test('corrupt cold archives and symlinked cleanup directories stop file deletion', t => {
  const f = fixture(t, { maxHotTurns: 2 });
  f.session.messages = [1, 2, 3].flatMap(turn); f.save(f.session);
  assert.deepEqual(f.cleanup.run().errors, []);
  const cold = path.join(f.dir, 'history', id, fs.readdirSync(path.join(f.dir, 'history', id))[0]);
  fs.writeFileSync(cold, 'not gzip');
  const orphan = path.join(f.dir, 'media', 'd'.repeat(64) + '.b64'); fs.writeFileSync(orphan, 'keep');
  const old = new Date(Date.now() - 8 * DAY); fs.utimesSync(orphan, old, old);
  assert.ok(f.cleanup.run().errors.length); assert.ok(fs.existsSync(orphan));
  const g = fixture(t);
  const outside = path.join(g.root, 'outside'); fs.mkdirSync(outside);
  const protectedFile = path.join(outside, 'e'.repeat(64) + '.b64'); fs.writeFileSync(protectedFile, 'keep'); fs.utimesSync(protectedFile, old, old);
  fs.symlinkSync(outside, path.join(g.dir, 'media'), 'junction');
  assert.match(g.cleanup.run().errors[0], /Unsafe/); assert.ok(fs.existsSync(protectedFile));
});

test('busy sessions are never compacted or collected, and scheduling retries without invoking a model', t => {
  const f = fixture(t, { maxHotTurns: 2 });
  f.session.messages = [1, 2, 3].flatMap(turn); f.session.running = true; f.save(f.session);
  const before = fs.readFileSync(f.file, 'utf8');
  let callback, delay, unrefs = 0, clears = 0;
  f.cleanup.setTimer = (fn, ms) => { callback = fn; delay = ms; return { unref() { unrefs++; } }; };
  f.cleanup.clearTimer = () => { clears++; };
  f.cleanup.start(); assert.equal(delay, 60000); callback();
  assert.equal(f.cleanup.lastReport.skippedBusy, 1); assert.equal(delay, 300000);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  f.session.running = false; callback();
  assert.equal(f.cleanup.lastReport.archivedMessages, 4);
  assert.equal(delay, 6 * 3600000); assert.equal(unrefs, 3);
  f.cleanup.stop(); assert.equal(clears, 1);
});

test('the sole newest turn is retained whole even when it exceeds the byte target', t => {
  const f = fixture(t, { maxHotBytes: 4096 });
  f.session.messages = [...turn(1), ...turn(2)];
  f.session.messages.at(-1).content[0].text = 'x'.repeat(8000); f.save(f.session);
  const report = f.cleanup.run();
  assert.deepEqual(report.errors, []); assert.equal(report.archivedMessages, 4);
  assert.equal(f.session.messages.length, 4);
  assert.equal(f.session.messages.at(-1).content[0].text.length, 8000);
});

test('maintenance administration rejects agent callers and never enters the QQ tool surface', async () => {
  const h = await bridgeHarness();
  let runs = 0;
  h.api.maintenance = { status: () => ({ enabled: true }), run: () => ({ archivedMessages: ++runs }) };
  const server = h.startConsoleServer(0); await new Promise(resolve => server.on('listening', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/pi/maintenance`;
    const headers = { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' };
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'x-agent-call': '1' } })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'x-agent-token': 'fixture-agent' } })).status, 403);
    assert.equal((await (await fetch(endpoint, { headers })).json()).enabled, true);
    assert.equal((await (await fetch(endpoint, { method: 'POST', headers })).json()).report.archivedMessages, 1);
    assert.equal(runs, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});
