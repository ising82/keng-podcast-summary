# 台灣 Podcast 摘要

聚焦**投資、科技、商業與產業分析**的台灣 Podcast 中文摘要網站。每日自動抓取 RSS、用 LLM 產生摘要、commit 回 repo、Vercel 自動部署。

## 技術架構

| 層級 | 工具 |
|---|---|
| 框架 | [Astro](https://astro.build) v5（靜態輸出） |
| 內容 | Markdown + Astro Content Collections |
| 抓取 / 摘要 | TypeScript script (`scripts/update-podcasts.ts`)、`rss-parser`、Gemini API（可切 OpenAI） |
| 排程 | GitHub Actions cron（每日台北 07:00） |
| 部署 | Vercel（push 觸發 redeploy） |

完全 **無資料庫**。所有集數都是 `src/content/episodes/<slug>.md` 純文字檔。

## 本地開發

```bash
# 1. 安裝
npm install

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env，至少填入 GEMINI_API_KEY

# 3. dry-run 測試（不呼叫 LLM，產出假資料）
npm run update:dry

# 4. 正式抓取最新集數
npm run update

# 5. 開發伺服器
npm run dev          # http://localhost:4321

# 6. 正式 build
npm run build
```

## 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `GEMINI_API_KEY` | ✅（預設 provider） | [Google AI Studio](https://aistudio.google.com/app/apikey) 取得 |
| `OPENAI_API_KEY` | 切換 OpenAI 時必填 | [OpenAI Platform](https://platform.openai.com/api-keys) |
| `LLM_PROVIDER` | | `gemini`（預設） \| `openai` |
| `GEMINI_MODEL` | | 預設 `gemini-2.5-flash` |
| `OPENAI_MODEL` | | 預設 `gpt-4o-mini` |
| `MAX_NEW_EPISODES_PER_PODCAST` | | 每次最多處理幾集，預設 5 |
| `SITE_URL` | | 用於 sitemap / canonical |
| `DRY_RUN` | | 設成 `1` 不呼叫 LLM |

## 新增 Podcast

編輯 `podcasts.config.json`，加入一筆：

```jsonc
{
  "id": "my-podcast",          // 任意英數字 ID，會用於檔名前綴
  "name": "節目名稱",
  "host": "主持人",
  "category": "投資",          // 自由分類，目前用於 about 頁
  "feed": "https://example.com/rss.xml",
  "description": "選填"
}
```

**找 RSS feed 的方法**：

1. 用 Apple Podcasts iTunes Lookup API：
   ```bash
   curl -s "https://itunes.apple.com/lookup?id=<APPLE_PODCAST_ID>" | jq '.results[0].feedUrl'
   ```
   APPLE_PODCAST_ID 從 Apple Podcasts 網址抓，例：`podcasts.apple.com/tw/podcast/.../id1500839292` → `1500839292`
2. 如果節目用 SoundOn / Firstory / Spotify for Creators / SoundCloud hosting，從 [podnews.net](https://podnews.net) 搜尋節目名稱也能找到。
3. 若找不到 RSS：先在 config 留 `"feed": ""`，整個流程會自動跳過該節目，等取得 URL 再補上。

加完設定 push 即可，下一次排程會自動抓。

## 自動更新流程

`.github/workflows/update.yml`：

1. 每日 UTC 23:00（**台北 07:00**）觸發
2. `npm ci` → `npm run update`
3. Pipeline 對每個 podcast：
   - 抓 RSS（30 秒 timeout）
   - 比對 `data/processed.json` 的 GUID hash 去重
   - 每個 podcast 最多處理 `MAX_NEW_EPISODES_PER_PODCAST` 集
   - 呼叫 LLM 產生 JSON 格式摘要（system prompt 強制繁中、固定欄位）
   - 寫入 `src/content/episodes/<id>-<hash>.md`
   - 單一節目失敗會 log 並繼續下一個
4. 有新集數則自動 commit 並 push（`[skip ci]` 避免循環）
5. push 觸發 Vercel 自動 redeploy
6. 完整 log 上傳為 artifact，保留 14 天

手動觸發：GitHub repo → Actions → "Daily Podcast Update" → Run workflow。

## 部署 (Vercel)

1. 在 [Vercel](https://vercel.com/new) 從 GitHub import 這個 repo
2. Framework preset 會自動偵測為 **Astro**
3. Build command: `npm run build`（預設即可）
4. Output: `dist`（預設即可）
5. **不需要**在 Vercel 設定環境變數（網站是純靜態，LLM 在 GitHub Actions 中跑）

## GitHub Secrets 設定

到 repo → Settings → Secrets and variables → Actions：

**Secrets**（必填）：
- `GEMINI_API_KEY`

**Secrets**（選填）：
- `OPENAI_API_KEY`（若要切換 provider）

**Variables**（選填）：
- `LLM_PROVIDER`、`GEMINI_MODEL`、`OPENAI_MODEL`、`MAX_NEW_EPISODES_PER_PODCAST`

## 檔案結構

```
.
├── podcasts.config.json        # ⭐ 新增節目改這裡
├── src/
│   ├── content.config.ts        # Content Collection schema
│   ├── content/episodes/*.md    # 摘要檔（pipeline 自動產生）
│   ├── layouts/BaseLayout.astro
│   └── pages/
│       ├── index.astro          # 首頁 + 篩選
│       ├── about.astro
│       └── episodes/[id].astro  # 單集頁
├── scripts/update-podcasts.ts   # 抓取與摘要流程
├── data/processed.json          # GUID 去重索引
└── .github/workflows/update.yml # 每日排程
```

## 維護備忘

- **想暫停某節目**：在 config 把它移除（已產生的 md 檔仍保留）
- **想重新生成某集**：刪除 `src/content/episodes/<那一集>.md` 並從 `data/processed.json` 移除對應 hash
- **想換模型**：改 `GEMINI_MODEL` env 即可
- **配額用完**：調低 `MAX_NEW_EPISODES_PER_PODCAST`，或暫時設 `LLM_PROVIDER=openai`

## 後續優化（已知限制）

目前摘要來源是 **RSS 描述 / show notes**，不是音檔逐字稿，原因：

- 多數節目 RSS 描述已具高品質（時間軸、重點），用 LLM 整理品質夠好
- 直接處理音檔需 Whisper 等 STT 服務 → 成本與時間都顯著上升
- 部分節目（如股癌、財經皓角）描述較精簡，摘要可能偏淺

若日後要升級為「音檔逐字稿 + 摘要」，可在 `summarize()` 前面加：
1. 下載 enclosure URL 的 mp3
2. 呼叫 OpenAI Whisper / Gemini audio API 轉文字
3. 把逐字稿丟給原本的摘要 prompt

## License

MIT
