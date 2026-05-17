import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const episodes = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/episodes" }),
  schema: z.object({
    podcastId: z.string(),
    podcastName: z.string(),
    title: z.string(),
    pubDate: z.coerce.date(),
    audioUrl: z.string().optional(),
    episodeUrl: z.string().optional(),
    duration: z.string().optional(),
    guid: z.string(),
    oneLiner: z.string(),
    summary: z.string(),
    keyPoints: z.array(z.string()),
    keywords: z.array(z.string()),
    timestamps: z
      .array(
        z.object({
          time: z.string(),
          label: z.string(),
        })
      )
      .optional()
      .default([]),
    generatedAt: z.coerce.date(),
    llmProvider: z.string().optional(),
  }),
});

export const collections = { episodes };
