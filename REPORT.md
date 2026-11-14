# REPORT.md — CyberNetServerWeb (`cybernetserverweb`, `cnsw`, `0x00FD`)

**Studio:** ConsciousNode SoftWorks · **License:** MIT · **Protocol:** StudioNet 1.0 (`BroadcastChannel("studionet-v1")`)

---

## 1. What Was Built

1. **`cybernetserverweb.html` (`1469644` bytes, single-file offline HTML):**
   - **Clean-room StudioNet 1.0 Host Stack (`window.CNSW`):** Written from `studionet/STUDIONET-1.0.md` without importing or copying `studionet-ref.js`:
     - **L1 Frame Layer:** 16-byte little-endian header (`dst, src, proto, flags, sport, dport, seq, ack, len`) with 0..480-byte payload validation (`short`, `long`, `len>480`, `len mismatch`).
     - **L2 SNS & Naming (`proto = 1`, port `53`):** `HELLO` (`op = 1`, `kind = 4` server, `os = 3` host), `WHO` (`op = 2`), `BYE` (`op = 3`), live/stale peer directory (`>= 8` entries, up to 16 entries with least-recently-seen eviction), duplicate node ID clash detection (`NODE ID CLASH` warning banner without silent node ID renumbering), and `CnswNamingEngine` implementing the join-order, extrapolated `age`, random `token` tiebreaker, and `cnsw1`/`cnsw2` numbering rules.
     - **Echo Responder (`proto = 2`, port `7`):** Replies to `SDP` `PSH` frames on port `7` with `ACK` (`flags = 2`), `ack = (seq + 1) & 0xFFFF`, and identical payload bytes.
     - **L3 SRRP Server (`proto = 3`, port `80`):** Supports `GET`, `PUT`, `POST`, `LIST`, and `DEL`, advertising `Window: 16` and `Max-Size`, cumulative ACK + 16-bit SACK bitmap + window advertisement in every 3-byte ACK payload, adaptive sender congestion window (`cwnd` starting at `2`, growing by `1` per ACKed window up to peer `Window`, halving on timeout), fast selective resend after 3 later SACKed frames, timeout failure after 5 unprogressed retries, first-frame `413 TOO BIG` refusal before body transfer, path traversal refusal (`403 FORBIDDEN` on `..`), and legacy 1-frame SpiralHttpd (`GET /path` without `SRRP/1` -> single `ACK|PSH` frame `<= 480` B).
     - **L0 Bridge Envelope Codec (`SNB1`):** 13-byte header (`"SNB1"`, `hop` u8, `origin` u32 LE, `CRC-32` u32 LE) with loop guard (`own origin`), hop limit (`hop >= 4`), and CRC-32 verification.
   - **Pages (`/www`) & Vanta Integration:**
     - Lifts Vanta (`vanta/index.html:634-8980`) and Convergence's SpiralOS palette and snapshot downsampler (`convergence/convergence.html:12809-13176`).
     - Every page request renders live through `vanta.render(html, css)` at an `800×600` viewport with zero precomputation:
       - `GET /path` (`Accept: text/hts` or default SRRP GET): derives a SpiralWeb-subset projection (`<h1>`, `<p>`, `<hr>`, `<a href>`, and `POST` form descriptors) strictly from Vanta's parsed `document` and laid-out `boxes` in visual reading order `(b.y, b.x)`.
       - `GET /snap/path?fmt=spiral`: produces `15,360` bytes (`160×96` 8-bit SpiralOS palette indices), byte-identical to Convergence's gateway output.
       - `GET /snap/path?fmt=t3`: produces `32,004` bytes (`Type: image/t3-snap`, `Encoding: trytes16`: `width = 160` u16 LE, `height = 100` u16 LE, followed by `16,000` signed 16-bit LE trytes in `-364..+364` quantized into Triton's 729-color 6-trit balanced palette).
   - **Files (`/files`, `/inbox`, `/share`):**
     - `PUT /files/<name>`, `LIST /files`, `GET /files/<name>`, and `DEL /files/<name>` backed by IndexedDB.
     - Enforces §4.3 filename rules (`/^[A-Za-z0-9._-]{1,31}$/`, no `..` or `/`), configurable per-file cap (default `1,048,576` B = 1 MB -> `413 TOO BIG`) and total quota cap (default `67,108,864` B = 64 MB -> `507 FULL`).
     - Preserves stored `Encoding` (`bytes` or `trytes16`) and serves uploaded files strictly as stored data using a fixed extension whitelist (`.txt`, `.md`, `.json`, `.csv`, `.png`, `.jpg`/`.jpeg`, `.gif`, `.t3`, `.pic`; all other extensions including `.html` map to `application/octet-stream` and are never executed or rendered).
   - **MiniPedia (`/minipedia`):**
     - Serves the 15 built-in MIT articles from `minipedia-cnsw.json` (by Kehai Interim, ConsciousNode SoftWorks) stored in IndexedDB `minipedia_mit`.
     - Provides `/minipedia` index, `POST /minipedia/search` (ranking exact title matches first, then title prefix/substring, then body frequency), `/minipedia/random`, and `/minipedia/license`.
     - Provides a streaming Wikipedia abstract XML importer (`*-abstract.xml`: `<doc><title>`, `<url>`, `<abstract>`) with a configurable article cap (default `1,000`), storing imported entries exclusively in `minipedia_wiki` with source URL and `"Text from Wikipedia, CC BY-SA 4.0"` on every page and exporting MIT vs. CC BY-SA 4.0 stores separately.
   - **Chat Jeepy Tea (`/chat`):**
     - Lifts only the RWKV World vocabulary (`pip-suite/pips-room.html:1329-1329`), RWKV-7 inference engine and GGUF/Safetensors/PTH loader (`pip-suite/pips-room.html:1331-2075`), tokenizer/repetition helper (`pip-suite/pips-room.html:3880-3912`), `sampleLogits` (`pip-suite/pips-room.html:4342-4392`), and the user-discretion note (`pip-suite/pips-room.html:1122-1122`), omitting soul, living memory, dreams, journal, thoughts, and resident identity.
     - Shows `No model loaded.` when no model is loaded (zero fabricated or canned replies).
     - Displays exact model name, parameter count, and quantization read from the GGUF header, streams tokens asynchronously on `POST /chat` (`q=...&conv=<id>`), serves incremental tokens in order on `GET /chat/<id>?after=<n>` with `(thinking…)` until completion, and returns `503 BUSY` (`Retry-After: 1`) on concurrent generation requests.
   - **Landing Page (`/`) & Operator Panel:**
     - Displays inline `cnsw-mark.svg` and `cnsw-lockup.svg`, links to `/minipedia`, `/chat`, `/files`, and `sonder.gw` (when `0x00FE` / `sonder.gw` is live in the peer table), live peer table, traffic counters, and a 500-frame log exportable as JSON.

---

## 2. Printed Test Output (Copied Verbatim)

### 2.1 `node studionet/selftest.js` (`logs/selftest.log`)

```text
PASS 1a frame round trip
PASS 1b short frame refused
PASS 1c len mismatch refused
PASS 1d 481-byte payload refused by encoder
PASS 2a HELLO round trip
PASS 2b WHO round trip
PASS 2c BYE
PASS 2d bad name refused
PASS 2e display names
PASS 3a lone core keeps plain name
PASS 3b three in join order -> hb1 hb2 hb3 — {"201":"hb1","202":"hb2","203":"hb3"}
PASS 3c numbers do not shift when hb1 leaves — {"202":"hb2","203":"hb3"}
PASS 3d newcomer takes lowest free (hb1) — {"202":"hb2","203":"hb3","204":"hb1"}
PASS 3e base name resolves to lowest number
PASS 3f tie (same age) -> lower token is tri1 — {"301":"tri2","302":"tri1"}
PASS 3g control: without tokens the tie resolves differently — {"301":"tri1","302":"tri2"}
PASS 3h LAN merge: older hb1 keeps it, no duplicates — {"before":{"201":"hb1","202":"hb2","211":"hb1","212":"hb2"},"after":{"201":"hb1","202":"hb2","211":"hb3","212":"hb4"}}
PASS 3i chosen-name clash -> older keeps it, other gets toshiba2 — {"101":"toshiba","201":"toshiba2"}
PASS 4a request round trip
PASS 4b response round trip
PASS 4c legacy "GET /" detected
PASS 4d Size mismatch refused
PASS 4e trytes16 round trip
PASS 4f unsafe names refused
PASS 4g POST form submit parses
PASS 5a 64 KB clean link — frames sent 137, resent 0, max window 8, seq wrapped through 65535
PASS 5b 64 KB with 5% drop, 3% duplicates, reordering — dropped 12, dups 10, resent 26, timeouts 10, rx duplicates 22
PASS 5c 3 KB with 20% drop — resent 7
PASS 5d one-frame message (SYN|PSH|FIN)
PASS 5e SACK cuts resends (control: SACK bitmap zeroed) — with SACK 32 resends (19 drops); without 42
PASS 5f timeout halves window — cwnd 4
PASS 5g gives up after 5 timeouts without progress
PASS 5h oversize PUT refused at the first frame (413)
PASS 6a envelope round trip
PASS 6b corrupted frame dropped by CRC (positive control)
PASS 6c own origin dropped (loop guard)
PASS 6d hop limit
PASS 6e CRC-32 known answer ("123456789" = 0xCBF43926)

ALL PASS
```

### 2.2 `node tests/cnsw-test.js` (`logs/cnsw-test.log`)

```text
================================================================
CyberNetServerWeb — Full 10-Suite Verification Harness
================================================================
PASS [9] 9a strict CSP meta tag present
PASS [9] 9b no network APIs except BroadcastChannel — BroadcastChannel only
PASS [9] 9c storage only through IndexedDB
PASS [9] 9d studionet-ref.js not present in server page
PASS [9] 9e all 10 inline lifted blocks labeled and SHA-256 byte-identical to source — 10/10 blocks matched
PASS [1] 1a Golden produce vectors (7/7 field & byte exact) — 7/7
PASS [1] 1b Golden parse vectors (5/5 accept/reject exact) — 5/5
PASS [1] 1c Golden SRRP vectors & server responses (6/6) — 6/6
PASS [1] 1d Golden multi-frame SACK transfer vectors (2/2) — 2/2
PASS [1] 1e Golden naming vectors (5/5) — 5/5
PASS [1] 1f Golden SNB1 bridge envelope vector (1/1)
PASS [2] 2a Differential PUT/LIST/GET/DEL 1KB (1024 B) over fault-injecting BroadcastChannel — byte-identical=true, dropped=0, dups=0, reordered=15, resends=2, timeouts=1
PASS [2] 2a Differential PUT/LIST/GET/DEL 64KB (65536 B) over fault-injecting BroadcastChannel — byte-identical=true, dropped=18, dups=10, reordered=284, resends=32, timeouts=21
PASS [2] 2a Differential PUT/LIST/GET/DEL 1MB (1048576 B) over fault-injecting BroadcastChannel — byte-identical=true, dropped=116, dups=114, reordered=2645, resends=737, timeouts=2
PASS [2] 2b Differential POST /minipedia/search over fault-injecting BroadcastChannel
PASS [2] 2c Positive control: 100% frame loss gives TIMEOUT on client — state=TIMEOUT, timeouts=6
PASS [2] 2d Positive control: oversize PUT gives 413 TOO BIG at the first frame before body — status=413, clientFramesSent=1
PASS [2] 2e Positive control: ../x path traversal gives 403 FORBIDDEN — status=403
PASS [2] 2f Positive control: zeroed SACK bitmap still completes but requires more resends — with SACK resends=9 (timeouts=5) vs zeroed SACK resends=25 (timeouts=9)
PASS [3] 3a Two server tabs come up as cnsw1 and cnsw2 in join order — tab1=cnsw1, tab2=cnsw2
PASS [4] 4a Monkey-patching Vanta layout (+1 px box shift) changes snapshot
PASS [4] 4b Monkey-patching Vanta parser (dropping 1 element) changes projection accordingly
PASS [4] 4c Page with CSS-only differences produces different snapshots but identical projection
PASS [5] 5a /snap?fmt=spiral bytes equal Convergence gateway lift byte-for-byte (15,360 B) — bytes=15360
PASS [5] 5b /snap?fmt=t3 returns Type: image/t3-snap, 160x100 u16 header, and 16,000 trytes16 in -364..+364 (32,004 B) — bytes=32004
PASS [6] 6a All 15 built-in MIT MiniPedia articles served with byline — 15/15 served
PASS [6] 6b MiniPedia search ranks exact title match first
PASS [6] 6c 1,000-article synthetic dump streaming import honors cap, shows CC BY-SA 4.0 + URL on every page, and MIT export has 0 imported articles — imported=1000, mitExport=15 (0 wiki), wikiExport=1000
PASS [7] 7a With no model loaded, /chat says "No model loaded."
PASS [7] 7b Tiny random GGUF model generates tokens, polling returns them in order, and concurrent request gets 503 BUSY — tokens=[62731,64748,56898,20589,59313,52273], 2ndStatus=503 BUSY (Retry-After: 1)
PASS [7] 7c Model info shown on /chat matches GGUF file header exactly — name=tiny-rwkv7-test-v1, nParams=8447360, quant=F32
PASS [7] 7d Lifted RWKV-7 engine SHA-256 matches pips-room.html:1331-2075 — sha256=a2cbb55b6974d14e848330e7b90790e94e616ab9ef8dd1197118b59ef675bc0a
PASS [8] 8a Files round trip at 1 B, 480 B, and 1 MB (1,048,576 B) — ["1B:true","480B:true","1048576B:true"]
PASS [8] 8b Total storage quota exceeded returns 507 FULL
PASS [8] 8c Extension whitelist MIME types enforced and uploaded .html served as raw data (never rendered)
PASS [10] 10a Real browser loads cybernetserverweb.html with 0 page/console errors — pageErrors=0, consoleErrors=0
PASS [10] 10b Server (0x00FD) and two reference client tabs (0x0101, 0x0201) all see each other in peers — serverPeers=[{"node":257,"name":"tabcomp"},{"node":513,"name":"hummingbird"}], peer1Peers=[{"node":513,"name":"hummingbird"},{"node":253,"name":"cnsw1"}], peer2Peers=[{"node":253,"name":"cnsw1"},{"node":257,"name":"tabcomp"}]
================================================================
SUMMARY: 37/37 PASS (0 FAIL)
================================================================
```

---

## 3. Unmet Requirements & External Consultations

- **Unmet requirements:** None. All requirements in `PROMPT.md` and `studionet/STUDIONET-1.0.md` are met and exercised by the 10 test suites above.
- **Consulted besides attachments:** Nothing. Only the files in the attached `cybernetserverweb.zip` archive were consulted.

---

## 4. IndexedDB Schema & Wire/Data Formats

### 4.1 IndexedDB Schema (`cybernetserverweb_db`, version `1`)

| Object Store | `keyPath` | Record Schema | Purpose |
|---|---|---|---|
| `www` | `path` | `{ path: string, html: string, css: string, updatedAt: number }` | Editable intranet pages under `/www`. |
| `files` | `name` | `{ name: string, data: Uint8Array, size: number, encoding: "bytes"\|"trytes16", type: string, updatedAt: number }` | Uploaded files under `/files/<name>` (never executed). |
| `inbox` | `name` | `{ name: string, data: Uint8Array, size: number, encoding: "bytes"\|"trytes16", type: string, updatedAt: number }` | Peer-pushed files under `/inbox/<name>`. |
| `minipedia_mit` | `slug` | `{ slug: string, title: string, text: string, byline: string, license: "MIT" }` | 15 built-in MIT studio articles from `minipedia-cnsw.json`. |
| `minipedia_wiki` | `slug` | `{ slug: string, title: string, url: string, text: string, license: "CC BY-SA 4.0", attribution: "Text from Wikipedia, CC BY-SA 4.0", importedAt: number }` | Streaming-imported Wikipedia abstracts, isolated from `minipedia_mit`. |
| `chat_convs` | `id` | `{ id: string, turns: Array<{ user, reply, tokens, tokenStrings, done, startedAt }>, done: boolean, updatedAt: number }` | Chat Jeepy Tea conversation transcripts and token streams. |
| `config` | `key` | `{ key: string, value: any }` | Persisted operator settings (`maxFileBytes`, `maxTotalBytes`, `wikiCap`, `shareEnabled`). |

### 4.2 Formats Chosen

1. **Projection (`Accept: text/hts`, `Type: text/hts`, `Encoding: bytes`):**
   - UTF-8 SpiralWeb-subset markup (`<h1>`, `<p>`, `<hr>`, `<a href="...">`, and `<p><a href="POST:...">POST ...</a></p>` for forms) derived in visual reading order `(b.y, b.x)` from Vanta's `vantaRes.document` and `vantaRes.boxes`, terminated with a Vanta DOM structural digest `<p>vanta:<elCount>:<fnv1a32Hex></p>`.
2. **SpiralOS Snapshot (`GET /snap/<path>?fmt=spiral`, `Type: image/spiral-snap`, `Encoding: bytes`):**
   - `15,360` bytes (`160 × 96` 8-bit palette indices into `SPIRAL_PALETTE_RGB` at `0x0FFA00`), produced by Convergence's lifted `buildSnapshotFromVanta` downsampler (`4×4` Bayer ordered dithering + peak-contrast preservation).
3. **Triton T3 Snapshot (`GET /snap/<path>?fmt=t3`, `Type: image/t3-snap`, `Encoding: trytes16`):**
   - `32,004` bytes: `width` u16 LE (`160` = `0x00A0`), `height` u16 LE (`100` = `0x0064`), followed by `16,000` pixels encoded as signed 16-bit LE `trytes16` in `-364..+364` ($r_9 \cdot 81 + g_9 \cdot 9 + b_9$ where $r_9, g_9, b_9 \in [-4, +4]$).
4. **Chat Stream Polling (`GET /chat/<id>?after=<n>`):**
   - Returns `Type: text/hts` projection containing the conversation transcript, `Tokens[n..total]`, `TokenIDs`, and `(thinking…)` while generation is active, accompanied by SRRP headers `X-Chat-Done: 0|1`, `X-Chat-Tokens: <total>`, `X-Chat-Slice: <text>`, and `X-Chat-Token-Ids: <csv>`.
