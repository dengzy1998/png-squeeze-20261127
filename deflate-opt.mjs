// deflate-opt.mjs — a zopfli-style optimal-parsing DEFLATE encoder in pure JS.
//
// Pipeline: greedy lazy parse (initial token frequencies) -> Huffman code
// lengths -> optimal-parse dynamic programming with those bit costs ->
// re-estimate frequencies, rebuild lengths, parse again -> emit the token
// stream as dynamic-Huffman blocks (split every 256 KiB of input), and
// keep whichever of dynamic / fixed Huffman is smaller. Falls back to the
// caller's zlib stream whenever this one is not smaller (the caller compares).
//
// Deterministic: fixed chain caps, fixed iteration counts, no clock, no
// environment, no randomness. Match search is hash-chained over a 32 KiB
// window, exactly like DEFLATE requires.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// Symbol tables for lengths 3..258 and distances 1..32768. Length symbols
// reach 285, so LEN_SYM needs 16 bits.
const LEN_SYM = new Uint16Array(259);
const LEN_EB = new Uint8Array(259);
const LEN_EV = new Uint16Array(259);
for (let len = 3; len <= 258; len++) {
  let s = 0;
  while (s < 28 && LEN_BASE[s + 1] <= len) s++;
  LEN_SYM[len] = 257 + s;
  LEN_EB[len] = LEN_EXTRA[s];
  LEN_EV[len] = len - LEN_BASE[s];
}
const DIST_SYM = new Uint8Array(32769);
const DIST_EB = new Uint8Array(32769);
const DIST_EV = new Uint16Array(32769);
for (let dist = 1; dist <= 32768; dist++) {
  let s = 0;
  while (s < 29 && DIST_BASE[s + 1] <= dist) s++;
  DIST_SYM[dist] = s;
  DIST_EB[dist] = DIST_EXTRA[s];
  DIST_EV[dist] = dist - DIST_BASE[s];
}

// ---------------------------------------------------------------- bit writer
class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  // Write the low `count` bits of `value`, least-significant bit first.
  write(value, count) {
    this.acc |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  // Write a Huffman code (stored MSB-first), most-significant bit first.
  writeCode(code, len) {
    let r = 0;
    for (let i = 0; i < len; i++) r = (r << 1) | ((code >>> i) & 1);
    this.write(r, len);
  }
  finish() {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------- Huffman
// Optimal code lengths (max `maxLen` bits) for `freq` counts: the classic
// Huffman tree build, capped at `maxLen` with a Kraft repair when the tree
// runs deeper (degenerate distributions only).
function buildLengths(freq, maxLen) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  // Huffman tree: repeatedly merge the two least frequent nodes.
  let nodes = syms.map((s) => ({ freq: freq[s], sym: s, left: null, right: null }));
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.freq - b.freq || (a.sym ?? 1e9) - (b.sym ?? 1e9));
    const a = nodes.shift();
    const b = nodes.shift();
    nodes.push({ freq: a.freq + b.freq, sym: null, left: a, right: b });
  }
  const assign = (node, depth) => {
    if (node.sym !== null) lengths[node.sym] = depth;
    else {
      assign(node.left, depth + 1);
      assign(node.right, depth + 1);
    }
  };
  assign(nodes[0], 0);
  let max = 0;
  for (const s of syms) if (lengths[s] > max) max = lengths[s];
  if (max <= maxLen) return lengths;
  // Limit lengths: cap at maxLen, then repair the Kraft sum with integer
  // arithmetic (kraft = sum of 2^(maxLen - len), complete when it equals
  // 2^maxLen). Lengthening the least frequent code fixes over-subscription;
  // shortening the most frequent code that fits completes an incomplete
  // code — the code-length code must be complete, or inflate rejects it.
  // This only triggers for degenerate distributions (plain Huffman already
  // fits otherwise), and it always terminates: the alphabets here hold far
  // fewer symbols than 2^maxLen, and the smallest lengthening/shortening
  // step always fits the remaining gap.
  for (const s of syms) if (lengths[s] > maxLen) lengths[s] = maxLen;
  const FULL = 1 << maxLen;
  let kraft = 0;
  for (const s of syms) kraft += 1 << (maxLen - lengths[s]);
  while (kraft > FULL) {
    let best = -1;
    let bestFreq = Infinity;
    for (const s of syms) {
      if (lengths[s] < maxLen && freq[s] < bestFreq) {
        bestFreq = freq[s];
        best = s;
      }
    }
    if (best < 0) break; // cannot happen for our alphabets
    kraft -= 1 << (maxLen - lengths[best] - 1);
    lengths[best]++;
  }
  while (kraft < FULL) {
    let best = -1;
    let bestFreq = -1;
    let bestInc = 0;
    for (const s of syms) {
      if (lengths[s] > 1) {
        const inc = 1 << (maxLen - lengths[s]);
        if (kraft + inc <= FULL && freq[s] > bestFreq) {
          bestFreq = freq[s];
          best = s;
          bestInc = inc;
        }
      }
    }
    if (best < 0) break; // cannot happen: the smallest step always fits
    lengths[best]--;
    kraft += bestInc;
  }
  return lengths;
}

