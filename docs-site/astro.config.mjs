// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://flint.op4z.dev',
  integrations: [
    starlight({
      title: 'Flint',
      description:
        'The Cloudflare Pages bootstrap CLI. Sparks the spark for Vite + React + TS apps on Cloudflare Pages.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/beau-g/flint' },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Getting started', slug: 'start/getting-started' },
            { label: 'Commands reference', slug: 'start/commands' },
            { label: 'Templates reference', slug: 'start/templates' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Migration from 0.x', slug: 'guides/migration-from-0x' },
            { label: 'Compatibility', slug: 'guides/compatibility' },
            { label: 'Deploy environments', slug: 'guides/deploy-environments' },
            { label: 'Programmatic API', slug: 'guides/programmatic-api' },
            { label: 'Telemetry transparency', slug: 'guides/telemetry-transparency' },
          ],
        },
        {
          label: 'Contributing',
          items: [{ label: 'Contributing', slug: 'contributing/contributing' }],
        },
      ],
    }),
  ],
});
