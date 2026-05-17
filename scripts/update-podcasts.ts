/**
 * Podcast 自動更新 pipeline — YouTube 字幕筆記本級摘要版
 *
 * 流程（每個 podcast）：
 *   1. 用 yt-dlp 取得頻道最新 N 部影片
 *   2. 對每部影片用 yt-dlp 下載字幕（zh-TW/zh-Hant/zh）
 *   3. 把 VTT 字幕清理後丟給 Gemini text 模式，產生筆記本級結構化摘要
 *   4. 寫入 src/content/episodes/<id>.md
 *
 * 設計：
 * - 單一節目失敗不影響其他
 * - 預設每節目最多 N 集
 * - 完整 logs 寫入 stderr
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(ROOT, "src", "content", "episodes");
const DATA_DIR = path.join(ROOT, "data");
const PROCESSED_FILE = path.join(DATA_DIR, "processed.json");
const CONFIG_FILE = path.join(ROOT, "podcasts.config.json");
const TMP_DIR = path.join(os.tmpdir(), "twpod-subs");

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
  description?: string;
  source: "youtube";
  channelId: string;
  channelUrl?: string;
  maxEpisodes?: number;
  subLangs?: string[];
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

function shortHash(s: string) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function escapeYaml(s: string): string {
  return `"${(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function yamlBlock(items: string[], indent = "  ") {
  return items.map((i) => `${indent}- ${escapeYaml(i)}`).join("\n");
}

// ---------- yt-dlp helpers ----------

function ytdlpCmd(): string {
  return process.env.YT_DLP_BIN || "yt-dlp";
}

interface YtVideo {
  id: string;
  title: string;
  upload_date?: string; // YYYYMMDD
  duration?: number;
  url: string;
}

function listChannelVideos(channelId: string, limit: number): YtVideo[] {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  const out = execFileSync(
    ytdlpCmd(),
    [
      url,
      "--flat-playlist",
      "--playlist-end",
      String(limit),
      "--print",
      "%(id)s|||%(title)s|||%(upload_date)s|||%(duration)s",
      "--no-warnings",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );
  const vids: YtVideo[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [id, title, date, dur] = t.split("|||");
    if (!id) continue;
    vids.push({
      id,
      title: title || id,
      upload_date: date && date !== "NA" ? date : undefined,
      duration: dur && dur !== "NA" ? Number(dur) : undefined,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  }
  return vids;
}

function fetchVideoMetadata(videoId: string): {
  description: string;
  upload_date?: string;
  duration?: number;
} {
  try {
    const out = execFileSync(
      ytdlpCmd(),
      [
        `https://www.youtube.com/watch?v=${videoId}`,
        "--skip-download",
        "--print",
        "%(description)s|||%(upload_date)s|||%(duration)s",
        "--no-warnings",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    const first = out.split("\n").find((l) => l.trim());
    if (!first) return { description: "" };
    const [desc, date, dur] = first.split("|||");
    return {
      description: (desc || "").replace(/\\n/g, "\n"),
      upload_date: date && date !== "NA" ? date : undefined,
      duration: dur && dur !== "NA" ? Number(dur) : undefined,
    };
  } catch {
    return { description: "" };
  }
}

function downloadSubtitles(videoId: string, langs: string[]): string | null {
  ensureDir(TMP_DIR);
  const outBase = path.join(TMP_DIR, videoId);
  // Clean stale
  for (const f of fs.existsSync(TMP_DIR) ? fs.readdirSync(TMP_DIR) : []) {
    if (f.startsWith(videoId + ".")) {
      try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch {}
    }
  }
  const langCsv = langs.join(",");
  // Try human-written first, fall back to auto-captions
  for (const flag of ["--write-subs", "--write-auto-subs"]) {
    try {
      execFileSync(
        ytdlpCmd(),
        [
          `https://www.youtube.com/watch?v=${videoId}`,
          "--skip-download",
          flag,
          "--sub-langs",
          langCsv,
          "--sub-format",
          "vtt/srt/best",
          "-o",
          `${outBase}.%(ext)s`,
          "--no-warnings",
        ],
        { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }
      );
    } catch (e) {
      log("warn", `  yt-dlp ${flag} failed for ${videoId}`);
      continue;
    }
    // Look for any .vtt file matching outBase
    const files = fs.readdirSync(TMP_DIR).filter(
      (f) => f.startsWith(videoId + ".") && (f.endsWith(".vtt") || f.endsWith(".srt"))
    );
    if (files.length > 0) {
      // Prefer zh-TW > zh-Hant > zh > zh-CN
      const order = langs.concat(["zh-TW", "zh-Hant", "zh", "zh-CN"]);
      files.sort((a, b) => {
        const ai = order.findIndex((l) => a.includes(`.${l}.`));
        const bi = order.findIndex((l) => b.includes(`.${l}.`));
        const A = ai < 0 ? 999 : ai;
        const B = bi < 0 ? 999 : bi;
        return A - B;
      });
      const full = path.join(TMP_DIR, files[0]);
      const raw = fs.readFileSync(full, "utf8");
      log(
        "info",
        `  Sub file: ${files[0]} (${(raw.length / 1024).toFixed(1)} KB, mode=${flag})`
      );
      return raw;
    }
  }
  return null;
}

// Convert VTT/SRT into "MM:SS  text" plain transcript
function vttToTranscript(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: { time: string; text: string }[] = [];
  let curTime = "";
  let curText: string[] = [];
  const flush = () => {
    if (curText.length > 0) {
      const txt = curText.join(" ").replace(/\s+/g, " ").trim();
      if (txt) out.push({ time: curTime, text: txt });
    }
    curText = [];
  };
  const timeRe = /(\d{2}):(\d{2}):(\d{2})[.,]\d{3}\s+-->/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:") || /^\d+$/.test(line)) {
      continue;
    }
    const m = line.match(timeRe);
    if (m) {
      flush();
      const h = Number(m[1]);
      const mm = Number(m[2]);
      const ss = Number(m[3]);
      const totalMin = h * 60 + mm;
      curTime = `${String(totalMin).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      continue;
    }
    // Strip inline tags <c>, <00:00:00.000> etc.
    const cleaned = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
      .replace(/<\/?c[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    if (cleaned) curText.push(cleaned);
  }
  flush();

  // Dedupe consecutive identical text (common in auto-captions)
  const dedup: typeof out = [];
  for (const seg of out) {
    if (dedup.length > 0 && dedup[dedup.length - 1].text === seg.text) continue;
    dedup.push(seg);
  }
  return dedup.map((s) => `[${s.time}] ${s.text}`).join("\n");
}

// ---------- prompts ----------

const NOTEBOOK_PROMPT = `你是專業的中文 Podcast 筆記編輯，目標讀者為投資人、科技工作者與商業分析師，希望把這集當成「可閱讀的學習筆記」。

以下是 YouTube 影片的繁體中文字幕（含時間軸 [MM:SS]）。請根據字幕內容產生**繁體中文**的深度筆記。

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
- sections：6~12 個段落，順著影片時間軸組織；heading 用主題名稱（如「美中關稅最新進展」「輝達 Q3 財報拆解」）
- glossary：節錄 3~8 個本集出現且讀者可能不熟的人名、公司、產品、術語
- quotes：擷取 2~5 句字幕中**實際出現**的話（不要編造）；保留口語感
- timestamps：依字幕中的 [MM:SS] 標記，挑 6~12 個重要時間點
- 嚴禁編造未在字幕中出現的具體數字、人名、引述
- 全文使用繁體中文與台灣慣用詞`;

// ---------- LLM ----------

async function callGeminiNotebook(
  transcript: string,
  meta: { podcastName: string; title: string; pubDate: string; description: string }
): Promise<SummaryResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  // 截斷字幕避免過長（gemini-2.5-flash 1M tokens 應夠用，但保守限制 200K 字）
  const trimmed = transcript.length > 200_000 ? transcript.slice(0, 200_000) + "\n[...字幕過長已截斷]" : transcript;

  const userText = `節目：${meta.podcastName}
影片標題：${meta.title}
發佈日期：${meta.pubDate}

YouTube 描述（補充用）：
${(meta.description || "").slice(0, 1500)}

完整字幕（含時間軸）：
"""
${trimmed}
"""

請輸出 JSON。`;

  const body = {
    systemInstruction: { parts: [{ text: NOTEBOOK_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
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
    throw new Error(`Gemini API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(
      `Gemini missing text. finish=${json?.candidates?.[0]?.finishReason}`
    );
  }
  return JSON.parse(text);
}

// ---------- frontmatter ----------

function buildFrontmatter(args: {
  podcast: PodcastConfig;
  video: YtVideo;
  hash: string;
  pubDate: string;
  description: string;
  result: SummaryResult;
}): string {
  const { podcast, video, hash, pubDate, description, result } = args;

  const lines: string[] = [
    `podcastId: ${podcast.id}`,
    `podcastName: ${escapeYaml(podcast.name)}`,
    `title: ${escapeYaml(video.title)}`,
    `pubDate: ${pubDate}`,
    `audioUrl: ${escapeYaml(`https://www.youtube.com/watch?v=${video.id}`)}`,
    `episodeUrl: ${escapeYaml(`https://www.youtube.com/watch?v=${video.id}`)}`,
    `youtubeId: ${escapeYaml(video.id)}`,
  ];
  if (video.duration) lines.push(`duration: ${escapeYaml(String(video.duration))}`);
  lines.push(`guid: ${escapeYaml(video.id)}`);
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
  } else lines.push(`sections: []`);

  if (result.glossary && result.glossary.length > 0) {
    lines.push(`glossary:`);
    for (const g of result.glossary) {
      lines.push(`  - term: ${escapeYaml(g.term)}`);
      lines.push(`    definition: ${escapeYaml(g.definition)}`);
    }
  } else lines.push(`glossary: []`);

  if (result.quotes && result.quotes.length > 0) {
    lines.push(`quotes:`);
    lines.push(yamlBlock(result.quotes));
  } else lines.push(`quotes: []`);

  if (result.timestamps && result.timestamps.length > 0) {
    lines.push(`timestamps:`);
    for (const t of result.timestamps) {
      lines.push(`  - time: ${escapeYaml(t.time)}`);
      lines.push(`    label: ${escapeYaml(t.label)}`);
    }
  } else lines.push(`timestamps: []`);

  lines.push(`generatedAt: ${new Date().toISOString()}`);
  lines.push(`llmProvider: ${PROVIDER}`);
  lines.push(`sourceMode: ${escapeYaml("youtube-subs")}`);
  return lines.join("\n");
}

// ---------- main ----------

function ymdToIso(yyyymmdd?: string, fallback?: string): string {
  if (yyyymmdd && /^\d{8}$/.test(yyyymmdd)) {
    const y = yyyymmdd.slice(0, 4);
    const m = yyyymmdd.slice(4, 6);
    const d = yyyymmdd.slice(6, 8);
    return new Date(`${y}-${m}-${d}T00:00:00Z`).toISOString();
  }
  return fallback || new Date().toISOString();
}

async function processPodcast(
  podcast: PodcastConfig,
  processed: ProcessedIndex
): Promise<{ added: number; failed: number }> {
  log("info", `=== ${podcast.name} (${podcast.id}) ===`);
  const maxEp = podcast.maxEpisodes || MAX_NEW_EPISODES_PER_PODCAST;
  const langs = podcast.subLangs || ["zh-TW", "zh-Hant", "zh", "zh-CN"];

  let videos: YtVideo[];
  try {
    videos = listChannelVideos(podcast.channelId, maxEp * 2);
  } catch (e) {
    log("error", `Failed to list videos for ${podcast.id}:`, e);
    return { added: 0, failed: 1 };
  }
  log("info", `Found ${videos.length} videos on channel`);

  const seen = new Set(processed[podcast.id] || []);
  const newVids = videos.filter((v) => !seen.has(v.id)).slice(0, maxEp);

  if (newVids.length === 0) {
    log("info", `No new videos for ${podcast.id}`);
    return { added: 0, failed: 0 };
  }

  log("info", `Processing ${newVids.length} new video(s)`);
  let added = 0;
  let failed = 0;

  for (const video of newVids) {
    log("info", `→ ${video.title.slice(0, 60)} (${video.id})`);

    try {
      // 1. fetch metadata (description)
      const meta = fetchVideoMetadata(video.id);
      const description = meta.description || "";
      const pubDate = ymdToIso(video.upload_date || meta.upload_date);

      // 2. download subtitles
      let transcript: string | null = null;
      if (!DRY_RUN) {
        const vtt = downloadSubtitles(video.id, langs);
        if (!vtt) {
          throw new Error("no subtitles available");
        }
        transcript = vttToTranscript(vtt);
        log("info", `  Transcript: ${(transcript.length / 1024).toFixed(1)} KB`);
        if (transcript.length < 500) {
          throw new Error(`transcript too short: ${transcript.length} chars`);
        }
      } else {
        transcript = `[00:00] DRY RUN placeholder transcript`;
      }

      // 3. call LLM
      let result: SummaryResult;
      if (DRY_RUN) {
        result = {
          oneLiner: `[DRY] ${video.title.slice(0, 24)}`,
          summary: `[DRY RUN] ${description.slice(0, 130)}`,
          keyPoints: ["[DRY] 1", "[DRY] 2", "[DRY] 3", "[DRY] 4", "[DRY] 5"],
          keywords: ["DRY"],
          sections: [],
          glossary: [],
          quotes: [],
          timestamps: [],
        };
      } else {
        const t0 = Date.now();
        result = await callGeminiNotebook(transcript!, {
          podcastName: podcast.name,
          title: video.title,
          pubDate,
          description,
        });
        log("info", `  Gemini OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }

      // 4. write
      const hash = shortHash(video.id);
      const slug = `${podcast.id}-${hash}`;
      const filePath = path.join(CONTENT_DIR, `${slug}.md`);
      const frontmatter = buildFrontmatter({
        podcast,
        video,
        hash,
        pubDate,
        description,
        result,
      });
      const body = `\n## YouTube 影片描述\n\n${(description || "（無描述）").slice(0, 2000)}\n`;
      ensureDir(CONTENT_DIR);
      fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
      seen.add(video.id);
      added++;
      log("info", `  ✓ saved`);
    } catch (e) {
      failed++;
      log("error", `  ✗ failed:`, e instanceof Error ? e.message : e);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  processed[podcast.id] = Array.from(seen).slice(-500);
  return { added, failed };
}

async function main() {
  log(
    "info",
    `Pipeline start (provider=${PROVIDER}, dry=${DRY_RUN}, max/p=${MAX_NEW_EPISODES_PER_PODCAST})`
  );
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const podcasts: PodcastConfig[] = config.podcasts || [];
  const processed = loadProcessed();

  ensureDir(CONTENT_DIR);
  let totalAdded = 0;
  let totalFailed = 0;

  for (const p of podcasts) {
    if (p.source !== "youtube" || !p.channelId) {
      log("warn", `Skip ${p.id}: not a youtube source`);
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
  if (totalFailed > 0 && totalAdded === 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  log("error", "Fatal:", e);
  process.exit(1);
});