function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const next = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l) {
      codes[s] = next[l];
      next[l]++;
    }
  }
  return codes;
}

// ---------------------------------------------------------------- matcher
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;

// 3-byte hash into 2^15 buckets.
function hash3(d, i) {
  return (((d[i] << 16) ^ (d[i + 1] << 8) ^ d[i + 2]) * 2654435761) >>> (32 - HASH_BITS);
}

class Matcher {
  constructor(data) {
    this.d = data;
    this.n = data.length;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(data.length).fill(-1);
    this.next = 0; // next position to insert
    // Records: the (length, distance) pairs at which a new longest match
    // was found during the last find(), in increasing length order. These
    // are exactly the longest length of each distance class, so the DP
    // only needs these few transitions instead of scanning every length.
    this.recLen = new Int16Array(259);
    this.recDist = new Int32Array(259);
    this.recCount = 0;
  }
  insert(pos) {
    if (pos + 2 >= this.n) return;
    const h = hash3(this.d, pos);
    this.prev[pos] = this.head[h];
    this.head[h] = pos;
  }
  // Insert every position below `pos` not yet inserted.
  ensure(pos) {
    while (this.next < pos) {
      this.insert(this.next);
      this.next++;
    }
  }
  // Longest match at `pos` (length, distance, and the closest distance
  // achieving a match of length >= 3, or 0 when there is none). Also fills
  // this.records: the chain is walked in increasing distance order, so the
  // first candidate to reach a length L is the closest one achieving it.
  // Like zlib's longest_match, the chain is cut short once a match of at
  // least `goodLen` is found (a quarter of the chain remains) and stops
  // outright at `niceLen`: deep chains stay fast on flat data, where the
  // first candidate already gives a near-maximal match. (Both default to
  // 258, i.e. no cut, which is what the DP passes use.)
  find(pos, maxChain, goodLen = 258, niceLen = 258) {
    const d = this.d;
    const n = this.n;
    this.recCount = 0;
    if (pos + 3 > n) return [0, 0, 0];
    const maxLen = Math.min(258, n - pos);
    const h = hash3(d, pos);
    let cand = this.head[h];
    let bestLen = 2;
    let bestDist = 0;
    let len3dist = 0;
    const limit = pos - 32768;
    let chain = 0;
    let chainLimit = maxChain;
    while (cand > limit && cand >= 0 && chain++ < chainLimit) {
      const dist = pos - cand;
      if (d[cand] === d[pos] && d[cand + 1] === d[pos + 1] && d[cand + 2] === d[pos + 2]) {
        if (len3dist === 0) len3dist = dist;
        if (bestLen < 3 || d[cand + bestLen] === d[pos + bestLen]) {
          let len = 3;
          while (len < maxLen && d[cand + len] === d[pos + len]) len++;
          if (len > bestLen) {
            this.recLen[this.recCount] = len;
            this.recDist[this.recCount] = dist;
            this.recCount++;
            bestLen = len;
            bestDist = dist;
            if (len >= niceLen || len === maxLen) break;
            if (len >= goodLen) chainLimit = Math.min(chainLimit, chain + (maxChain >> 2));
          }
        }
      }
      cand = this.prev[cand];
    }
    return [bestLen, bestDist, len3dist];
  }
}

