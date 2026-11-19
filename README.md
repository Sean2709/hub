# hub.seanson.com

Sean's personal hub — tools, iOS apps, writing, certifications.

- Framework: [Astro](https://astro.build) (static output; client JS only for the calculators, `/admin/` and the analytics beacon)
- Hosting: GitHub Pages via Actions (`.github/workflows/pages.yml` — on push to main + daily 06:00 KST rebuild)
- Content: `src/data/site.ts` (single source of truth for the hub page)

## Dev

```sh
npm ci
npm run dev      # http://localhost:4321
npm run build    # → dist/
```
