// Starlight content collection config. This file is required in
// Astro 6 / Starlight 0.39+ for the `docs` collection to be discovered.
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