// Token stream: parallel arrays. kind 0 = literal (a = byte), 1 = match
// (a = length, b = distance). pos[i] is the input offset of token i.
class Tokens {
  constructor() {
    this.kind = [];
    this.a = [];
    this.b = [];
    this.pos = [];
  }
  literal(p, byte) {
    this.kind.push(0);
    this.a.push(byte);
    this.b.push(0);
    this.pos.push(p);
  }
  match(p, len, dist) {
    this.kind.push(1);
    this.a.push(len);
    this.b.push(dist);
    this.pos.push(p);
  }
  get length() {
    return this.kind.length;
  }
}

function collectFreqs(toks, litFreq, distFreq) {
  litFreq.fill(0);
  distFreq.fill(0);
  for (let i = 0; i < toks.length; i++) {
    if (toks.kind[i] === 0) litFreq[toks.a[i]]++;
    else {
      litFreq[LEN_SYM[toks.a[i]]]++;
      distFreq[DIST_SYM[toks.b[i]]]++;
    }
  }
}

// Greedy lazy parse: at each position compare the match here with the match
// one byte on; take the longer one. Returns tokens.
function greedyParse(data, chain) {
  const m = new Matcher(data);
  const toks = new Tokens();
  const n = data.length;
  let i = 0;
  while (i < n) {
    m.ensure(i);
    const [len1, dist1] = m.find(i, chain);
    if (len1 >= 3 && i + 1 < n) {
      m.ensure(i + 1);
      const [len2] = m.find(i + 1, chain);
      if (len2 > len1) {
        toks.literal(i, data[i]);
        i++;
        continue;
      }
    }
    if (len1 >= 3) {
      toks.match(i, len1, dist1);
      i += len1;
    } else {
      toks.literal(i, data[i]);
      i++;
    }
  }
  return toks;
}

// Optimal parse by dynamic programming with per-symbol bit costs.
function dpParse(data, chain, litCost, lenCost, distCost) {
  const m = new Matcher(data);
  const n = data.length;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choiceLen = new Int16Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    m.ensure(i);
    const [len, dist, len3dist] = m.find(i, chain);
    const lc = c + litCost[data[i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      choiceLen[i + 1] = 0;
    }
    if (len >= 3) {
      // One transition per distance class: the longest length at that
      // distance (the records from find(), longest first), plus the len-3
      // match at the closest distance for alignment.
      for (let r = m.recCount - 1; r >= 0; r--) {
        const l = m.recLen[r];
        const dd = m.recDist[r];
        const cc = c + lenCost[l] + distCost[dd];
        if (cc < cost[i + l]) {
          cost[i + l] = cc;
          choiceLen[i + l] = l;
          choiceDist[i + l] = dd;
        }
      }
      if (len3dist !== 0) {
        const c3 = c + lenCost[3] + distCost[len3dist];
        if (c3 < cost[i + 3]) {
          cost[i + 3] = c3;
          choiceLen[i + 3] = 3;
          choiceDist[i + 3] = len3dist;
        }
      }
    }
  }
  const toks = new Tokens();
  let i = n;
  const rev = [];
  while (i > 0) {
    const l = choiceLen[i];
    if (l === 0) {
      rev.push([0, data[i - 1], 0, i - 1]);
      i--;
    } else {
      rev.push([1, l, choiceDist[i], i - l]);
      i -= l;
    }
  }
  rev.reverse();
  for (const [kind, a, b, p] of rev) {
    if (kind === 0) toks.literal(p, a);
    else toks.match(p, a, b);
  }
  return toks;
}

// Bit costs of every literal/length symbol and every distance, from code
// lengths: cost[sym] = length + extra bits of the value it stands for.
function symbolCosts(litLens, distLens) {
  const litCost = new Float64Array(286);
  for (let s = 0; s < 256; s++) litCost[s] = litLens[s];
  const lenCost = new Float64Array(259);
  for (let len = 3; len <= 258; len++) lenCost[len] = litLens[LEN_SYM[len]] + LEN_EB[len];
  const distCost = new Float64Array(32769);
  for (let dist = 1; dist <= 32768; dist++) distCost[dist] = distLens[DIST_SYM[dist]] + DIST_EB[dist];
  return { litCost, lenCost, distCost };
}

