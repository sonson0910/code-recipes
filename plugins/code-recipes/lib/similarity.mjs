// Fingerprints REPL scripts so the capture hook can tell when a script repeats work done in another session.
// A script becomes a set of words and word pairs (JavaScript keywords, REPL helpers and numbers left out), and a
// 64-value MinHash of that set estimates the Jaccard similarity of two scripts without keeping their code around.

const STOP = new Set((
  'await async const let var function return if else for of in new true false null undefined this typeof instanceof ' +
  'try catch finally throw while do break continue switch case default class extends import export from as delete void ' +
  'nothrow quiet throws text lines json output stdout stderr exitcode file write edit log self preview sleep cwd env timeout raw ' +
  'map filter join split slice length push includes then trim replace indexof lastindexof startswith endswith tostring ' +
  'object keys values entries promise all string number array math boolean date error console find some every reduce sort ' +
  'concat match test exec ok res result out err tools'
).split(' '));

const K = 64;

/** The words and adjacent word pairs of a script, without comments, keywords, REPL helpers or numbers. */
export function features(code) {
  const text = String(code).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const words = (text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) || []).filter((w) => w.length > 1 && !STOP.has(w));
  const set = new Set(words);
  for (let i = 1; i < words.length; i++) set.add(words[i - 1] + ' ' + words[i]);
  return set;
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function fmix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** MinHash signature of a feature set: 64 32-bit minimums, base64-encoded (344 characters). */
export function signature(feats) {
  const mins = new Uint32Array(K).fill(0xffffffff);
  for (const f of feats) {
    const a = fnv1a(f);
    const b = fmix(a ^ 0x9e3779b9) | 1;
    for (let i = 0; i < K; i++) {
      const v = fmix((a + Math.imul(i, b)) >>> 0);
      if (v < mins[i]) mins[i] = v;
    }
  }
  const buf = Buffer.alloc(K * 4);
  for (let i = 0; i < K; i++) buf.writeUInt32BE(mins[i], i * 4);
  return buf.toString('base64');
}

/** A signature as bytes, or null when it is not one (a decoded signature passes through). */
export function decodeSignature(s) {
  if (Buffer.isBuffer(s)) return s.length === K * 4 ? s : null;
  if (typeof s !== 'string') return null;
  const buf = Buffer.from(s, 'base64');
  return buf.length === K * 4 ? buf : null;
}

/** Estimated Jaccard similarity (0..1) of the scripts behind two signatures; 0 when either is not a signature. */
export function similarity(a, b) {
  const x = decodeSignature(a);
  const y = decodeSignature(b);
  if (!x || !y) return 0;
  let same = 0;
  for (let i = 0; i < K * 4; i += 4) if (x.readUInt32BE(i) === y.readUInt32BE(i)) same++;
  return same / K;
}

/** Exact Jaccard similarity of two feature sets; used by tests to check the estimate. */
export function jaccard(x, y) {
  let inter = 0;
  for (const f of x) if (y.has(f)) inter++;
  const union = x.size + y.size - inter;
  return union ? inter / union : 0;
}
