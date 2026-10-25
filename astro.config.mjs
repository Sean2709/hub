// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://hub.seanson.com',
  // Custom domain at root → no base path. If served from *.github.io/hub, set base: '/hub'.
  output: 'static',
  // /orunka/{,privacy/,terms/} 는 orunka.com 으로 넘기는 쪽(2026-10-25~)이라 sitemap 에서 뺀다. /orunka/login/ 도 빠진다.
  integrations: [sitemap({ filter: (page) => !page.includes('/admin') && !page.includes('/orunka/') })],
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