// ---------------------------------------------------------------- emit
const FIXED_LIT_LENS = (() => {
  const l = new Uint8Array(288);
  for (let s = 0; s < 144; s++) l[s] = 8;
  for (let s = 144; s < 256; s++) l[s] = 9;
  for (let s = 256; s < 280; s++) l[s] = 7;
  for (let s = 280; s < 288; s++) l[s] = 8;
  return l;
})();
const FIXED_DIST_LENS = new Uint8Array(30).fill(5);
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Write one dynamic-Huffman block's header + tokens.
function emitDynamicBlock(w, toks, from, to, litLens, litCodes, distLens, distCodes) {
  // Trim the alphabets to their last used symbol.
  let hlit = 257;
  for (let s = 286; s >= 257; s--) if (litLens[s]) { hlit = s + 1; break; }
  let hdist = 1;
  for (let s = 29; s >= 0; s--) if (distLens[s]) { hdist = s + 1; break; }
  // The code-length sequence, run-length encoded.
  const seq = [];
  for (let s = 0; s < hlit; s++) seq.push(litLens[s]);
  for (let s = 0; s < hdist; s++) seq.push(distLens[s]);
  const clFreq = new Uint32Array(19);
  const items = []; // [symbol, extraValue, extraBits]
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    if (v === 0) {
      let run = 1;
      while (i + run < seq.length && seq[i + run] === 0 && run < 138) run++;
      if (run >= 11) {
        items.push([18, run - 11, 7]);
        clFreq[18]++;
      } else if (run >= 3) {
        items.push([17, run - 3, 3]);
        clFreq[17]++;
      } else {
        for (let k = 0; k < run; k++) {
          items.push([0, 0, 0]);
          clFreq[0]++;
        }
      }
      i += run;
    } else {
      items.push([v, 0, 0]);
      clFreq[v]++;
      // run = total consecutive occurrences of v starting at i (1..6).
      // Symbol 16 repeats the previous length (run - 1) more times, where
      // run - 1 is 3..6, so its extra value is (run - 1) - 3 = run - 4.
      let run = 1;
      while (i + run < seq.length && seq[i + run] === v && run < 6) run++;
      if (run >= 4) {
        items.push([16, run - 4, 2]);
        clFreq[16]++;
        i += run;
      } else i++;
    }
  }
  // A code-length code needs at least two symbols for a complete code.
  let used = 0;
  for (let s = 0; s < 19; s++) if (clFreq[s]) used++;
  if (used === 1) {
    for (let s = 0; s < 19; s++) {
      if (!clFreq[s]) {
        clFreq[s] = 1;
        break;
      }
    }
  }
  const clLens = buildLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLens);
  let hclen = 4;
  for (let k = 18; k >= 4; k--) {
    if (clLens[CL_ORDER[k]]) {
      hclen = k + 1;
      break;
    }
  }
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.write(clLens[CL_ORDER[k]], 3);
  for (const [sym, ev, eb] of items) {
    w.writeCode(clCodes[sym], clLens[sym]);
    if (eb) w.write(ev, eb);
  }
  for (let t = from; t < to; t++) {
    if (toks.kind[t] === 0) {
      w.writeCode(litCodes[toks.a[t]], litLens[toks.a[t]]);
    } else {
      const len = toks.a[t];
      const dist = toks.b[t];
      const ls = LEN_SYM[len];
      w.writeCode(litCodes[ls], litLens[ls]);
      if (LEN_EB[len]) w.write(LEN_EV[len], LEN_EB[len]);
      const ds = DIST_SYM[dist];
      w.writeCode(distCodes[ds], distLens[ds]);
      if (DIST_EB[dist]) w.write(DIST_EV[dist], DIST_EB[dist]);
    }
  }
  w.writeCode(litCodes[256], litLens[256]);
}

// Write the tokens as fixed-Huffman blocks (one block for the whole stream).
function emitFixed(w, toks) {
  const litCodes = canonicalCodes(FIXED_LIT_LENS);
  const distCodes = canonicalCodes(FIXED_DIST_LENS);
  w.write(1, 1); // BFINAL
  w.write(1, 2); // BTYPE = 01 fixed
  for (let t = 0; t < toks.length; t++) {
    if (toks.kind[t] === 0) {
      w.writeCode(litCodes[toks.a[t]], FIXED_LIT_LENS[toks.a[t]]);
    } else {
      const len = toks.a[t];
      const dist = toks.b[t];
      const ls = LEN_SYM[len];
      w.writeCode(litCodes[ls], FIXED_LIT_LENS[ls]);
      if (LEN_EB[len]) w.write(LEN_EV[len], LEN_EB[len]);
      const ds = DIST_SYM[dist];
      w.writeCode(distCodes[ds], 5);
      if (DIST_EB[dist]) w.write(DIST_EV[dist], DIST_EB[dist]);
    }
  }
  w.writeCode(litCodes[256], FIXED_LIT_LENS[256]);
}

