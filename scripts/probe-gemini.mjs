// Only local test tool calls; no QQ messages or chat history are sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const envFile = path.join(os.homedir(), '.dsh', '.env');
const key = process.env.GEMINI_API_KEY || fs.readFileSync(envFile, 'utf8').match(/^GEMINI_API_KEY=(.+)$/m)?.[1].trim();
if (!key) throw Error('Missing Gemini credential');
const model = process.argv[2] || 'gemini-3.8-flash';
if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model)) throw Error('Invalid model id');
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
async function call(body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const d = await r.json();
  if (!r.ok) throw Error(`HTTP ${r.status}: ${String(d.error?.message || 'request failed').replaceAll(key, '[redacted]')}`);
  return d;
}
try {
  const contents = [{ role: 'user', parts: [{ text: 'Connection test: call echo_check with word hello, then after the result reply only OK.' }] }];
  const tools = [{ functionDeclarations: [{ name: 'echo_check', description: 'Harmless local connection test.', parameters: { type: 'OBJECT', properties: { word: { type: 'STRING' } }, required: ['word'] } }] }];
  const a = await call({ contents, tools, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['echo_check'] } } });
  const response = a.candidates?.[0]?.content;
  const fc = response?.parts?.find(p => p.functionCall)?.functionCall;
  if (fc?.name !== 'echo_check') throw Error('Missing expected function call');
  contents.push(response, { role: 'user', parts: [{ functionResponse: { name: fc.name, response: { result: fc.args.word } } }] });
  const b = await call({ contents, tools });
  if (!b.candidates?.[0]?.content?.parts?.some(p => p.text)) throw Error('Missing reply after tool result');
  console.log(JSON.stringify({ model, returnedModel: b.modelVersion, functionCalling: true, multiTurn: true }));
} catch (e) {
  console.error(String(e.message).replaceAll(key, '[redacted]'));
  process.exitCode = 1;
}
