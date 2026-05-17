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

    // === 核心摘要 ===
    oneLiner: z.string(),
    summary: z.string(),               // 300~500 字（音檔模式）或 100~150 字（fallback）
    keyPoints: z.array(z.string()),    // 10~20 條（音檔模式）或 5 條（fallback）
    keywords: z.array(z.string()),

    // === 進階筆記欄位 ===
    sections: z
      .array(
        z.object({
          heading: z.string(),
          content: z.string(),
        })
      )
      .optional()
      .default([]),
    glossary: z
      .array(
        z.object({
          term: z.string(),
          definition: z.string(),
        })
      )
      .optional()
      .default([]),
    quotes: z.array(z.string()).optional().default([]),
    timestamps: z
      .array(
        z.object({
          time: z.string(),
          label: z.string(),
        })
      )
      .optional()
      .default([]),

    // === Meta ===
    generatedAt: z.coerce.date(),
    llmProvider: z.string().optional(),
    sourceMode: z.string().optional().default("youtube-subs"),
    youtubeId: z.string().optional(),
  }),
});

export const collections = { episodes };