// Emit the token stream as dynamic blocks of at most BLOCK bytes of input.
const BLOCK_INPUT = 262144;

function emitDynamic(toks) {
  const w = new BitWriter();
  // Block boundaries by input offset.
  const bounds = [0];
  for (let t = 0; t < toks.length; t++) {
    if (toks.pos[t] - toks.pos[bounds[bounds.length - 1]] >= BLOCK_INPUT && t > bounds[bounds.length - 1]) bounds.push(t);
  }
  bounds.push(toks.length);
  for (let b = 0; b < bounds.length - 1; b++) {
    const from = bounds[b];
    const to = bounds[b + 1];
    const last = b === bounds.length - 2;
    w.write(last ? 1 : 0, 1); // BFINAL
    w.write(2, 2); // BTYPE = 10 dynamic
    const litFreq = new Uint32Array(286);
    const distFreq = new Uint32Array(30);
    for (let t = from; t < to; t++) {
      if (toks.kind[t] === 0) litFreq[toks.a[t]]++;
      else {
        litFreq[LEN_SYM[toks.a[t]]]++;
        distFreq[DIST_SYM[toks.b[t]]]++;
      }
    }
    litFreq[256]++; // end of block
    // A distance alphabet with a single symbol needs a second code.
    let distUsed = 0;
    let firstDist = -1;
    for (let s = 0; s < 30; s++) {
      if (distFreq[s]) {
        distUsed++;
        if (firstDist < 0) firstDist = s;
      }
    }
    if (distUsed === 0) {
      distFreq[0] = 1;
      distFreq[1] = 1;
    } else if (distUsed === 1) {
      distFreq[firstDist === 0 ? 1 : 0] = 1;
    }
    const litLens = buildLengths(litFreq, 15);
    const distLens = buildLengths(distFreq, 15);
    emitDynamicBlock(w, toks, from, to, litLens, canonicalCodes(litLens), distLens, canonicalCodes(distLens));
  }
  return w.finish();
}

// ---------------------------------------------------------------- top level
// Optimal-parse DEFLATE of `data` as a zlib stream. `iters` counts the DP
// passes after the greedy first pass. Returns null when the input is empty.
export function deflateOptimal(data, iters = 3, greedyChain = 512, dpChain = 256) {
  if (data.length === 0) return null;
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  let toks = greedyParse(data, greedyChain);
  collectFreqs(toks, litFreq, distFreq);
  litFreq[256]++;
  let distUsed = 0;
  for (let s = 0; s < 30; s++) if (distFreq[s]) distUsed++;
  if (distUsed === 0) {
    distFreq[0] = 1;
    distFreq[1] = 1;
  }
  for (let it = 0; it < iters; it++) {
    const litLens = buildLengths(litFreq, 15);
    const distLens = buildLengths(distFreq, 15);
    const { litCost, lenCost, distCost } = symbolCosts(litLens, distLens);
    toks = dpParse(data, dpChain, litCost, lenCost, distCost);
    collectFreqs(toks, litFreq, distFreq);
    litFreq[256]++;
    distUsed = 0;
    for (let s = 0; s < 30; s++) if (distFreq[s]) distUsed++;
    if (distUsed === 0) {
      distFreq[0] = 1;
      distFreq[1] = 1;
    }
  }
  const dynamic = emitDynamic(toks);
  const wFixed = new BitWriter();
  emitFixed(wFixed, toks);
  const fixed = wFixed.finish();
  const body = dynamic.length <= fixed.length ? dynamic : fixed;
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  const ad = adler32(data);
  out[2 + body.length] = (ad >>> 24) & 0xff;
  out[2 + body.length + 1] = (ad >>> 16) & 0xff;
  out[2 + body.length + 2] = (ad >>> 8) & 0xff;
  out[2 + body.length + 3] = ad & 0xff;
  return out;
}
