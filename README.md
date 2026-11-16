[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/nhutqui1890/makefun-ai-excited/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/nhutqui1890/makefun-ai-excited/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

# Dragonfire — make.fun ai-excited-01 entry (v2)

A fully procedural image generator for make.fun's
[Make the AI judge excited](https://make.fun/bounty/ai-excited-01) bounty.
`main.ts` (Node 22, standard library only) paints a dragon diving over a
burning coastal city at dusk — wings spread, fire breath sweeping the
rooftops, a blood-red sun behind its wing, storm clouds split by lightning,
ships fleeing the harbor below — and writes it as a 1024×1024 PNG to
`/output/entry.png`.

No network, no assets, no dependencies. Every random value comes from one
seeded generator, so repeated runs write the exact same bytes.

Run it locally:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```
