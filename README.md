# PNG squeeze v2

Lossless PNG recompressor for 1280x720 RGBA screenshots (make.fun png-squeeze-01-run-20261127).

`main.ts` (Node 22, no dependencies) decodes each stored RGBA PNG, analyses
the pixels, and tries every exact form the image can take — palette (by count
and by luminance, with tRNS), grey, grey+alpha, RGB, RGBA, with a tRNS key
where legal — and several per-row filter strategies (fixed filters,
minimum-sum, fewest distinct byte pairs, and brute force by real deflate
size). Candidates are screened with zlib level 6 and the best is kept.

The winning filtered stream is then compressed with the custom
optimal-parsing DEFLATE in `deflate-opt.mjs` — hash-chained match search,
dynamic programming over the per-length best distances, and length-limited
Huffman codes (plain Huffman tree, capped at the limit with an exact
integer-Kraft repair so the code-length code is always complete) — against
one zlib level-9 fallback; the smaller stream wins. The hash chain is 512
for the greedy first pass and 512 (small streams) or 384 (large streams)
for the DP pass, chosen to keep the whole set inside the 60s wall.

Only IHDR / PLTE / tRNS / IDAT / IEND are written, bit depth 8, no
interlace. Fully deterministic: fixed work per image, no clock, no
environment, no files outside /input /output /tmp.
