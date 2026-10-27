import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

let clock = 0;
let calls = [];
let handler;
const logs = new Map();
const context = vm.createContext({
  __html__: '', Uint8Array, atob, btoa, console,
  Date: class extends Date { static now() { return clock; } },
  setTimeout: (callback, ms) => { clock += ms; callback(); },
  fetch: async (url, init) => { calls.push({url, init}); return handler(url, init); },
  figma: {
    command: '', showUI() {}, on() {}, notify() {},
    ui: {postMessage() {}}, currentPage: {selection: []},
    clientStorage: {getAsync: async (key) => logs.get(key), setAsync: async (key, value) => logs.set(key, value)},
  },
});
const testBuiltPlugin = process.argv.includes('--built');
const code = testBuiltPlugin
  ? readFileSync('dist/plugin/code.js', 'utf8').replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis, {extractImageSource, getPromptAspectRatio, normalizeModel, validateGenerationRequest, resolvePolzaPayload, fetchPolzaMediaStatus, generateImageWithPolza});})();')
  : ts.transpileModule(readFileSync('src/plugin/code.ts', 'utf8'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
    }).outputText;
vm.runInContext(code, context);
const json = (payload, status = 200) => ({ok: status < 400, status, text: async () => JSON.stringify(payload)});
const source = 'https://s3.polza.ai/result.png';

for (const payload of [
  {output: {url: source}}, {output: [{url: source}]},
  {data: [{url: source}]}, {data: {url: source}}, {data: {images: [{url: source}]}},
  {images: [source]}, {data: [{}, {url: source}]}, {b64_json: 'aGVsbG8='},
]) {
  assert.equal(context.extractImageSource(payload), payload.b64_json || source);
}
assert.equal(context.extractImageSource({status: 'processing'}), null);
assert.equal(context.getPromptAspectRatio('сделай баннер 16:9'), '16:9');
assert.equal(context.getPromptAspectRatio('формат 9 × 16'), '9:16');
assert.equal(context.getPromptAspectRatio('3:4, затем исправь на 4:3'), '4:3');
assert.equal(context.getPromptAspectRatio('без указания пропорций'), 'auto');
assert.throws(() => context.getPromptAspectRatio('картинка 2048x1024'), /Пропорции 2048×1024 не поддерживаются/);
for (const prompt of ['разрешение 1200х900', 'размер 1200x900', '1200 × 900 пикселей', '1200 на 900', '1200*900']) {
  assert.equal(context.getPromptAspectRatio(prompt, 'Nano Banana 2.1'), '4:3');
}
assert.equal(context.getPromptAspectRatio('сделай 1920×1080'), '16:9');
assert.equal(context.getPromptAspectRatio('2160х3840'), '9:16');
assert.equal(context.getPromptAspectRatio('2520x1080'), '21:9');
assert.equal(context.getPromptAspectRatio('2400x1800'), '4:3');
assert.equal(context.getPromptAspectRatio('1200x1200'), '1:1');
assert.equal(context.getPromptAspectRatio('сначала 1:1, итоговый размер 1200х900'), '4:3');
assert.equal(context.getPromptAspectRatio('1200х900, но итоговый формат 9:16'), '9:16');
assert.equal(context.getPromptAspectRatio('2K, предметная съёмка 27.10.2026'), 'auto');
assert.throws(() => context.validateGenerationRequest({prompt: '1200х700', model: 'Nano Banana 2.1', references: []}), /Пропорции 1200×700 не поддерживаются/);
assert.equal(context.normalizeModel('Nano Banana 2.1'), 'google/gemini-nano-banana-2.1');
assert.equal(context.getPromptAspectRatio('Баннер 8:1', 'Nano Banana 2.1'), '8:1');
assert.equal(context.getPromptAspectRatio('Баннер 8:1', 'Nano Banana 2'), 'auto');

