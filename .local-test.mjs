// Local test harness (not part of the entry): run main.ts on the practice
// set, score with the kit scorer, verify losslessness pixel-exactly.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const KIT = '/home/hatch/workspace/makefun/png-squeeze-01-run-20261127-kit/png-squeeze-01-run-20261127-kit';
const REPO = '/home/hatch/workspace/makefun/png-squeeze-20261127';
const OUT = join(REPO, '.local-out');
const SCORES = join(REPO, '.local-scores');

rmSync(OUT, { recursive: true, force: true });
rmSync(SCORES, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
execFileSync('node', [join(REPO, 'main.ts')], {
  env: { ...process.env, MAKEFUN_INPUT_DIR: join(KIT, 'practice/input'), MAKEFUN_OUTPUT_DIR: OUT },
  stdio: 'inherit',
});
const runMs = Date.now() - t0;
console.log(`run: ${runMs} ms for 8 images`);

// Losslessness: decode outputs with the kit checker decoder, compare to inputs.
const { decodePng } = await import(join(KIT, 'program/scorer/checker/png.mjs'));
let allExact = true;
for (let k = 1; k <= 8; k++) {
  const id = 'i' + String(k).padStart(3, '0');
  const inp = decodePng(new Uint8Array(readFileSync(join(KIT, 'practice/input', id, 'image.png'))));
  const outp = decodePng(new Uint8Array(readFileSync(join(OUT, id, 'image.png'))));
  if (!outp.ok) { console.log(id, 'OUTPUT UNREADABLE:', outp.why); allExact = false; continue; }
  let same = inp.rgba.length === outp.rgba.length;
  if (same) for (let i = 0; i < inp.rgba.length; i++) if (inp.rgba[i] !== outp.rgba[i]) { same = false; break; }
  const size = readFileSync(join(OUT, id, 'image.png')).length;
  console.log(id, 'bytes=', size, 'exact=', same, 'ct=', outp.colourType);
  if (!same) allExact = false;
}
console.log('all exact:', allExact);

// Score with the kit scorer.
execFileSync('node', [join(KIT, 'program/scorer/score.ts')], {
  env: { ...process.env, MAKEFUN_OUTPUT_DIR: OUT, MAKEFUN_REFERENCE_DIR: join(KIT, 'practice/reference'), MAKEFUN_SCORES_DIR: SCORES },
  stdio: 'inherit',
});
console.log(readFileSync(join(SCORES, 'scores.json'), 'utf8'));
console.log(readFileSync(join(SCORES, 'checks.json'), 'utf8'));
