/**
 * Podcast 自動更新 pipeline（音檔模式 + show notes fallback）
 *
 * 對每集嘗試：
 *   1. 下載音檔（mp3 enclosure）
 *   2. 把音檔 inline 上傳給 Gemini，產生「筆記本級」結構化摘要
 *   3. 若任一步驟失敗（音檔太大 / 下載失敗 / API 失敗），fallback 到 show notes 文字摘要
 *
 * 設計：
 * - 單一節目失敗不影響其他
 * - 預設每節目最多 N 集（避免單次跑爆 API quota / 時間）
 * - 完整 logs 寫入 stderr，方便 GitHub Actions 留存
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(ROOT, "src", "content", "episodes");
const DATA_DIR = path.join(ROOT, "data");
const PROCESSED_FILE = path.join(DATA_DIR, "processed.json");
const CONFIG_FILE = path.join(ROOT, "podcasts.config.json");

const MAX_NEW_EPISODES_PER_PODCAST = Number(
  process.env.MAX_NEW_EPISODES_PER_PODCAST || 3
);
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 120);
const DRY_RUN = process.env.DRY_RUN === "1";
const PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
// 強制只用 shownotes 模式（不下載音檔）
const SKIP_AUDIO = process.env.SKIP_AUDIO === "1";

interface PodcastConfig {
  id: string;
  name: string;
  host: string;
  category: string;
  feed: string;
  description?: string;
}

interface SummaryResult {
  oneLiner: string;
  summary: string;
  keyPoints: string[];
  keywords: string[];
  sections?: { heading: string; content: string }[];
  glossary?: { term: string; definition: string }[];
  quotes?: string[];
  timestamps?: { time: string; label: string }[];
}

interface ProcessedIndex {
  [podcastId: string]: string[];
}

// ---------- utils ----------

function log(level: "info" | "warn" | "error", ...args: unknown[]) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function loadProcessed(): ProcessedIndex {
  if (!fs.existsSync(PROCESSED_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveProcessed(idx: ProcessedIndex) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(idx, null, 2), "utf8");
}

function episodeHash(
  guid: string | undefined,
  link: string | undefined,
  title: string
) {
  const key = guid || link || title;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function stripHtml(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function escapeYaml(s: string): string {
  return `"${(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function yamlBlock(items: string[], indent = "  ") {
  return items.map((i) => `${indent}- ${escapeYaml(i)}`).join("\n");
}

// ---------- audio fetch ----------

async function downloadAudio(url: string): Promise<Buffer | null> {
  try {
    log("info", `  Downloading audio: ${url.slice(0, 100)}`);
    const resp = await fetch(url, {
      headers: { "User-Agent": "tw-podcast-summarist/1.0" },
      redirect: "follow",
    });
    if (!resp.ok) {
      log("warn", `  Audio HTTP ${resp.status}`);
      return null;
    }
    const cl = resp.headers.get("content-length");
    if (cl && Number(cl) / 1024 / 1024 > MAX_AUDIO_MB) {
      log(
        "warn",
        `  Audio too large: ${(Number(cl) / 1024 / 1024).toFixed(1)} MB > ${MAX_AUDIO_MB} MB`
      );
      return null;
    }
    const ab = await resp.arrayBuffer();
    const sizeMB = ab.byteLength / 1024 / 1024;
    if (sizeMB > MAX_AUDIO_MB) {
      log("warn", `  Audio too large after download: ${sizeMB.toFixed(1)} MB`);
      return null;
    }
    log("info", `  Audio downloaded: ${sizeMB.toFixed(1)} MB`);
    return Buffer.from(ab);
  } catch (e) {
    log("warn", `  Audio download failed:`, e);
    return null;
  }
}

function guessMimeFromUrl(url: string): string {
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "audio/mpeg"; // default mp3
}

// ---------- prompts ----------

const NOTEBOOK_PROMPT = `你是專業的中文 Podcast 筆記編輯，目標讀者為投資人、科技工作者與商業分析師，希望把這集當成「可閱讀的學習筆記」。

請聆聽這集 Podcast 的完整音檔，產生**繁體中文**的深度筆記。

**輸出純 JSON（不要 markdown 程式碼區塊），結構：**
{
  "oneLiner": "一句話總結（30 字內）",
  "summary": "300~500 字的整集摘要，分段陳述脈絡與結論",
  "keyPoints": ["重點1", "重點2", ...10~20 條],
  "keywords": ["關鍵字1", ...3~6 個],
  "sections": [
    {"heading": "段落主題", "content": "該段落 80~150 字筆記內容"}
  ],
  "glossary": [
    {"term": "輝達 NVDA", "definition": "說明此名詞為何重要、在本集如何被討論"}
  ],
  "quotes": ["主持人或來賓的金句原文1", "金句2", ...],
  "timestamps": [{"time": "00:00", "label": "段落"}]
}

撰寫原則：
- summary：300~500 字，分 2~4 段，要說清楚「主題、論點、結論」，不是片段重複
- keyPoints：10~20 條精煉重點，每條 20~50 字，使用主動句
- sections：5~12 個段落，順著節目時間軸組織；heading 用主題名稱（如「美中關稅最新進展」「輝達 Q3 財報拆解」）
- glossary：節錄 3~8 個本集出現且讀者可能不熟的人名、公司、產品、術語
- quotes：擷取 2~5 句節目中**實際出現**的話（不要編造）；保留口語感
- timestamps：依音檔實際分段標記時間軸（重要！讓使用者可跳轉）
- 嚴禁編造未在音檔中出現的具體數字、人名、引述
- 全文使用繁體中文與台灣慣用詞`;

const SHOWNOTES_PROMPT = `你是專業的中文 Podcast 摘要編輯，目標讀者為投資人、科技工作者與商業分析師。

請根據以下 Podcast 集數的 RSS 描述（show notes）產生**繁體中文**摘要。資訊可能有限，請盡量整理；若實在不足，明確標註「【資訊不足】」。

**輸出純 JSON：**
{
  "oneLiner": "一句話總結（30 字內）",
  "summary": "100~200 字整集摘要",
  "keyPoints": ["重點1", ..., 5 條],
  "keywords": ["關鍵字1", ..., 3~5 個],
  "timestamps": []
}

規則：
- keyPoints 必須剛好 5 個
- 嚴禁編造未在原文中提及的具體數字或人名`;

// ---------- LLM ----------

async function callGeminiAudio(
  audio: Buffer,
  mimeType: string,
  meta: { podcastName: string; title: string; pubDate: string }
): Promise<SummaryResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const audioB64 = audio.toString("base64");
  const userText = `節目：${meta.podcastName}
單集標題：${meta.title}
發佈日期：${meta.pubDate}

請聆聽附上的完整音檔並輸出 JSON 結構的深度筆記。`;

  const body = {
    systemInstruction: { parts: [{ text: NOTEBOOK_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: userText },
          { inlineData: { mimeType, data: audioB64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini audio API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(
      `Gemini audio missing text. finish=${json?.candidates?.[0]?.finishReason}`
    );
  }
  return JSON.parse(text);
}

async function callGeminiText(
  meta: { podcastName: string; title: string; pubDate: string; description: string }
): Promise<SummaryResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const userContent = `節目：${meta.podcastName}
單集標題：${meta.title}
發佈日期：${meta.pubDate}

原始描述：
"""
${meta.description.slice(0, 6000)}
"""

請輸出 JSON。`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SHOWNOTES_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini text API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini text missing text");
  return JSON.parse(text);
}

async function callOpenAIText(meta: {
  podcastName: string;
  title: string;
  pubDate: string;
  description: string;
}): Promise<SummaryResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const userContent = `節目：${meta.podcastName}
單集標題：${meta.title}
發佈日期：${meta.pubDate}

原始描述：
"""
${meta.description.slice(0, 6000)}
"""

請輸出 JSON。`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SHOWNOTES_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI missing content");
  return JSON.parse(text);
}

// ---------- summarize orchestration ----------

async function summarizeEpisode(input: {
  podcastName: string;
  title: string;
  description: string;
  pubDate: string;
  audioUrl?: string;
}): Promise<{ result: SummaryResult; mode: "audio" | "shownotes" }> {
  if (DRY_RUN) {
    return {
      mode: "shownotes",
      result: {
        oneLiner: `[DRY] ${input.title.slice(0, 24)}`,
        summary: `[DRY RUN] ${input.description.slice(0, 130)}`,
        keyPoints: [
          "[DRY] 重點 1",
          "[DRY] 重點 2",
          "[DRY] 重點 3",
          "[DRY] 重點 4",
          "[DRY] 重點 5",
        ],
        keywords: ["DRY", "test"],
        sections: [],
        glossary: [],
        quotes: [],
        timestamps: [],
      },
    };
  }

  // Audio first（only Gemini supports inline audio cheaply）
  if (!SKIP_AUDIO && PROVIDER === "gemini" && input.audioUrl) {
    const audio = await downloadAudio(input.audioUrl);
    if (audio) {
      try {
        log("info", `  Calling Gemini with audio...`);
        const t0 = Date.now();
        const result = await callGeminiAudio(
          audio,
          guessMimeFromUrl(input.audioUrl),
          {
            podcastName: input.podcastName,
            title: input.title,
            pubDate: input.pubDate,
          }
        );
        log("info", `  Gemini audio OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return { mode: "audio", result };
      } catch (e) {
        log("warn", `  Gemini audio failed, falling back to shownotes:`, e);
      }
    }
  }

  // Fallback: text-only show notes summary
  log("info", `  Using show notes fallback`);
  const meta = {
    podcastName: input.podcastName,
    title: input.title,
    pubDate: input.pubDate,
    description: input.description || input.title,
  };
  const result =
    PROVIDER === "openai" ? await callOpenAIText(meta) : await callGeminiText(meta);
  return { mode: "shownotes", result };
}

// ---------- frontmatter builder ----------

function buildFrontmatter(args: {
  podcast: PodcastConfig;
  it: any;
  hash: string;
  result: SummaryResult;
  mode: "audio" | "shownotes";
}): string {
  const { podcast, it, hash, result, mode } = args;
  const title = (it.title || "Untitled").trim();
  const pubDate = it.isoDate || it.pubDate || new Date().toISOString();
  const enclosure = it.enclosure?.url;
  const duration = it.itunes?.duration;

  const lines: string[] = [
    `podcastId: ${podcast.id}`,
    `podcastName: ${escapeYaml(podcast.name)}`,
    `title: ${escapeYaml(title)}`,
    `pubDate: ${new Date(pubDate).toISOString()}`,
  ];
  if (enclosure) lines.push(`audioUrl: ${escapeYaml(enclosure)}`);
  if (it.link) lines.push(`episodeUrl: ${escapeYaml(it.link)}`);
  if (duration) lines.push(`duration: ${escapeYaml(String(duration))}`);
  lines.push(`guid: ${escapeYaml(it.guid || it.link || hash)}`);
  lines.push(`oneLiner: ${escapeYaml(result.oneLiner)}`);
  lines.push(`summary: ${escapeYaml(result.summary)}`);

  lines.push(`keyPoints:`);
  lines.push(yamlBlock(result.keyPoints || []));

  lines.push(`keywords:`);
  lines.push(yamlBlock(result.keywords || []));

  if (result.sections && result.sections.length > 0) {
    lines.push(`sections:`);
    for (const s of result.sections) {
      lines.push(`  - heading: ${escapeYaml(s.heading)}`);
      lines.push(`    content: ${escapeYaml(s.content)}`);
    }
  } else {
    lines.push(`sections: []`);
  }

  if (result.glossary && result.glossary.length > 0) {
    lines.push(`glossary:`);
    for (const g of result.glossary) {
      lines.push(`  - term: ${escapeYaml(g.term)}`);
      lines.push(`    definition: ${escapeYaml(g.definition)}`);
    }
  } else {
    lines.push(`glossary: []`);
  }

  if (result.quotes && result.quotes.length > 0) {
    lines.push(`quotes:`);
    lines.push(yamlBlock(result.quotes));
  } else {
    lines.push(`quotes: []`);
  }

  if (result.timestamps && result.timestamps.length > 0) {
    lines.push(`timestamps:`);
    for (const t of result.timestamps) {
      lines.push(`  - time: ${escapeYaml(t.time)}`);
      lines.push(`    label: ${escapeYaml(t.label)}`);
    }
  } else {
    lines.push(`timestamps: []`);
  }

  lines.push(`generatedAt: ${new Date().toISOString()}`);
  lines.push(`llmProvider: ${PROVIDER}`);
  lines.push(`sourceMode: ${mode}`);
  return lines.join("\n");
}

// ---------- main ----------

async function processPodcast(
  podcast: PodcastConfig,
  processed: ProcessedIndex
): Promise<{ added: number; failed: number }> {
  log("info", `=== ${podcast.name} (${podcast.id}) ===`);
  const parser = new Parser({
    timeout: 30_000,
    headers: { "User-Agent": "tw-podcast-summarist/1.0 (+github)" },
  });
  let feed;
  try {
    feed = await parser.parseURL(podcast.feed);
  } catch (e) {
    log("error", `Failed to fetch RSS for ${podcast.id}:`, e);
    return { added: 0, failed: 1 };
  }

  const seen = new Set(processed[podcast.id] || []);
  const items = (feed.items || []).slice(0, 30);
  const newItems = items
    .map((it) => ({ it, hash: episodeHash(it.guid, it.link, it.title || "") }))
    .filter((x) => !seen.has(x.hash))
    .slice(0, MAX_NEW_EPISODES_PER_PODCAST);

  if (newItems.length === 0) {
    log("info", `No new episodes for ${podcast.id}`);
    return { added: 0, failed: 0 };
  }

  log("info", `Found ${newItems.length} new episode(s) for ${podcast.id}`);
  let added = 0;
  let failed = 0;

  for (const { it, hash } of newItems) {
    const title = (it.title || "Untitled").trim();
    const pubDate = it.isoDate || it.pubDate || new Date().toISOString();
    const description = stripHtml(
      (it as any).contentSnippet ||
        (it as any)["content:encoded"] ||
        it.content ||
        (it as any).summary ||
        (it as any).itunes?.summary ||
        ""
    );
    const audioUrl = (it as any).enclosure?.url;

    log("info", `→ ${title.slice(0, 60)}`);
    try {
      const { result, mode } = await summarizeEpisode({
        podcastName: podcast.name,
        title,
        description: description || title,
        pubDate,
        audioUrl,
      });

      const slug = `${podcast.id}-${hash}`;
      const filePath = path.join(CONTENT_DIR, `${slug}.md`);
      const frontmatter = buildFrontmatter({ podcast, it, hash, result, mode });
      const body = `\n## 原始描述\n\n${(description || "（無原始描述）").slice(0, 2000)}\n`;

      ensureDir(CONTENT_DIR);
      fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
      seen.add(hash);
      added++;
      log("info", `  ✓ saved (mode=${mode})`);
    } catch (e) {
      failed++;
      log("error", `  ✗ failed:`, e);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  processed[podcast.id] = Array.from(seen).slice(-500);
  return { added, failed };
}

async function main() {
  log(
    "info",
    `Pipeline start (provider=${PROVIDER}, dry=${DRY_RUN}, skip_audio=${SKIP_AUDIO}, max/p=${MAX_NEW_EPISODES_PER_PODCAST})`
  );
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const podcasts: PodcastConfig[] = config.podcasts || [];
  const processed = loadProcessed();

  ensureDir(CONTENT_DIR);
  let totalAdded = 0;
  let totalFailed = 0;

  for (const p of podcasts) {
    if (!p.feed) {
      log("warn", `Skip ${p.id}: no feed URL`);
      continue;
    }
    try {
      const { added, failed } = await processPodcast(p, processed);
      totalAdded += added;
      totalFailed += failed;
    } catch (e) {
      log("error", `Podcast ${p.id} crashed (continuing):`, e);
      totalFailed++;
    }
    saveProcessed(processed);
  }

  log("info", `Done. added=${totalAdded} failed=${totalFailed}`);
  if (totalFailed > podcasts.length / 2 && totalAdded === 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  log("error", "Fatal:", e);
  process.exit(1);
});
