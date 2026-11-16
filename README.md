[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/nhutqui1890/makefun-ai-excited/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/nhutqui1890/makefun-ai-excited/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

# Alien Storm — make.fun ai-excited-01 entry

A fully procedural image generator for make.fun's
[Make the AI judge excited](https://make.fun/bounty/ai-excited-01) bounty.
`main.ts` (Node 22, standard library only) paints a dramatic alien seascape —
a ringed planet over a storm-lit ocean at dusk, lightning splitting the clouds,
a low burning sun, mountain silhouettes and a glittering sea — and writes it
as a 1024×1024 PNG to `/output/entry.png`.

No network, no assets, no dependencies. Every random value comes from one
seeded generator, so repeated runs write the exact same bytes.

Run it locally:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```
