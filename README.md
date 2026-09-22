# hub.sean-chloe.com

Sean's personal hub — certifications, iOS apps, writing.

- Framework: [Astro](https://astro.build) (static output, zero client JS for now)
- Hosting: GitHub Pages via Actions (`.github/workflows/pages.yml`)
- Content: `src/data/site.ts` (single source of truth)

## Dev

```sh
npm ci
npm run dev      # http://localhost:4321
npm run build    # → dist/
```

## Roadmap

- `/bedrock/` — daily-regenerated matrix of Bedrock models × features for ap-northeast-2, with `/data/*.json` published for reuse.
