/**
 * Podcast 自動更新 pipeline
 *
 * 流程：
 * 1. 讀取 podcasts.config.json
 * 2. 依序抓取每個 podcast 的 RSS feed
 * 3. 比對 data/processed.json，找出新集數
 * 4. 對每個新集數呼叫 LLM 產生摘要（fallback：用 description 直接顯示）
 * 5. 寫入 src/content/episodes/<podcastId>-<slug>.md
 * 6. 更新 processed.json
 *
 * 設計原則：
 * - 單一 podcast 失敗不影響其他
 * - 預設每節目最多處理 N 集（避免 API 爆量）
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
  process.env.MAX_NEW_EPISODES_PER_PODCAST || 5
);
const DRY_RUN = process.env.DRY_RUN === "1";
const PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();

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
  timestamps?: { time: string; label: string }[];
}

interface ProcessedIndex {
  [podcastId: string]: string[]; // list of episode hashes
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

function episodeHash(guid: string | undefined, link: string | undefined, title: string) {
  const key = guid || link || title;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
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
  // wrap in double quotes, escape " and \
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------- LLM ----------

const SUMMARY_PROMPT = `你是專業的中文 Podcast 摘要編輯，目標讀者為投資人、科技工作者與商業分析師。

請根據以下 Podcast 集數資訊產生**繁體中文**摘要。如果原始描述太短或資訊不足，請以「【資訊不足】」字樣補充，但仍嘗試提取關鍵字。

**輸出格式必須是純 JSON（不要包 markdown 程式碼區塊），結構如下：**
{
  "oneLiner": "一句話總結（30 字內）",
  "summary": "100~150 字的整集摘要",
  "keyPoints": ["重點1", "重點2", "重點3", "重點4", "重點5"],
  "keywords": ["關鍵字1", "關鍵字2", "關鍵字3"],
  "timestamps": [{"time": "00:00", "label": "段落"}]
}

規則：
- oneLiner: 必填，30 字以內
- summary: 100~150 字，繁體中文，避免口語贅字
- keyPoints: 必須剛好 5 個，每個 15~40 字
- keywords: 3~5 個，名詞為主（如「美元指數」「輝達」「FOMC」）
- timestamps: 若描述含時間軸則整理為陣列，否則回傳空陣列 []
- 嚴禁編造未在原文中提及的具體數字或人名`;

async function callGemini(userContent: string): Promise<SummaryResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const body = {
    systemInstruction: { parts: [{ text: SUMMARY_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response missing text");
  return JSON.parse(text);
}

async function callOpenAI(userContent: string): Promise<SummaryResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
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
  if (!text) throw new Error("OpenAI response missing content");
  return JSON.parse(text);
}

async function summarize(input: {
  podcastName: string;
  title: string;
  description: string;
  pubDate: string;
}): Promise<SummaryResult> {
  const userContent = `節目：${input.podcastName}
單集標題：${input.title}
發佈日期：${input.pubDate}

原始描述（可能為節目簡介、show notes 或時間軸）：
"""
${input.description.slice(0, 6000)}
"""

請輸出 JSON。`;

  if (DRY_RUN) {
    return {
      oneLiner: `[DRY] ${input.title.slice(0, 24)}`,
      summary: `[DRY RUN] ${input.description.slice(0, 130)}`,
      keyPoints: [
        "[DRY] 重點 1",
        "[DRY] 重點 2",
        "[DRY] 重點 3",
        "[DRY] 重點 4",
        "[DRY] 重點 5",
      ],
      keywords: ["DRY_RUN", "測試", "本地"],
      timestamps: [],
    };
  }

  if (PROVIDER === "openai") return callOpenAI(userContent);
  return callGemini(userContent);
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
  const items = (feed.items || []).slice(0, 30); // 看最新 30 集就好
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

    try {
      const result = await summarize({
        podcastName: podcast.name,
        title,
        description: description || title,
        pubDate,
      });

      const slug = `${podcast.id}-${hash}`;
      const filePath = path.join(CONTENT_DIR, `${slug}.md`);
      const enclosure = (it as any).enclosure?.url;

      const frontmatter = [
        `podcastId: ${podcast.id}`,
        `podcastName: ${escapeYaml(podcast.name)}`,
        `title: ${escapeYaml(title)}`,
        `pubDate: ${new Date(pubDate).toISOString()}`,
        enclosure ? `audioUrl: ${escapeYaml(enclosure)}` : null,
        it.link ? `episodeUrl: ${escapeYaml(it.link)}` : null,
        (it as any).itunes?.duration
          ? `duration: ${escapeYaml((it as any).itunes.duration)}`
          : null,
        `guid: ${escapeYaml(it.guid || it.link || hash)}`,
        `oneLiner: ${escapeYaml(result.oneLiner)}`,
        `summary: ${escapeYaml(result.summary)}`,
        `keyPoints:`,
        ...result.keyPoints.map((k) => `  - ${escapeYaml(k)}`),
        `keywords:`,
        ...result.keywords.map((k) => `  - ${escapeYaml(k)}`),
        (result.timestamps && result.timestamps.length > 0)
          ? [
              `timestamps:`,
              ...result.timestamps.flatMap((t) => [
                `  - time: ${escapeYaml(t.time)}`,
                `    label: ${escapeYaml(t.label)}`,
              ]),
            ].join("\n")
          : `timestamps: []`,
        `generatedAt: ${new Date().toISOString()}`,
        `llmProvider: ${PROVIDER}`,
      ]
        .filter(Boolean)
        .join("\n");

      const body = `\n## 原始描述\n\n${(description || "（無原始描述）").slice(0, 2000)}\n`;

      ensureDir(CONTENT_DIR);
      fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
      seen.add(hash);
      added++;
      log("info", `  ✓ ${title.slice(0, 40)}`);
    } catch (e) {
      failed++;
      log("error", `  ✗ Failed to summarize "${title.slice(0, 40)}":`, e);
    }

    // 緩衝 1 秒避免 rate limit
    await new Promise((r) => setTimeout(r, 1000));
  }

  processed[podcast.id] = Array.from(seen).slice(-500); // 保留最近 500
  return { added, failed };
}

async function main() {
  log("info", `Pipeline start (provider=${PROVIDER}, dry=${DRY_RUN})`);
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
    // 即時存檔，避免中途失敗丟資料
    saveProcessed(processed);
  }

  log("info", `Done. added=${totalAdded} failed=${totalFailed}`);
  // 失敗超過半數視為整體失敗
  if (totalFailed > podcasts.length / 2 && totalAdded === 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  log("error", "Fatal:", e);
  process.exit(1);
});
