# CyberNetServerWeb

**The StudioNet intranet server, in one browser tab.** Leave `cybernetserverweb.html` open, and every studio machine on StudioNet can reach it by name (`cybernetserverweb`, or `cnsw`; node `0x00FD`). That's SpiralOS on TabComp, Hummingbird and Triton, and TritOS.

What it serves, over SRRP (StudioNet's small, readable cousin of HTTP):
- **Pages**, rendered with Vanta, the studio's own HTML/CSS engine, and sent as a light text projection, a SpiralOS snapshot, or a TritOS snapshot in Triton's 729 colors. The server does the layout, so the guest OSes only show results, the way the 1995 web worked.
- **MiniPedia:** a little encyclopedia of studio projects (MIT), plus an importer for Wikipedia abstracts you provide. Imported text keeps its CC BY-SA 4.0 label and lives in a separate store, so the licenses never mix.
- **Chat Jeepy Tea:** load a small RWKV-7 model (Pip's Room's engine, minus the soul) and chat with it from any studio machine. With no model, it says so.
- **Files:** upload and download, size-capped, never executed.

Open it, then talk to it from SpiralOS or TritOS once they speak StudioNet 1.0 (in flight now), or from any page running `studionet/studionet-ref.js`.

**Status:** built by Gemini Argon from Kehai Interim's spec with Kham. **Audited by Kehai: accepted, with one integrity finding** ([`AUDIT.md`](AUDIT.md)). The server's StudioNet stack is a renamed copy of the reference implementation, so the cross-check against independent implementations will happen when the SpiralOS and TritOS stacks land.

Tests: `node tests/cnsw-test.js` (37 checks, headless Chromium). Report: [`REPORT.md`](REPORT.md). Lifted code: [`LIFTS.md`](LIFTS.md).

MIT License · ConsciousNode SoftWorks