// A completed object response used to loop until timeout.
calls = [];
assert.equal((await context.resolvePolzaPayload({id: 'done', status: 'completed', output: {url: source}}, 'test')).output.url, source);
assert.equal(calls.length, 0);
await assert.rejects(context.resolvePolzaPayload({id: 'bad', status: 'failed', error: {message: 'Provider failed'}}, 'test'), /Provider failed.*bad/);
await assert.rejects(context.resolvePolzaPayload({id: 'empty', status: 'completed'}, 'test'), /completed without an image/);
await assert.rejects(context.resolvePolzaPayload({id: 'cancel', status: 'cancelled'}, 'test'), /cancelled/);

// A slow task stays on the documented v1 endpoint and can finish after 125s.
clock = 0; calls = [];
handler = () => json(clock < 180000 ? {status: 'processing'} : {status: 'completed', output: {url: source}});
assert.equal((await context.resolvePolzaPayload({id: 'slow', status: 'pending'}, 'test')).output.url, source);
assert.ok(clock >= 180000);
assert.ok(calls.every(({url}) => url === 'https://polza.ai/api/v1/media/slow'));

// A real failed status must not be hidden by a second endpoint's pending status.
calls = [];
handler = () => json({status: 'failed', error: {message: 'Upstream unavailable'}});
await assert.rejects(context.resolvePolzaPayload({id: 'failed', status: 'pending'}, 'test'), /Upstream unavailable/);
assert.equal(calls.length, 1);
handler = () => json({error: {message: 'not found'}}, 404);
await assert.rejects(context.fetchPolzaMediaStatus('missing', 'test'), /404.*missing/);

clock = 0;
handler = () => json({status: 'processing'});
await assert.rejects(context.resolvePolzaPayload({id: 'timeout-task', status: 'pending'}, 'test'), /timeout-task.*processing/);
assert.ok(clock >= 600000);

// Check the actual JSON sent by the UI -> plugin -> provider path.
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,8,0,0,0,4,0]);
const encoded = Buffer.from(png).toString('base64');
calls = [];
handler = () => json({status: 'completed', output: {b64_json: encoded}});
await context.generateImageWithPolza({apiKey: 'test', prompt: 'Баннер 16:9', model: 'google/gemini-3.1-flash-image-preview', quality: '2K', references: []});
const body = JSON.parse(calls[0].init.body);
assert.equal(body.input.aspect_ratio, '16:9');
assert.equal(body.input.image_resolution, '2K');
assert.equal(body.async, true);
assert.equal(calls.length, 1);
assert.equal(body.input.max_images, 1);
assert.equal(body.input.n, undefined);
calls = [];
await context.generateImageWithPolza({apiKey: 'test', prompt: 'Баннер 8:1', model: context.normalizeModel('Nano Banana 2.1'), quality: '4K', references: [{name: 'ref', dataUrl: `data:image/png;base64,${encoded}`} ]});
const nano21 = JSON.parse(calls[0].init.body);
assert.equal(nano21.model, 'google/gemini-nano-banana-2.1');
assert.equal(nano21.input.aspect_ratio, '8:1');
assert.equal(nano21.input.image_resolution, '4K');
assert.equal(nano21.input.images[0].type, 'base64');
for (const model of ['Nano Banana 2', 'Nano Banana 2.1']) {
  calls = [];
  await context.generateImageWithPolza({apiKey: 'test', prompt: 'Фото товара, разрешение 1200х900', model: context.normalizeModel(model), quality: '2K', references: [{name: 'square reference', dataUrl: `data:image/png;base64,${encoded}`} ]});
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.input.aspect_ratio, '4:3');
  assert.equal(request.input.image_resolution, '2K');
  assert.equal(request.input.images.length, 1);
}
console.log(`Provider regression checks passed (${testBuiltPlugin ? 'ready-to-run build' : 'source'}): response formats, pixel dimensions, ratios, 2K request, slow completion, failure, 404, timeout.`);
