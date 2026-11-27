# png-squeeze-01-run-20261127 — Squeeze screenshots into the smallest PNG

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Zoldix/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Zoldix/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entry for the make.fun competition
[png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127):
one Node 22 program (`main.ts`, no dependencies) that rewrites each 1280×720
RGBA screenshot in `/input/<id>/image.png` as the smallest lossless PNG it can
build, written to `/output/<id>/image.png`.

## Method

Every decision is a pure function of the pixels, so two runs write the same
bytes; the wall is budgeted by work, never by the clock.

1. Decode the stored PNG to raw RGBA with a self-contained decoder.
2. Analyse the image: opaque? grey? at most 256 distinct colours? a single
   fully transparent colour no opaque pixel uses (a tRNS key)?
3. Screen every lossless form those answers allow — palette in two orders
   (transparent entries first, then by count or by luminance), grey,
   grey+alpha, RGB, RGBA, with a tRNS key where one exists. Each form's rows
   are filtered several ways: each fixed filter, the minimum-sum heuristic,
   the fewest-distinct-pairs heuristic, and for narrow forms a per-row brute
   force that weighs each filter by deflating the row against the bytes
   already written. Forms are weighed by a level-6 zlib stream of their data.
4. The best few filtered data sets are re-deflated at level 9 (memLevel 8
   first — on these screenshots it repeatedly beat memLevel 9 — plus the
   filtered strategy) and the smallest stream wins.
5. The winning PNG is decoded again and compared pixel by pixel with the
   source; only an exact match is written. If anything goes wrong, the input
   file is copied instead — always exact — so every instance stays answered.

## Practice set (kit, scored with the kit's own scorer)

| metric | this entry | house baseline fixed-paeth 1.0.0 |
| --- | --- | --- |
| score (of 1,000,000) | **705,542** | 420,399 |
| instances answered | 8 / 8 (passed) | 8 / 8 |
| runtime, whole set | ~20 s of the 60 s wall | ~5 s |

Per instance (bytes): i001 12,496 · i002 51,852 · i003 106,527 ·
i004 105,605 · i005 16,552 · i006 178,606 · i007 60,890 · i008 24,897 —
below the scale compressor's stated size on all eight. Determinism checked:
two runs produce byte-identical outputs. Robustness checked on
out-of-distribution images (game screenshots, greyscale, alpha gradients,
posterised, noise): lossless 8/8.

## Licence

MIT — see `LICENSE`.
