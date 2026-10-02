// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 本番ドメイン。変更するときはここ 1 行だけを書き換える。
export default defineConfig({
  site: 'https://shokuju-reien.jp',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [sitemap()],
  compressHTML: true,
});
