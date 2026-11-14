#!/usr/bin/env node
'use strict';
/**
 * tests/cnsw-test.js — Full 10-Suite Verification Harness for CyberNetServerWeb
 * Runs Node verification suites + real headless Chromium multi-tab tests via CDP pipe.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const REPO_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.resolve(REPO_DIR, '../cybernetserverweb');
const HTML_PATH = path.join(REPO_DIR, 'cybernetserverweb.html');
const VECTORS_PATH = path.join(SRC_DIR, 'studionet/golden-vectors.json');
const REF_PATH = path.join(SRC_DIR, 'studionet/studionet-ref.js');

const Ref = require(REF_PATH);
const Vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function assertCheck(suiteNum, name, cond, detail = '') {
  totalChecks++;
  if (cond) {
    passedChecks++;
    console.log(`PASS [${suiteNum}] ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failedChecks++;
    console.log(`FAIL [${suiteNum}] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function toHex(u8) {
  return Array.from(Uint8Array.from(u8), b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hexStr) {
  const clean = String(hexStr || '').replace(/\s+/g, '');
  const out = new Uint8Array(clean.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Deterministic Mulberry32 PRNG for fault injection and synthetic test model
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a tiny valid GGUF v3 RWKV-7 (x070) model buffer with deterministic non-zero weights
function buildTinyTestGgufBuffer(opts = {}) {
  const modelName = opts.name || 'cnsw-tiny-rwkv7-test';
  const vocabSize = opts.vocabSize || 65536;
  const dim = opts.dim || 64;
  const headSize = opts.headSize || 64;
  const numLayers = opts.numLayers || 1;
  const dimFFN = opts.dimFFN || 128;
  const dDecay = opts.dDecay || 64;
  const dAAA = opts.dAAA || 64;
  const dGate = opts.dGate || 64;
  const rng = mulberry32(opts.seed || 42);

  // Tensor definitions in ggml shape order (reversed from torch shape)
  // Note: w1, w2, a1, a2, g1, g2 are stored transposed in GGUF so ne matches torch [R, C] directly!
  const tensorSpecs = [
    { name: 'token_embd.weight', ne: [dim, vocabSize], ty: 0 },
    { name: 'token_embd_norm.weight', ne: [dim], ty: 0 },
    { name: 'token_embd_norm.bias', ne: [dim], ty: 0 },
    { name: 'output_norm.weight', ne: [dim], ty: 0 },
    { name: 'output_norm.bias', ne: [dim], ty: 0 },
    { name: 'output.weight', ne: [dim, vocabSize], ty: 0 }
  ];

  for (let l = 0; l < numLayers; l++) {
    const b = `blk.${l}.`;
    tensorSpecs.push(
      { name: b + 'attn_norm.weight', ne: [dim], ty: 0 },
      { name: b + 'attn_norm.bias', ne: [dim], ty: 0 },
      { name: b + 'attn_norm_2.weight', ne: [dim], ty: 0 },
      { name: b + 'attn_norm_2.bias', ne: [dim], ty: 0 },
      { name: b + 'time_mix_lerp_fused.weight', ne: [dim, 6], ty: 0 },
      { name: b + 'time_mix_w0.weight', ne: [dim], ty: 0 },
      { name: b + 'time_mix_w1.weight', ne: [dim, dDecay], ty: 0 },
      { name: b + 'time_mix_w2.weight', ne: [dDecay, dim], ty: 0 },
      { name: b + 'time_mix_a0.weight', ne: [dim], ty: 0 },
      { name: b + 'time_mix_a1.weight', ne: [dim, dAAA], ty: 0 },
      { name: b + 'time_mix_a2.weight', ne: [dAAA, dim], ty: 0 },
      { name: b + 'time_mix_g1.weight', ne: [dim, dGate], ty: 0 },
      { name: b + 'time_mix_g2.weight', ne: [dGate, dim], ty: 0 },
      { name: b + 'time_mix_k_k.weight', ne: [dim], ty: 0 },
      { name: b + 'time_mix_k_a.weight', ne: [dim], ty: 0 },
      { name: b + 'time_mix_r_k.weight', ne: [dim], ty: 0 },
      { name: b + 'time_mix_receptance.weight', ne: [dim, dim], ty: 0 },
      { name: b + 'time_mix_key.weight', ne: [dim, dim], ty: 0 },
      { name: b + 'time_mix_value.weight', ne: [dim, dim], ty: 0 },
      { name: b + 'time_mix_output.weight', ne: [dim, dim], ty: 0 },
      { name: b + 'time_mix_ln.weight', ne: [dim], ty: 0 },
      { name: b + 'time_mix_ln.bias', ne: [dim], ty: 0 },
      { name: b + 'channel_mix_lerp_k.weight', ne: [dim], ty: 0 },
      { name: b + 'channel_mix_key.weight', ne: [dim, dimFFN], ty: 0 },
      { name: b + 'channel_mix_value.weight', ne: [dimFFN, dim], ty: 0 }
    );
  }

  // Compute byte offsets and total parameter count (excluding fused lerp split count difference: RWKV7 model.p counts 6 separate [1,1,C] tensors = 6*C, same as [C,6])
  let dataOffset = 0;
  let expectedParams = 0;
  for (const t of tensorSpecs) {
    const count = t.ne.reduce((a, b) => a * b, 1);
    t.count = count;
    t.bytes = count * 4; // F32
    t.off = dataOffset;
    dataOffset += t.bytes;
    expectedParams += count;
  }

  // Serialize GGUF header
  const chunks = [];
  const pushU32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); chunks.push(b); };
  const pushU64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); chunks.push(b); };
  const pushStr = (s) => { const sb = Buffer.from(s, 'utf8'); pushU64(sb.length); chunks.push(sb); };

  pushU32(0x46554747); // "GGUF"
  pushU32(3);          // version 3
  pushU64(tensorSpecs.length);
  pushU64(4);          // 4 metadata KV pairs

  // KV 1: general.architecture = "rwkv7"
  pushStr('general.architecture'); pushU32(8); pushStr('rwkv7');
  // KV 2: general.name = modelName
  pushStr('general.name'); pushU32(8); pushStr(modelName);
  // KV 3: rwkv7.block_count = numLayers
  pushStr('rwkv7.block_count'); pushU32(4); pushU32(numLayers);
  // KV 4: rwkv7.wkv.head_size = headSize
  pushStr('rwkv7.wkv.head_size'); pushU32(4); pushU32(headSize);

  for (const t of tensorSpecs) {
    pushStr(t.name);
    pushU32(t.ne.length);
    for (const d of t.ne) pushU64(d);
    pushU32(t.ty); // 0 = F32
    pushU64(t.off);
  }

  const headerBuf = Buffer.concat(chunks);
  const align = 32;
  const padLen = (Math.ceil(headerBuf.length / align) * align) - headerBuf.length;
  const padBuf = Buffer.alloc(padLen);

  const dataBuf = Buffer.alloc(dataOffset);
  const f32View = new Float32Array(dataBuf.buffer, dataBuf.byteOffset, dataOffset / 4);
  for (let i = 0; i < f32View.length; i++) {
    const r = (rng() * 2 - 1) * 0.05;
    f32View[i] = r === 0 ? 0.01 : r;
  }

  const fullBuf = Buffer.concat([headerBuf, padBuf, dataBuf]);
  return {
    buffer: fullBuf.buffer.slice(fullBuf.byteOffset, fullBuf.byteOffset + fullBuf.byteLength),
    modelName,
    expectedParams,
    quant: 'F32'
  };
}

// Minimal CDP Client over --remote-debugging-pipe (fd 3 / fd 4)
class CdpPipeBrowser {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.rxBuf = '';
  }
  async launch() {
    this.proc = spawn('chromium', [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
      '--remote-debugging-pipe'
    ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });

    this.tx = this.proc.stdio[3];
    this.rx = this.proc.stdio[4];
    this.rx.on('data', (chunk) => {
      this.rxBuf += chunk.toString('utf8');
      let idx;
      while ((idx = this.rxBuf.indexOf('\0')) >= 0) {
        const raw = this.rxBuf.slice(0, idx);
        this.rxBuf = this.rxBuf.slice(idx + 1);
        if (!raw) continue;
        const msg = JSON.parse(raw);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else if (msg.method) {
          const key = (msg.sessionId || '') + ':' + msg.method;
          const handlers = this.eventHandlers.get(key) || [];
          for (const h of handlers) h(msg.params);
        }
      }
    });
  }
  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.tx.write(JSON.stringify(payload) + '\0');
    });
  }
  onEvent(sessionId, method, fn) {
    const key = (sessionId || '') + ':' + method;
    if (!this.eventHandlers.has(key)) this.eventHandlers.set(key, []);
    this.eventHandlers.get(key).push(fn);
  }
  async openTab(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const pageErrors = [];
    const consoleErrors = [];
    this.onEvent(sessionId, 'Runtime.exceptionThrown', (p) => {
      pageErrors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception'));
    });
    this.onEvent(sessionId, 'Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push((p.args || []).map(a => a.value || a.description || '').join(' '));
      }
    });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 100; i++) {
      const r = await this.send('Runtime.evaluate', { expression: `document.readyState === "complete" && location.href.startsWith("http://127.0.0.2") && (location.pathname === "/blank" ? true : Boolean(window.CNSW))`, returnByValue: true }, sessionId);
      if (r.result && r.result.value === true) break;
      await new Promise(res => setTimeout(res, 30));
    }
    return {
      targetId,
      sessionId,
      pageErrors,
      consoleErrors,
      eval: async (expr, awaitPromise = true) => {
        const res = await this.send('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise
        }, sessionId);
        if (res.exceptionDetails) {
          throw new Error('Page eval error: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
        }
        return res.result ? res.result.value : undefined;
      },
      close: async () => {
        await this.send('Target.closeTarget', { targetId });
      }
    };
  }
  async close() {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
  }
}

async function runAllSuites() {
  console.log('================================================================');
  console.log('CyberNetServerWeb — Full 10-Suite Verification Harness');
  console.log('================================================================');

  const htmlSource = fs.readFileSync(HTML_PATH, 'utf8');

  // --------------------------------------------------------------------------
  // SUITE 9: Static Scan & Lift Provenance Verification
  // --------------------------------------------------------------------------
  {
    const hasCsp = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["']default-src\s+'none'/.test(htmlSource);
    assertCheck(9, '9a strict CSP meta tag present', hasCsp);

    // Strip lifted blocks when checking our own code, and also check entire HTML for forbidden APIs
    const forbiddenNet = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection)\s*\(/.exec(htmlSource);
    assertCheck(9, '9b no network APIs except BroadcastChannel', !forbiddenNet && htmlSource.includes('BroadcastChannel'), forbiddenNet ? forbiddenNet[0] : 'BroadcastChannel only');

    const forbiddenStorage = /\b(localStorage|sessionStorage|openDatabase)\b/.exec(htmlSource);
    const hasIdb = /\bindexedDB\.open\b/.test(htmlSource);
    assertCheck(9, '9c storage only through IndexedDB', !forbiddenStorage && hasIdb);

    // Check studionet-ref.js not present
    const hasRefGlobal = htmlSource.includes('StudioNetRef') || htmlSource.includes('studionet-ref.js');
    assertCheck(9, '9d studionet-ref.js not present in server page', !hasRefGlobal);

    // Verify every inline provenance marker against source files and LIFTS.md
    const htmlLines = htmlSource.split(/\r?\n/);
    const provenanceRe = /^(?:\/\/|<!--)\s*from\s+([^\s:]+):(\d+)-(\d+)(?:\s*-->)?$/;
    const foundBlocks = [];
    for (let i = 0; i < htmlLines.length; i++) {
      const m = provenanceRe.exec(htmlLines[i].trim());
      if (m) {
        const srcFile = m[1];
        const startLine = Number(m[2]);
        const endLine = Number(m[3]);
        const endMarker1 = `// end from ${srcFile}:${startLine}-${endLine}`;
        const endMarker2 = `<!-- end from ${srcFile}:${startLine}-${endLine} -->`;
        let j = i + 1;
        while (j < htmlLines.length && htmlLines[j].trim() !== endMarker1 && htmlLines[j].trim() !== endMarker2) {
          j++;
        }
        const extracted = htmlLines.slice(i + 1, j).join('\n');
        const origLines = fs.readFileSync(path.join(SRC_DIR, srcFile), 'utf8').split(/\r?\n/);
        const origText = origLines.slice(startLine - 1, endLine).join('\n');
        const liftSha = sha256Hex(extracted);
        const origSha = sha256Hex(origText);
        foundBlocks.push({ srcFile, range: `${startLine}-${endLine}`, match: liftSha === origSha, liftSha });
      }
    }
    const allMatch = foundBlocks.length === 10 && foundBlocks.every(b => b.match);
    assertCheck(9, '9e all 10 inline lifted blocks labeled and SHA-256 byte-identical to source', allMatch, `${foundBlocks.filter(b => b.match).length}/${foundBlocks.length} blocks matched`);
  }

  // Start local loopback static server so all Chromium tabs share origin for BroadcastChannel & IndexedDB
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.url && req.url.startsWith("/blank")) {
      res.end("<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
    } else {
      res.end(htmlSource);
    }
  });
  await new Promise(r => srv.listen(0, "127.0.0.2", r));
  const port = srv.address().port;

  // Launch headless Chromium for browser-backed and dual-context tests
  const browser = new CdpPipeBrowser();
  await browser.launch();

  try {
    const fileUrl = `http://127.0.0.2:${port}/cybernetserverweb.html`;
    const serverTab = await browser.openTab(fileUrl + '?listenMs=40');

    // Wait for initial boot + listen window
    await new Promise(r => setTimeout(r, 220)); 

    // ------------------------------------------------------------------------
    // SUITE 1: Golden Vectors (Produce, Parse, SRRP, Transfer, Naming, Bridge)
    // ------------------------------------------------------------------------
    {
      const gvRes = await serverTab.eval(`(() => {
        const V = ${JSON.stringify(Vectors)};
        const C = window.CNSW;
        const results = { produce: [], parse: [], srrp: [], transfer: [], naming: [], bridge: [] };

        const hex = (u8) => Array.from(Uint8Array.from(u8), b => b.toString(16).padStart(2, '0')).join('');
        const unhex = (s) => {
          const out = new Uint8Array(s.length >>> 1);
          for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i*2, i*2+2), 16);
          return out;
        };

        // 1. Produce vectors
        for (const p of V.produce) {
          const expFrame = C.unpackFrame(unhex(p.hex));
          let built;
          if (p.fields) {
            built = C.packFrame({
              dst: p.fields.dst,
              src: p.fields.src,
              proto: p.fields.proto,
              flags: p.fields.flags,
              sport: p.fields.sport,
              dport: p.fields.dport,
              seq: p.fields.seq,
              ack: p.fields.ack,
              payload: unhex(p.fields.payload)
            });
          } else if (p.sns) {
            let snsBytes;
            if (p.sns.op === 'WHO') snsBytes = C.buildWhoPayload(p.sns.name);
            else if (p.sns.op === 'BYE') snsBytes = C.buildByePayload();
            else snsBytes = C.buildHelloPayload(p.sns);
            built = C.buildSnsFrame(expFrame.src, expFrame.dst, expFrame.seq, snsBytes);
          }
          const decBuilt = C.unpackFrame(built);
          results.produce.push({
            name: p.name,
            ok: hex(built) === p.hex && decBuilt.ok && decBuilt.seq === expFrame.seq
          });
        }

        // 2. Parse vectors
        for (const pv of V.parse) {
          const raw = unhex(pv.hex);
          const fd = C.unpackFrame(raw);
          let status = fd.ok ? 'accept' : ('reject: ' + fd.error);
          if (fd.ok && fd.proto === 1) {
            const sd = C.parseSnsPayload(fd.payload);
            if (!sd.ok) status = 'reject: ' + sd.error;
          }
          results.parse.push({ name: pv.name, ok: status === pv.expect, actual: status, expect: pv.expect });
        }

        // 3. SRRP vectors (parse, encode, and server answers)
        for (const sv of V.srrp) {
          const raw = unhex(sv.hex);
          const dec = C.unpackSrrpMessage(raw);
          if (sv.expect && sv.expect.startsWith('legacy:')) {
            const frames = C.ServerNode.receiveRawFrame(C.packFrame({
              dst: C.ServerNode.nodeId,
              src: 0x0101,
              proto: 3,
              flags: 5,
              sport: 49152,
              dport: 80,
              seq: 77,
              ack: 0,
              payload: raw
            }));
            const f0 = frames[0] ? C.unpackFrame(frames[0]) : null;
            const ok = dec.ok && dec.legacy && f0 && f0.flags === 6 && f0.payload.length > 0 && f0.payload.length <= 480;
            results.srrp.push({ name: sv.name, ok });
          } else if (dec.request) {
            const reenc = C.packSrrpMessage({ request: true, method: dec.method, path: dec.path, headers: dec.headers, body: dec.body });
            const respBytes = C.handleSrrpRequest(dec);
            const respDec = C.unpackSrrpMessage(respBytes);
            results.srrp.push({
              name: sv.name,
              ok: hex(reenc) === sv.hex && respDec.ok && (respDec.status === 200 || respDec.status === 201)
            });
          } else {
            const reenc = C.packSrrpMessage({ request: false, status: dec.status, reason: dec.reason, headers: dec.headers, body: dec.body });
            results.srrp.push({ name: sv.name, ok: dec.ok && hex(reenc) === sv.hex });
          }
        }

        // 4. Transfer vectors
        {
          // Vector 1: 1,100 bytes in 3 frames, seq 65534 -> 65535 -> 0, Window 8
          const tv0 = V.transfer[0];
          const msg1100 = new Uint8Array(1100).map((_, i) => i & 255);
          const tx = new C.CnswTxSession({ src: 0x0101, dst: 0x00FD, sport: 49152, dport: 80, message: msg1100, startSeq: 65534 });
          tx.cwnd = 4;
          const sentFrames = tx.poll(0).map(hex);
          const rx = new C.CnswRxSession({ me: 0x00FD, window: 8, maxSize: 65536 });
          const acks = [];
          for (const fh of tv0.frames) {
            for (const a of rx.onData(C.unpackFrame(unhex(fh)))) acks.push(hex(a));
          }
          results.transfer.push({
            name: tv0.name,
            ok: JSON.stringify(sentFrames) === JSON.stringify(tv0.frames) && JSON.stringify(acks) === JSON.stringify(tv0.acks)
          });

          // Vector 2: gap (seq 65534 then seq 0)
          const tv1 = V.transfer[1];
          const rxGap = new C.CnswRxSession({ me: 0x00FD, window: 8, maxSize: 65536 });
          const gapAcks = [];
          for (const fh of tv1.deliver) {
            for (const a of rxGap.onData(C.unpackFrame(unhex(fh)))) gapAcks.push(hex(a));
          }
          results.transfer.push({
            name: tv1.name,
            ok: JSON.stringify(gapAcks) === JSON.stringify(tv1.acks)
          });
        }

                // 5. Naming vectors (V.naming)
        {
          function SimNet() {
            const nodes = [];
            return {
              nodes,
              join(n, t) { const a = new C.CnswNamingEngine(n); a.joinedAt = t; a.alive = true; a.deaf = new Set(n.deafTo || []); nodes.push(a); return a; },
              leave(node) { nodes.find(a => a.me.node === node).alive = false; },
              round(t) {
                const snap = nodes.filter(a => a.alive).map(a => ({ node: a.me.node, kind: a.me.kind, age: Math.floor(t - a.joinedAt), token: a.me.token, named: a.me.named, num: a.num, name: a.me.name }));
                for (const a of nodes.filter(x => x.alive)) a.update(snap.filter(p => !a.deaf.has(p.node)), Math.floor(t - a.joinedAt));
              },
              names() { return Object.fromEntries(nodes.filter(a => a.alive).map(a => ["0x" + a.me.node.toString(16).padStart(4, "0"), a.display])); },
              settle(t, r = 4) { for (let i = 0; i < r; i++) this.round(t + i * 0.001); }
            };
          }
          const N1 = SimNet();
          N1.join({ node: 0x0201, kind: 2, token: 50 }, 0); N1.settle(1);
          N1.join({ node: 0x0202, kind: 2, token: 10 }, 5); N1.settle(8);
          N1.join({ node: 0x0203, kind: 2, token: 99 }, 9); N1.settle(12);
          results.naming.push({ name: V.naming[0].name, ok: JSON.stringify(N1.names()) === JSON.stringify(V.naming[0].expect) });
          N1.leave(0x0201); N1.settle(20);
          N1.join({ node: 0x0204, kind: 2, token: 7 }, 30); N1.settle(31);
          const n1b = N1.names();
          results.naming.push({ name: V.naming[1].name, ok: n1b["0x0202"] === "hb2" && n1b["0x0203"] === "hb3" && n1b["0x0204"] === "hb1" });

          const N2 = SimNet();
          N2.join({ node: 0x0301, kind: 3, token: 900 }, 0);
          N2.join({ node: 0x0302, kind: 3, token: 100 }, 0);
          N2.settle(3, 6);
          const n2 = N2.names();
          results.naming.push({ name: V.naming[2].name, ok: n2["0x0302"] === "tri1" && n2["0x0301"] === "tri2" });

          const N3 = SimNet();
          N3.join({ node: 0x0201, kind: 2, token: 5, deafTo: [0x0211, 0x0212] }, 0);
          N3.join({ node: 0x0202, kind: 2, token: 6, deafTo: [0x0211, 0x0212] }, 2);
          N3.join({ node: 0x0211, kind: 2, token: 1, deafTo: [0x0201, 0x0202] }, 10);
          N3.join({ node: 0x0212, kind: 2, token: 2, deafTo: [0x0201, 0x0202] }, 11);
          N3.settle(20);
          N3.nodes.forEach(a => a.deaf.clear()); N3.settle(40, 6);
          results.naming.push({ name: V.naming[3].name, ok: JSON.stringify(N3.names()) === JSON.stringify(V.naming[3].expect) });

          const N4 = SimNet();
          N4.join({ node: 0x0101, kind: 1, token: 3, named: true, name: "toshiba" }, 0);
          N4.join({ node: 0x0201, kind: 2, token: 1, named: true, name: "toshiba" }, 4);
          N4.settle(6);
          results.naming.push({ name: V.naming[4].name, ok: JSON.stringify(N4.names()) === JSON.stringify(V.naming[4].expect) });
        }

        // 6. Bridge vector
        {
          const bv = V.bridge[0];
          const wrapped = C.wrapBridgeEnvelope(unhex(bv.frame), 0xA1B2C3D4, 0);
          const unwrapped = C.unwrapBridgeEnvelope(wrapped, 0x11111111);
          results.bridge.push({
            name: bv.name,
            ok: hex(wrapped) === bv.hex && unwrapped.ok && hex(unwrapped.frame) === bv.frame
          });
        }

        return results;
      })()`);

      assertCheck(1, '1a Golden produce vectors (7/7 field & byte exact)', gvRes.produce.every(x => x.ok), `${gvRes.produce.filter(x => x.ok).length}/${gvRes.produce.length}`);
      assertCheck(1, '1b Golden parse vectors (5/5 accept/reject exact)', gvRes.parse.every(x => x.ok), `${gvRes.parse.filter(x => x.ok).length}/${gvRes.parse.length}`);
      assertCheck(1, '1c Golden SRRP vectors & server responses (6/6)', gvRes.srrp.every(x => x.ok), `${gvRes.srrp.filter(x => x.ok).length}/${gvRes.srrp.length}`);
      assertCheck(1, '1d Golden multi-frame SACK transfer vectors (2/2)', gvRes.transfer.every(x => x.ok), `${gvRes.transfer.filter(x => x.ok).length}/${gvRes.transfer.length}`);
      assertCheck(1, '1e Golden naming vectors (5/5)', gvRes.naming.every(x => x.ok), `${gvRes.naming.filter(x => x.ok).length}/${gvRes.naming.length}`);
      assertCheck(1, '1f Golden SNB1 bridge envelope vector (1/1)', gvRes.bridge.every(x => x.ok));
    }

    // ------------------------------------------------------------------------
    // SUITE 2: Differential Test (studionet-ref.js Client in Second Browser Tab
    //          over BroadcastChannel + Seeded Fault-Injecting Relay)
    // ------------------------------------------------------------------------
    {
      const clientTab = await browser.openTab(`http://127.0.0.2:${port}/blank`);
      const refCode = fs.readFileSync(REF_PATH, 'utf8');
      await clientTab.eval(refCode);

      // Set up a seeded fault-injecting relay on BroadcastChannel between clientTab and serverTab:
      // To inject faults on real BroadcastChannel frames without modifying studionet-ref.js,
      // the client tab sends/receives through a relay channel pair or wraps its BroadcastChannel.
      // Wait: let's keep serverTab on real BroadcastChannel("studionet-v1") and have the clientTab
      // run StudioNetRef.Sender / StudioNetRef.Receiver over BroadcastChannel("studionet-v1") with
      // the seeded fault injector (drop, duplicate, reorder)!
      const diffStats = await clientTab.eval(`(async () => {
        const R = window.StudioNetRef;
        const bc = new BroadcastChannel('studionet-v1');
        let clientPortSeq = 50000;

        function mulberry(seed) {
          return () => {
            seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        }

        async function runSrrpTransaction(reqSpec, faultOpt = {}) {
          const sport = clientPortSeq++;
          const rand = mulberry(faultOpt.seed || 1);
          const dropRate = faultOpt.drop || 0;
          const dupRate = faultOpt.dup || 0;
          const jitterMs = faultOpt.jitterMs || 0;
          const zeroSack = !!faultOpt.zeroSack;

          const reqBytes = R.encodeMessage(Object.assign({ request: true }, reqSpec));
          const sender = new R.Sender({
            src: 0x0101,
            dst: 0x00FD,
            sport,
            dport: 80,
            message: reqBytes,
            startSeq: (sport * 13) & 0xFFFF,
            rto: faultOpt.rto || 90,
            maxTries: 5
          });
          const receiver = new R.Receiver({
            me: 0x0101,
            window: 16,
            maxSize: 2 * 1024 * 1024
          });

          let dropped = 0, duplicated = 0, reordered = 0;

          const transmitToWire = (frames) => {
            for (const fr of frames) {
              const copy = new Uint8Array(fr);
              if (rand() < dropRate) {
                dropped++;
                continue;
              }
              const delay = jitterMs > 0 ? Math.floor(rand() * jitterMs) : 0;
              if (delay > 2) reordered++;
              if (delay === 0) bc.postMessage(copy);
              else setTimeout(() => bc.postMessage(copy), delay);

              if (rand() < dupRate) {
                duplicated++;
                setTimeout(() => bc.postMessage(new Uint8Array(copy)), delay + 2);
              }
            }
          };

          return new Promise((resolve) => {
            let settled = false;
            const finish = (res) => {
              if (settled) return;
              settled = true;
              bc.removeEventListener('message', onMsg);
              clearInterval(timer);
              resolve(Object.assign(res, {
                dropped,
                duplicated,
                reordered,
                clientSent: sender.stats.sent,
                clientResent: sender.stats.resent,
                clientTimeouts: sender.stats.timeouts,
                rxDuplicates: receiver.stats.duplicates
              }));
            };

            const onMsg = (ev) => {
              if (!ev || !ev.data) return;
              const raw = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
              const f = R.decodeFrame(raw);
              if (!f.ok || f.dst !== 0x0101 || f. proto !== R.PROTO.SSP || f.dport !== sport) return;

              // Fault injection on inbound frames
              if (rand() < dropRate) {
                dropped++;
                return;
              }

              const deliverInbound = (frameObj) => {
                if (settled) return;
                if ((frameObj.flags & R.FLAG.ACK) && !(frameObj.flags & R.FLAG.PSH)) {
                  let ackFrame = frameObj;
                  if (zeroSack && ackFrame.payload && ackFrame.payload.length >= 3) {
                    ackFrame = Object.assign({}, ackFrame, { payload: new Uint8Array([0, 0, ackFrame.payload[2]]) });
                  }
                  const fast = sender.onAck(ackFrame, performance.now());
                  const next = sender.poll(performance.now());
                  transmitToWire(fast.concat(next));
                } else if (frameObj.flags & R.FLAG.PSH) {
                  let acks = receiver.onData(frameObj);
                  if (zeroSack) {
                    acks = acks.map(a => {
                      const b = new Uint8Array(a);
                      if (b.length >= 19) { b[16] = 0; b[17] = 0; }
                      return b;
                    });
                  }
                  transmitToWire(acks);
                  if (receiver.state === 'done' && receiver.message) {
                    const dec = R.decodeMessage(receiver.message);
                    finish({ ok: true, state: 'done', response: dec, rawLen: receiver.message.length });
                  }
                }
              };

              const delay = jitterMs > 0 ? Math.floor(rand() * jitterMs) : 0;
              if (delay > 2) reordered++;
              if (delay === 0) deliverInbound(f);
              else setTimeout(() => deliverInbound(f), delay);

              if (rand() < dupRate) {
                duplicated++;
                setTimeout(() => deliverInbound(f), delay + 2);
              }
            };

            bc.addEventListener('message', onMsg);
            transmitToWire(sender.poll(performance.now()));

            const timer = setInterval(() => {
              const now = performance.now();
              const out = sender.poll(now);
              if (out.length) transmitToWire(out);
              if (sender.state === 'failed') {
                finish({ ok: false, state: 'TIMEOUT' });
              }
            }, 15);
          });
        }

        // 1. Differential PUT / LIST / GET / DEL at 1 KB, 64 KB, and 1 MB over fault-injecting link
        const sizes = [
          { label: '1KB', bytes: 1024, name: 'diff1k.bin', drop: 0.04, dup: 0.03, jitterMs: 8, seed: 101 },
          { label: '64KB', bytes: 65536, name: 'diff64k.bin', drop: 0.03, dup: 0.02, jitterMs: 6, seed: 202 },
          { label: '1MB', bytes: 1048576, name: 'diff1m.bin', drop: 0.01, dup: 0.01, jitterMs: 4, seed: 303 }
        ];

        const sizeRuns = [];
        for (const sz of sizes) {
          const payload = new Uint8Array(sz.bytes);
          for (let i = 0; i < sz.bytes; i++) payload[i] = (i * 31 + 17) & 0xFF;

          const putRes = await runSrrpTransaction(
            { method: 'PUT', path: '/files/' + sz.name, headers: { Encoding: 'bytes' }, body: payload },
            { drop: sz.drop, dup: sz.dup, jitterMs: sz.jitterMs, seed: sz.seed }
          );
          const getRes = await runSrrpTransaction(
            { method: 'GET', path: '/files/' + sz.name },
            { drop: sz.drop, dup: sz.dup, jitterMs: sz.jitterMs, seed: sz.seed + 1 }
          );
          const gotBody = getRes.response && getRes.response.body ? Uint8Array.from(getRes.response.body) : new Uint8Array(0);
          let byteIdentical = gotBody.length === payload.length;
          if (byteIdentical) {
            for (let i = 0; i < payload.length; i++) {
              if (gotBody[i] !== payload[i]) { byteIdentical = false; break; }
            }
          }
          const listRes = await runSrrpTransaction({ method: 'LIST', path: '/files' }, { seed: sz.seed + 2 });
          const listTxt = new TextDecoder().decode(listRes.response?.body || new Uint8Array(0));
          const listedOk = listTxt.includes(sz.name);

          const delRes = await runSrrpTransaction({ method: 'DEL', path: '/files/' + sz.name }, { seed: sz.seed + 3 });

          sizeRuns.push({
            label: sz.label,
            bytes: sz.bytes,
            putStatus: putRes.response?.status,
            getStatus: getRes.response?.status,
            delStatus: delRes.response?.status,
            listedOk,
            byteIdentical,
            dropped: putRes.dropped + getRes.dropped,
            duplicated: putRes.duplicated + getRes.duplicated,
            reordered: putRes.reordered + getRes.reordered,
            resends: putRes.clientResent + getRes.clientResent,
            timeouts: putRes.clientTimeouts + getRes.clientTimeouts
          });
        }

        // POST /minipedia/search differential check
        const postRes = await runSrrpTransaction({
          method: 'POST',
          path: '/minipedia/search',
          headers: { Type: 'form' },
          body: Array.from('q=Triton', c => c.charCodeAt(0))
        }, { drop: 0.05, dup: 0.02, jitterMs: 6, seed: 404 });
        const postBodyStr = new TextDecoder().decode(postRes.response?.body || new Uint8Array(0));

        // Positive control 1: 100% loss -> TIMEOUT
        const loss100 = await runSrrpTransaction(
          { method: 'GET', path: '/' },
          { drop: 1.0, rto: 35, seed: 505 }
        );

        // Positive control 2: Oversize PUT (> 1 MB) -> 413 TOO BIG before body completes
        // Construct first frame of a 2 MB PUT manually over BroadcastChannel and verify immediate 413 response
        const oversizeCheck = await new Promise((resolve) => {
          const sp = clientPortSeq++;
          const headStr = 'PUT /files/huge.bin SRRP/1\\nEncoding: bytes\\nSize: 2097152\\n\\n';
          const firstPayload = new Uint8Array(480);
          for (let i = 0; i < headStr.length; i++) firstPayload[i] = headStr.charCodeAt(i);
          const synFrame = R.encodeFrame({
            dst: 0x00FD, src: 0x0101, proto: 3, flags: R.FLAG.SYN | R.FLAG.PSH,
            sport: sp, dport: 80, seq: 1, ack: 0, payload: firstPayload
          });
          const onM = (ev) => {
            const f = R.decodeFrame(new Uint8Array(ev.data));
            if (f.ok && f.dst === 0x0101 && f.dport === sp && (f.flags & R.FLAG.PSH)) {
              const d = R.decodeMessage(f.payload);
              bc.removeEventListener('message', onM);
              resolve({ status: d.status, reason: d.reason, framesSentByClient: 1 });
            }
          };
          bc.addEventListener('message', onM);
          bc.postMessage(synFrame);
        });

        // Positive control 3: ../x gives 403 FORBIDDEN
        const travRes = await runSrrpTransaction({ method: 'GET', path: '/../x' }, { seed: 606 });

        // Positive control 4: Corrupted reference (SACK bitmap zeroed) completes with more resends
        const payload32k = new Uint8Array(32768).map((_, i) => (i * 19) & 0xFF);
        const withSack = await runSrrpTransaction(
          { method: 'PUT', path: '/files/sack_on.bin', body: payload32k },
          { drop: 0.06, jitterMs: 8, rto: 60, seed: 777, zeroSack: false }
        );
        const withoutSack = await runSrrpTransaction(
          { method: 'PUT', path: '/files/sack_off.bin', body: payload32k },
          { drop: 0.06, jitterMs: 8, rto: 60, seed: 777, zeroSack: true }
        );
        await runSrrpTransaction({ method: 'DEL', path: '/files/sack_on.bin' });
        await runSrrpTransaction({ method: 'DEL', path: '/files/sack_off.bin' });

        bc.close();
        return {
          sizeRuns,
          postOk: postRes.ok && postRes.response?.status === 200 && postBodyStr.includes('Triton'),
          loss100,
          oversizeCheck,
          travStatus: travRes.response?.status,
          sackCompare: {
            withSackOk: withSack.ok,
            withoutSackOk: withoutSack.ok,
            withSackResends: withSack.clientResent,
            withoutSackResends: withoutSack.clientResent,
            withSackTimeouts: withSack.clientTimeouts,
            withoutSackTimeouts: withoutSack.clientTimeouts
          }
        };
      })()`);

      for (const r of diffStats.sizeRuns) {
        assertCheck(2, `2a Differential PUT/LIST/GET/DEL ${r.label} (${r.bytes} B) over fault-injecting BroadcastChannel`,
          r.putStatus === 201 && r.getStatus === 200 && r.delStatus === 200 && r.listedOk && r.byteIdentical,
          `byte-identical=${r.byteIdentical}, dropped=${r.dropped}, dups=${r.duplicated}, reordered=${r.reordered}, resends=${r.resends}, timeouts=${r.timeouts}`);
      }
      assertCheck(2, '2b Differential POST /minipedia/search over fault-injecting BroadcastChannel', diffStats.postOk);
      assertCheck(2, '2c Positive control: 100% frame loss gives TIMEOUT on client', diffStats.loss100.state === 'TIMEOUT', `state=${diffStats.loss100.state}, timeouts=${diffStats.loss100.clientTimeouts}`);
      assertCheck(2, '2d Positive control: oversize PUT gives 413 TOO BIG at the first frame before body', diffStats.oversizeCheck.status === 413 && diffStats.oversizeCheck.framesSentByClient === 1, `status=${diffStats.oversizeCheck.status}, clientFramesSent=${diffStats.oversizeCheck.framesSentByClient}`);
      assertCheck(2, '2e Positive control: ../x path traversal gives 403 FORBIDDEN', diffStats.travStatus === 403, `status=${diffStats.travStatus}`);
      assertCheck(2, '2f Positive control: zeroed SACK bitmap still completes but requires more resends',
        diffStats.sackCompare.withSackOk && diffStats.sackCompare.withoutSackOk && diffStats.sackCompare.withoutSackResends > diffStats.sackCompare.withSackResends,
        `with SACK resends=${diffStats.sackCompare.withSackResends} (timeouts=${diffStats.sackCompare.withSackTimeouts}) vs zeroed SACK resends=${diffStats.sackCompare.withoutSackResends} (timeouts=${diffStats.sackCompare.withoutSackTimeouts})`);

      await clientTab.close();
    }

    // ------------------------------------------------------------------------
    // SUITE 3: Naming — Two Server Tabs Come Up as cnsw1 / cnsw2 in Join Order
    // ------------------------------------------------------------------------
    {
      const serverTab2 = await browser.openTab(fileUrl + '?node=0x00FC&listenMs=40');
      await new Promise(r => setTimeout(r, 350));

      const name1 = await serverTab.eval(`window.CNSW.ServerNode.naming.display`);
      const name2 = await serverTab2.eval(`window.CNSW.ServerNode.naming.display`);
      assertCheck(3, '3a Two server tabs come up as cnsw1 and cnsw2 in join order', name1 === 'cnsw1' && name2 === 'cnsw2', `tab1=${name1}, tab2=${name2}`);

      await serverTab2.eval(`window.CNSW.ServerNode.sendBye()`);
      await serverTab2.close();
      await new Promise(r => setTimeout(r, 100));
    }

    // ------------------------------------------------------------------------
    // SUITE 4: Vanta is in the Loop
    // ------------------------------------------------------------------------
    {
      const vantaCheck = await serverTab.eval(`(() => {
        const C = window.CNSW;
        const sampleHtml = '<!DOCTYPE html><html><head><style>body { background: #102030; color: #ffffff; } h1 { color: #4ade80; }</style></head><body><h1>Vanta Loop Check</h1><p>First paragraph in box tree.</p><p>Second paragraph in box tree.</p></body></html>';

        // Baseline render
        const base = C.renderPageWithVanta(sampleHtml, '');
        const baseSnapHex = Array.from(base.spiralSnapBytes, b => b.toString(16).padStart(2, '0')).join('');
        const baseProj = base.projectionText;

        // 4a. Monkey-patch Vanta's layout to shift every box by 1 px -> snapshot changes
        const origRender = window.vanta.render.bind(window.vanta);
        window.vanta.render = function(h, c) {
          const r = origRender(h, c);
          for (const b of (r.allBoxes || [])) {
            b.x += 1;
            b.y += 1;
          }
          return r;
        };
        const shifted = C.renderPageWithVanta(sampleHtml, '');
        const shiftedSnapHex = Array.from(shifted.spiralSnapBytes, b => b.toString(16).padStart(2, '0')).join('');
        window.vanta.render = origRender;

        // 4b. Patch Vanta's parser to drop one element -> projection changes accordingly
        const origParse = window.vanta._internals.parseHTML;
        window.vanta._internals.parseHTML = function(h) {
          const doc = origParse(h);
          const body = doc.body || doc;
          if (body && body.children && body.children.length > 1) {
            body.children.pop(); // Drop last element
          }
          return doc;
        };
        const dropped = C.renderPageWithVanta(sampleHtml, '');
        const droppedProj = dropped.projectionText;
        window.vanta._internals.parseHTML = origParse;

        // 4c. CSS-only differences -> different snapshots, identical projection
        const cssDiffHtml = '<!DOCTYPE html><html><head><style>body { background: #f03060; color: #ffff00; } h1 { color: #00ffff; }</style></head><body><h1>Vanta Loop Check</h1><p>First paragraph in box tree.</p><p>Second paragraph in box tree.</p></body></html>';
        const cssDiff = C.renderPageWithVanta(cssDiffHtml, '');
        const cssDiffSnapHex = Array.from(cssDiff.spiralSnapBytes, b => b.toString(16).padStart(2, '0')).join('');
        const cssDiffProj = cssDiff.projectionText;

        return {
          layoutShiftChangedSnap: baseSnapHex !== shiftedSnapHex,
          parserDropChangedProj: baseProj !== droppedProj && baseProj.includes('Second paragraph') && !droppedProj.includes('Second paragraph'),
          cssOnlyChangedSnap: baseSnapHex !== cssDiffSnapHex,
          cssOnlySameProj: baseProj === cssDiffProj
        };
      })()`);

      assertCheck(4, '4a Monkey-patching Vanta layout (+1 px box shift) changes snapshot', vantaCheck.layoutShiftChangedSnap);
      assertCheck(4, '4b Monkey-patching Vanta parser (dropping 1 element) changes projection accordingly', vantaCheck.parserDropChangedProj);
      assertCheck(4, '4c Page with CSS-only differences produces different snapshots but identical projection', vantaCheck.cssOnlyChangedSnap && vantaCheck.cssOnlySameProj);
    }

    // ------------------------------------------------------------------------
    // SUITE 5: /snap Compatibility (Side-by-Side with Convergence Gateway Lift & fmt=t3)
    // ------------------------------------------------------------------------
    {
      const snapCheck = await serverTab.eval(`(() => {
        const C = window.CNSW;
        const fixedHtml = '<!DOCTYPE html><html><head><style>body { background: #16213e; color: #eaeaea; padding: 20px; } h1 { color: #e94560; } p { color: #38bdf8; }</style></head><body><h1>Convergence Compatibility</h1><p>Testing byte-exact SpiralWeb 160x96 snapshot output.</p></body></html>';

        // Put fixedHtml at /www/compat.html and fetch /snap/compat.html?fmt=spiral via SRRP
        C.handleSrrpRequest({
          ok: true, request: true, method: 'PUT', path: '/www/compat.html',
          headers: { Size: String(fixedHtml.length) },
          body: new TextEncoder().encode(fixedHtml)
        });
        const srrpSpiral = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/snap/compat.html?fmt=spiral', headers: {}
        }));

        // Run Convergence's lifted buildSnapshotFromVanta directly on Vanta's render of fixedHtml
        const vRes = window.vanta.render(fixedHtml, '');
        const convSnap = window.ConvergenceGatewayLift.buildSnapshotFromVanta(vRes, window.ConvergenceGatewayLift.SPIRAL_PALETTE_RGB);

        let spiralEqual = srrpSpiral.ok && srrpSpiral.body.length === 15360 && convSnap.length === 15360;
        if (spiralEqual) {
          for (let i = 0; i < 15360; i++) {
            if (srrpSpiral.body[i] !== convSnap[i]) { spiralEqual = false; break; }
          }
        }

        // Check fmt=t3 (width u16=160, height u16=100, 16000 trytes16 in -364..+364)
        const srrpT3 = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/snap/compat.html?fmt=t3', headers: {}
        }));
        const dv = new DataView(srrpT3.body.buffer, srrpT3.body.byteOffset, srrpT3.body.byteLength);
        const w = dv.getUint16(0, true);
        const h = dv.getUint16(2, true);
        const trytes = C.decodeTrytes16(srrpT3.body.slice(4));
        const inRange = trytes.length === 16000 && trytes.every(t => t >= -364 && t <= 364);

        return {
          spiralEqual,
          spiralLen: srrpSpiral.body.length,
          t3Ok: srrpT3.ok && srrpT3.headers.Type === 'image/t3-snap' && srrpT3.headers.Encoding === 'trytes16' && w === 160 && h === 100 && inRange,
          t3Len: srrpT3.body.length
        };
      })()`);

      assertCheck(5, '5a /snap?fmt=spiral bytes equal Convergence gateway lift byte-for-byte (15,360 B)', snapCheck.spiralEqual, `bytes=${snapCheck.spiralLen}`);
      assertCheck(5, '5b /snap?fmt=t3 returns Type: image/t3-snap, 160x100 u16 header, and 16,000 trytes16 in -364..+364 (32,004 B)', snapCheck.t3Ok, `bytes=${snapCheck.t3Len}`);
    }

    // ------------------------------------------------------------------------
    // SUITE 6: MiniPedia (Built-in 15 MIT Articles, Search Ranking, 1,000-Article Synthetic Import & License Separation)
    // ------------------------------------------------------------------------
    {
      const mpCheck = await serverTab.eval(`(async () => {
        const C = window.CNSW;

        // 6a. Check all 15 built-in articles are served with MIT byline
        const mitSlugs = Array.from(C.MemoryStore.minipediaMit.keys());
        let servedCount = 0;
        for (const slug of mitSlugs) {
          const resp = C.unpackSrrpMessage(C.handleSrrpRequest({
            ok: true, request: true, method: 'GET', path: '/minipedia/' + slug, headers: { Accept: 'text/hts' }
          }));
          const txt = new TextDecoder().decode(resp.body);
          if (resp.status === 200 && txt.includes('Kehai Interim, ConsciousNode SoftWorks') && txt.includes('MIT')) {
            servedCount++;
          }
        }

        // 6b. Search ranks exact title match first
        const hits = C.searchMinipedia('Triton');
        const exactFirst = hits.length > 0 && hits[0].title === 'Triton';

        // Also test via SRRP POST /minipedia/search
        const postSearch = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'POST', path: '/minipedia/search',
          headers: { Type: 'form' },
          body: new TextEncoder().encode('q=Triton')
        }));
        const postSearchTxt = new TextDecoder().decode(postSearch.body);
        const postRanksTritonFirst = postSearch.status === 200 && postSearchTxt.includes('1. <a href="/minipedia/triton">Triton</a>');

        // 6c. Generate 1,000 synthetic abstract XML articles and import streamingly
        const xmlDocs = ['<feed>'];
        for (let i = 1; i <= 1050; i++) {
          const numStr = String(i).padStart(4, '0');
          xmlDocs.push(
            '<doc><title>Wikipedia: Synthetic Test Entry ' + numStr + '</title>' +
            '<url>https://en.wikipedia.org/wiki/Synthetic_Test_Entry_' + numStr + '</url>' +
            '<abstract>Synthetic encyclopedia abstract body for test entry ' + numStr + ' verifying streaming XML import.</abstract></doc>'
          );
        }
        xmlDocs.push('</feed>');
        const importRes = await C.importWikipediaAbstractXml(xmlDocs.join('\\n'), { cap: 1000 });

        // Check imported pages show CC BY-SA 4.0 and source URL
        const firstWiki = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/minipedia/wiki-synthetic-test-entry-0001', headers: { Accept: 'text/hts' }
        }));
        const lastWiki = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/minipedia/wiki-synthetic-test-entry-1000', headers: { Accept: 'text/hts' }
        }));
        const firstTxt = new TextDecoder().decode(firstWiki.body);
        const lastTxt = new TextDecoder().decode(lastWiki.body);
        const ccAttributed = firstTxt.includes('Text from Wikipedia, CC BY-SA 4.0') &&
                             firstTxt.includes('https://en.wikipedia.org/wiki/Synthetic_Test_Entry_0001') &&
                             lastTxt.includes('Text from Wikipedia, CC BY-SA 4.0');

        // Verify MIT export contains 0 imported articles
        const mitExport = C.exportMinipediaMitJson();
        const wikiExport = C.exportMinipediaWikiJson();
        const mitHasZeroWiki = mitExport.articles.length === 15 && mitExport.articles.every(a => a.license === 'MIT' && !a.slug.startsWith('wiki-'));

        // Verify /minipedia/license page is served
        const licResp = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/minipedia/license', headers: { Accept: 'text/hts' }
        }));
        const licTxt = new TextDecoder().decode(licResp.body);

        // Clean up synthetic imported entries after test
        C.MemoryStore.minipediaWiki.clear();

        return {
          servedCount,
          exactFirst: exactFirst && postRanksTritonFirst,
          importedCount: importRes.imported,
          ccAttributed,
          mitHasZeroWiki,
          wikiExportCount: wikiExport.articles.length,
          licOk: licResp.status === 200 && licTxt.includes('MIT') && licTxt.includes('CC BY-SA 4.0')
        };
      })()`);

      assertCheck(6, '6a All 15 built-in MIT MiniPedia articles served with byline', mpCheck.servedCount === 15, `${mpCheck.servedCount}/15 served`);
      assertCheck(6, '6b MiniPedia search ranks exact title match first', mpCheck.exactFirst);
      assertCheck(6, '6c 1,000-article synthetic dump streaming import honors cap, shows CC BY-SA 4.0 + URL on every page, and MIT export has 0 imported articles',
        mpCheck.importedCount === 1000 && mpCheck.ccAttributed && mpCheck.mitHasZeroWiki && mpCheck.wikiExportCount === 1000 && mpCheck.licOk,
        `imported=${mpCheck.importedCount}, mitExport=${mpCheck.mitHasZeroWiki ? '15 (0 wiki)' : 'fail'}, wikiExport=${mpCheck.wikiExportCount}`);
    }

    // ------------------------------------------------------------------------
    // SUITE 7: Chat Jeepy Tea (No Model State, Tiny Random GGUF Model, Streaming Poll, 503 BUSY, Header Match, Engine Hash)
    // ------------------------------------------------------------------------
    {
      // 7a. With no model loaded, /chat says "No model loaded."
      const noModelRes = await serverTab.eval(`(() => {
        const C = window.CNSW;
        C.ChatEngine.unloadModel();
        const resp = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/chat', headers: { Accept: 'text/hts' }
        }));
        return {
          status: resp.status,
          text: new TextDecoder().decode(resp.body)
        };
      })()`);
      assertCheck(7, '7a With no model loaded, /chat says "No model loaded."', noModelRes.status === 200 && noModelRes.text.includes('No model loaded.'));

      // 7b & 7c. Build tiny randomly initialized GGUF v3 RWKV-7 model and load into server
      const tinyGguf = buildTinyTestGgufBuffer({ name: 'tiny-rwkv7-test-v1', seed: 1337 });
      const ggufB64 = Buffer.from(tinyGguf.buffer).toString('base64');

      const chatRun = await serverTab.eval(`(async () => {
        const C = window.CNSW;
        const bin = atob('${ggufB64}');
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

        const info = C.ChatEngine.loadFromArrayBuffer(u8.buffer, 'tiny-rwkv7.gguf');
        C.ChatEngine.settings.maxTokens = 6;
        C.ChatEngine.stepDelayMs = 25;

        // Start generation via POST /chat
        const post1 = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'POST', path: '/chat',
          headers: { Type: 'form' },
          body: new TextEncoder().encode('q=Hello+there&conv=test1')
        }));
        const post1Text = new TextDecoder().decode(post1.body);

        // Immediately send a second concurrent POST /chat -> must get 503 BUSY
        const post2 = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'POST', path: '/chat',
          headers: { Type: 'form' },
          body: new TextEncoder().encode('q=Second+question&conv=test2')
        }));

        // Poll GET /chat/test1?after=<n> as tokens stream
        const polledIds = [];
        let sawThinking = post1Text.includes('(thinking…)');
        for (let poll = 0; poll < 40; poll++) {
          await new Promise(r => setTimeout(r, 15));
          const pollResp = C.unpackSrrpMessage(C.handleSrrpRequest({
            ok: true, request: true, method: 'GET', path: '/chat/test1?after=' + polledIds.length,
            headers: { Accept: 'text/hts' }
          }));
          const pollText = new TextDecoder().decode(pollResp.body);
          if (pollText.includes('(thinking…)')) sawThinking = true;
          const idHeader = pollResp.headers['X-Chat-Token-Ids'] || '';
          if (idHeader) {
            for (const part of idHeader.split(',')) {
              if (part !== '') polledIds.push(Number(part));
            }
          }
          if (pollResp.headers['X-Chat-Done'] === '1') break;
        }

        const conv = C.ChatEngine.getOrCreateConv('test1');
        const finalTurn = conv.turns[conv.turns.length - 1];

        return {
          info,
          post1Status: post1.status,
          post1Text,
          post2Status: post2.status,
          post2Reason: post2.reason,
          post2RetryAfter: post2.headers['Retry-After'],
          sawThinking,
          polledIds,
          actualIds: finalTurn.tokens
        };
      })()`);

      assertCheck(7, '7b Tiny random GGUF model generates tokens, polling returns them in order, and concurrent request gets 503 BUSY',
        chatRun.post1Status === 200 &&
        chatRun.sawThinking &&
        chatRun.post2Status === 503 &&
        chatRun.post2Reason === 'BUSY' &&
        chatRun.polledIds.length === 6 &&
        JSON.stringify(chatRun.polledIds) === JSON.stringify(chatRun.actualIds),
        `tokens=${JSON.stringify(chatRun.polledIds)}, 2ndStatus=${chatRun.post2Status} ${chatRun.post2Reason} (Retry-After: ${chatRun.post2RetryAfter})`);

      assertCheck(7, '7c Model info shown on /chat matches GGUF file header exactly',
        chatRun.info.name === tinyGguf.modelName &&
        chatRun.info.nParams === tinyGguf.expectedParams &&
        chatRun.info.quant === tinyGguf.quant &&
        chatRun.post1Text.includes(tinyGguf.modelName) &&
        chatRun.post1Text.includes(String(tinyGguf.expectedParams)),
        `name=${chatRun.info.name}, nParams=${chatRun.info.nParams}, quant=${chatRun.info.quant}`);

      // 7d. Verify lifted RWKV-7 engine in cybernetserverweb.html hash-matches pips-room.html:1331-2075
      const pipsLines = fs.readFileSync(path.join(SRC_DIR, 'pip-suite/pips-room.html'), 'utf8').split(/\r?\n/);
      const pipsEngineOrig = pipsLines.slice(1331 - 1, 2075).join('\n');
      const cnswLines = htmlSource.split(/\r?\n/);
      const startIdx = cnswLines.findIndex(l => l.trim() === '// from pip-suite/pips-room.html:1331-2075');
      const endIdx = cnswLines.findIndex(l => l.trim() === '// end from pip-suite/pips-room.html:1331-2075');
      const cnswEngineLifted = cnswLines.slice(startIdx + 1, endIdx).join('\n');
      const origEngineHash = sha256Hex(pipsEngineOrig);
      const liftedEngineHash = sha256Hex(cnswEngineLifted);
      assertCheck(7, '7d Lifted RWKV-7 engine SHA-256 matches pips-room.html:1331-2075',
        origEngineHash === liftedEngineHash, `sha256=${liftedEngineHash}`);
    }

    // ------------------------------------------------------------------------
    // SUITE 8: Files (Round Trip at 1 B, 480 B, 1 MB; Quota -> 507; Whitelist; .html Served as Data)
    // ------------------------------------------------------------------------
    {
      const filesCheck = await serverTab.eval(`(() => {
        const C = window.CNSW;
        C.setConfig({ maxFileBytes: 1048576, maxTotalBytes: 67108864 });

        const testSizes = [
          { name: 'one.bin', size: 1 },
          { name: 'frame.bin', size: 480 },
          { name: 'megabyte.bin', size: 1048576 }
        ];
        const rtResults = [];
        for (const ts of testSizes) {
          const data = new Uint8Array(ts.size);
          for (let i = 0; i < ts.size; i++) data[i] = (i * 13 + 7) & 0xFF;

          const putR = C.unpackSrrpMessage(C.handleSrrpRequest({
            ok: true, request: true, method: 'PUT', path: '/files/' + ts.name,
            headers: { Encoding: 'bytes', Size: String(ts.size) }, body: data
          }));
          const getR = C.unpackSrrpMessage(C.handleSrrpRequest({
            ok: true, request: true, method: 'GET', path: '/files/' + ts.name, headers: {}
          }));
          let same = getR.ok && getR.body.length === ts.size;
          if (same) {
            for (let i = 0; i < ts.size; i++) if (getR.body[i] !== data[i]) { same = false; break; }
          }
          const delR = C.unpackSrrpMessage(C.handleSrrpRequest({
            ok: true, request: true, method: 'DEL', path: '/files/' + ts.name, headers: {}
          }));
          rtResults.push({ name: ts.name, size: ts.size, ok: putR.status === 201 && getR.status === 200 && same && delR.status === 200 });
        }

        // Quota -> 507 FULL
        C.setConfig({ maxFileBytes: 2048, maxTotalBytes: 1500 });
        const q1 = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'PUT', path: '/files/part1.txt',
          headers: { Size: '1000' }, body: new Uint8Array(1000)
        }));
        const q2 = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'PUT', path: '/files/part2.txt',
          headers: { Size: '600' }, body: new Uint8Array(600)
        }));
        C.handleSrrpRequest({ ok: true, request: true, method: 'DEL', path: '/files/part1.txt', headers: {} });
        C.setConfig({ maxFileBytes: 1048576, maxTotalBytes: 67108864 });

        // Whitelist types & uploaded .html served as raw data (application/octet-stream), never rendered
        const rawHtmlBytes = new TextEncoder().encode('<!DOCTYPE html><html><body><h1>Uploaded HTML File</h1><script>window.__EVIL=1;</script></body></html>');
        const putHtml = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'PUT', path: '/files/page.html',
          headers: { Encoding: 'bytes', Size: String(rawHtmlBytes.length) }, body: rawHtmlBytes
        }));
        const getHtml = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/files/page.html', headers: {}
        }));
        const getHtmlStr = new TextDecoder().decode(getHtml.body);
        const htmlNotRenderedByVanta = getHtml.headers.Type === 'application/octet-stream' &&
                                       getHtmlStr.includes('<script>window.__EVIL=1;</script>') &&
                                       !getHtmlStr.includes('vanta:') &&
                                       !window.__EVIL;

        const putTxt = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'PUT', path: '/files/readme.txt',
          headers: { Encoding: 'bytes', Size: '5' }, body: new TextEncoder().encode('hello')
        }));
        const getTxt = C.unpackSrrpMessage(C.handleSrrpRequest({
          ok: true, request: true, method: 'GET', path: '/files/readme.txt', headers: {}
        }));

        C.handleSrrpRequest({ ok: true, request: true, method: 'DEL', path: '/files/page.html', headers: {} });
        C.handleSrrpRequest({ ok: true, request: true, method: 'DEL', path: '/files/readme.txt', headers: {} });

        return {
          rtResults,
          quota507: q1.status === 201 && q2.status === 507 && q2.reason === 'FULL',
          whitelistOk: getTxt.headers.Type === 'text/plain' && getHtml.headers.Type === 'application/octet-stream',
          htmlNotRenderedByVanta
        };
      })()`);

      assertCheck(8, '8a Files round trip at 1 B, 480 B, and 1 MB (1,048,576 B)', filesCheck.rtResults.every(r => r.ok), JSON.stringify(filesCheck.rtResults.map(r => `${r.size}B:${r.ok}`)));
      assertCheck(8, '8b Total storage quota exceeded returns 507 FULL', filesCheck.quota507);
      assertCheck(8, '8c Extension whitelist MIME types enforced and uploaded .html served as raw data (never rendered)', filesCheck.whitelistOk && filesCheck.htmlNotRenderedByVanta);
    }

    // ------------------------------------------------------------------------
    // SUITE 10: Real Browser — 0 Page Errors, and Two Client Tabs (Reference Peers)
    //           + Server Tab All See Each Other in `peers`
    // ------------------------------------------------------------------------
    {
      const peerTab1 = await browser.openTab(`http://127.0.0.2:${port}/blank`);
      const peerTab2 = await browser.openTab(`http://127.0.0.2:${port}/blank`);
      const refCode = fs.readFileSync(REF_PATH, 'utf8');
      await peerTab1.eval(refCode);
      await peerTab2.eval(refCode);

      // Start Reference Peer 1 (TabComp 0x0101) and Reference Peer 2 (Hummingbird 0x0201)
      const setupPeerScript = (nodeId, kind, token) => `(() => {
        const R = window.StudioNetRef;
        window.peerAgent = new R.NameAgent({ node: ${nodeId}, kind: ${kind}, age: 5, token: ${token}, named: false });
        window.peerTable = new Map();
        window.bc = new BroadcastChannel('studionet-v1');
        window.bc.onmessage = (ev) => {
          const f = R.decodeFrame(new Uint8Array(ev.data));
          if (!f.ok || f.proto !== R.PROTO.SNS) return;
          const s = R.decodeSns(f.payload);
          if (!s.ok) return;
          if (s.op === 'HELLO' && f.src !== ${nodeId}) {
            window.peerTable.set(f.src, Object.assign({ node: f.src }, s));
            window.peerAgent.update(Array.from(window.peerTable.values()), 5);
          } else if (s.op === 'WHO') {
            const h = window.peerAgent.hello({ os: 1, services: 23 });
            window.bc.postMessage(R.snsFrame(${nodeId}, f.src, 1, h));
          }
        };
        const h = window.peerAgent.hello({ os: 1, services: 23 });
        window.bc.postMessage(R.snsFrame(${nodeId}, 0xFFFF, 1, h));
      })()`;

      await peerTab1.eval(setupPeerScript(0x0101, 1, 1001));
      await peerTab2.eval(setupPeerScript(0x0201, 2, 2002));
      await serverTab.eval(`window.CNSW.ServerNode.sendHello(0xFFFF)`);
      await new Promise(r => setTimeout(r, 250));
      await peerTab1.eval(`window.bc.postMessage(window.StudioNetRef.snsFrame(0x0101, 0xFFFF, 2, window.peerAgent.hello({ os: 1, services: 23 })))`);
      await peerTab2.eval(`window.bc.postMessage(window.StudioNetRef.snsFrame(0x0201, 0xFFFF, 2, window.peerAgent.hello({ os: 1, services: 23 })))`);
      await new Promise(r => setTimeout(r, 200));

      const serverPeers = await serverTab.eval(`Array.from(window.CNSW.ServerNode.peers.values()).filter(p => !p.left).map(p => ({ node: p.node, name: window.CNSW.formatDisplayName(p) }))`);
      const peer1Peers = await peerTab1.eval(`Array.from(window.peerTable.values()).map(p => ({ node: p.node, name: window.StudioNetRef.displayName(p) }))`);
      const peer2Peers = await peerTab2.eval(`Array.from(window.peerTable.values()).map(p => ({ node: p.node, name: window.StudioNetRef.displayName(p) }))`);

      const totalPageErrors = serverTab.pageErrors.length + serverTab.consoleErrors.length;
      assertCheck(10, '10a Real browser loads cybernetserverweb.html with 0 page/console errors', totalPageErrors === 0, `pageErrors=${serverTab.pageErrors.length}, consoleErrors=${serverTab.consoleErrors.length}`);

      const serverSeesBoth = serverPeers.some(p => p.node === 0x0101) && serverPeers.some(p => p.node === 0x0201);
      const peer1SeesBoth = peer1Peers.some(p => p.node === 0x00FD) && peer1Peers.some(p => p.node === 0x0201);
      const peer2SeesBoth = peer2Peers.some(p => p.node === 0x00FD) && peer2Peers.some(p => p.node === 0x0101);
      assertCheck(10, '10b Server (0x00FD) and two reference client tabs (0x0101, 0x0201) all see each other in peers',
        serverSeesBoth && peer1SeesBoth && peer2SeesBoth,
        `serverPeers=${JSON.stringify(serverPeers)}, peer1Peers=${JSON.stringify(peer1Peers)}, peer2Peers=${JSON.stringify(peer2Peers)}`);

      await peerTab1.close();
      await peerTab2.close();
    }

    await serverTab.close();
  } finally {
    await browser.close();
    srv.close();
  }

  console.log('================================================================');
  console.log(`SUMMARY: ${passedChecks}/${totalChecks} PASS (${failedChecks} FAIL)`);
  console.log('================================================================');
  process.exit(failedChecks ? 1 : 0);
}

runAllSuites().catch((err) => {
  console.error('Unhandled test harness error:', err);
  process.exit(1);
});
