import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ipv4HttpsFetch } from '../src/tts-transport.js';

test('TTS transport makes one IPv4 request, preserves streaming response and abort signal', async () => {
  let calls = 0, body;
  const signal = new AbortController().signal;
  const response = await ipv4HttpsFetch('https://example.com/tts', {
    method: 'POST', headers: { authorization: 'Bearer fixture-only' }, body: 'fixture body', signal,
  }, (url, options, callback) => {
    calls++; assert.equal(options.family, 4); assert.equal(options.method, 'POST');
    assert.equal(options.signal, signal); assert.equal(options.headers.authorization, 'Bearer fixture-only');
    const req = new EventEmitter(); req.end = value => {
      body = value; const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-type': 'text/event-stream' };
      callback(res); res.end('data: {"fixture":true}\n\n');
    }; return req;
  });
  assert.equal(calls, 1); assert.equal(body, 'fixture body'); assert(response.ok);
  assert.equal(await response.text(), 'data: {"fixture":true}\n\n');
});

test('TTS transport exposes redirects without following them and rejects plain HTTP', async () => {
  let calls = 0;
  const response = await ipv4HttpsFetch('https://example.com/tts', {}, (url, options, callback) => {
    calls++; const req = new EventEmitter(); req.end = () => {
      const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'https://other.example/' };
      callback(res); res.end();
    }; return req;
  });
  assert.equal(calls, 1); assert.equal(response.ok, false); assert.equal(response.status, 302);
  await response.body.cancel();
  await assert.rejects(ipv4HttpsFetch('http://example.com/tts'), /HTTPS/);
});
