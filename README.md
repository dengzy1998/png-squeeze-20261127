# PNG squeeze v1

Lossless PNG recompressor for 1280x720 RGBA screenshots (make.fun png-squeeze-01-run-20261127).

`main.ts` (Node 22, no dependencies) decodes each stored RGBA PNG, analyses
the pixels, and tries every exact form the image can take — palette (by count
and by luminance, with tRNS), grey, grey+alpha, RGB, RGBA, with a tRNS key
where legal — and several per-row filter strategies (fixed filters,
minimum-sum, fewest distinct byte pairs, and brute force by real deflate
size). Candidates are screened with zlib level 6; the best three are
recompressed at level 9 and the smallest wins. Only IHDR / PLTE / tRNS /
IDAT / IEND are written, bit depth 8, no interlace. Fully deterministic:
fixed work per image, no clock, no environment, no files outside
/input /output /tmp.
