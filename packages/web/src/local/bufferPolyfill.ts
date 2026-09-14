// isomorphic-git's git-index (.git/index) code reads/writes using Node's
// global `Buffer` directly rather than an imported one. Vite doesn't
// auto-polyfill Node globals the way webpack does, so without this,
// anything that touches the index (add, commit, statusMatrix, checkout)
// throws "Buffer is not defined" in the browser. Side-effect import this
// once, before any isomorphic-git call, to make `Buffer` globally available.
import { Buffer } from "buffer";

if (!("Buffer" in globalThis)) {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
