// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://hub.seanson.com',
  // Custom domain at root → no base path. If served from *.github.io/hub, set base: '/hub'.
  output: 'static',
  integrations: [sitemap({ filter: (page) => !page.includes('/admin') && !page.includes('/orunka/login') })],
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
