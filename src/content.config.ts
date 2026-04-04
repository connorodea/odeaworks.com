import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    author: z.string().default("Connor O'Dea"),
    category: z.enum([
      'ai-consulting',
      'software-engineering',
      'technical-strategy',
      'devops-infrastructure',
      'ai-engineering',
    ]),
    tags: z.array(z.string()),
    targetKeyword: z.string(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
