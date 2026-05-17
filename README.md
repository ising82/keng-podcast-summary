# M觀點 筆記本級摘要

M觀點 (Miula) YouTube 每日筆記本級摘要網站。每日自動抓取最新影片的繁中字幕、用 Gemini 產生結構化筆記、commit 回 repo、Vercel 自動部署。

- 🌐 網站：<https://keng-podcast-summary.vercel.app>
- 📦 Repo：<https://github.com/ising82/keng-podcast-summary>

## 技術架構

| 層級 | 工具 |
|---|---|
| 框架 | [Astro](https://astro.build) v5（靜態輸出） |
| 內容 | Markdown + Astro Content Collections |
| 字幕抓取 | [yt-dlp](https://github.com/yt-dlp/yt-dlp)（GitHub Actions 上自動安裝） |
| 摘要 | Gemini 2.5 Flash text 模式（讀字幕產生筆記本級 JSON 摘要） |
| 排程 | GitHub Actions cron（每日台北 07:00） |
| 部署 | Vercel（push 觸發 redeploy） |

完全 **無資料庫**。所有集數都是 `src/content/episodes/<slug>.md` 純文字檔。

## 為何只做 M觀點？

實測台灣財經/科技 Podcast 中：
- **M觀點** YouTube 有完整、人工撰寫的繁中字幕（一集約 100–200 KB）
- **股癌、財報狗、理財達人秀** 等沒有公開字幕，需要 Gemini API 付費層處理音檔
- 純 show notes 摘要（無音檔）內容太淺，無法達到「筆記本級」

因此初版只做 M觀點，提供最高深度。日後若有預算可加付費音檔模式。

## 本地開發

```bash
# 1. 安裝
npm install

# 2. 需要本地安裝 yt-dlp
brew install yt-dlp  # 或 pip install yt-dlp

# 3. 設定環境變數
export GEMINI_API_KEY="..."

# 4. dry-run 測試（不呼叫 LLM）
npm run update:dry

# 5. 正式抓取最新集數
npm run update

# 6. 開發伺服器
npm run dev          # http://localhost:4321

# 7. 正式 build
npm run build
```

## 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | [Google AI Studio](https://aistudio.google.com/app/apikey) 取得（**免費層即可**） |
| `GEMINI_MODEL` | | 預設 `gemini-2.5-flash` |
| `MAX_NEW_EPISODES_PER_PODCAST` | | 每次最多處理幾集，預設 5 |
| `SITE_URL` | | 用於 sitemap / canonical |
| `DRY_RUN` | | 設成 `1` 不呼叫 LLM、不抓字幕 |

## 新增 Podcast / YouTube 頻道

編輯 `podcasts.config.json`，加入一筆：

```jsonc
{
  "id": "my-channel",
  "name": "頻道名稱",
  "host": "主持人",
  "category": "投資",
  "source": "youtube",
  "channelId": "UCxxxxxxxxxxxxxxxxxxxx",
  "description": "選填",
  "maxEpisodes": 5,
  "subLangs": ["zh-TW", "zh-Hant", "zh", "zh-CN"]
}
```

**找 YouTube Channel ID**：
1. 用 [commentpicker.com/youtube-channel-id.php](https://commentpicker.com/youtube-channel-id.php) 輸入頻道 URL
2. 或在頻道頁面 View Source 找 `"channelId":"UC..."`

**重要**：該頻道必須有公開繁中或中文字幕（人工或自動皆可），否則該節目會被全部跳過。

## 自動更新流程

`.github/workflows/update.yml`：

1. 每日 UTC 23:00（**台北 07:00**）觸發
2. 安裝 yt-dlp + `npm ci` → `npm run update`
3. Pipeline 對每個 podcast：
   - 用 yt-dlp 列頻道最新 N 部影片
   - 比對 `data/processed.json` 的 videoId 去重
   - 下載字幕（VTT/SRT，優先人工字幕、其次自動字幕）
   - 把字幕轉成 `[MM:SS] 內容` 的逐句 transcript
   - 呼叫 Gemini 產生筆記本級 JSON 摘要
   - 寫入 `src/content/episodes/<id>-<hash>.md`
   - 單一節目失敗會 log 並繼續下一個
4. 有新集數則自動 commit 並 push（含 git pull --rebase 處理 race condition）
5. push 觸發 Vercel 自動 redeploy
6. 完整 log 上傳為 artifact，保留 14 天

手動觸發：GitHub repo → Actions → "Daily Podcast Update" → Run workflow。

## 部署 (Vercel)

1. 在 [Vercel](https://vercel.com/new) 從 GitHub import 這個 repo
2. Framework preset 會自動偵測為 **Astro**
3. Build command: `npm run build`（預設）
4. Output: `dist`（預設）
5. **不需要**在 Vercel 設定環境變數（網站純靜態，LLM 在 GitHub Actions 中跑）

## GitHub Secrets 設定

到 repo → Settings → Secrets and variables → Actions：

**Secrets**（必填）：
- `GEMINI_API_KEY` — Google AI Studio 取得，**免費層每天 1500 次請求** 對單一頻道綽綽有餘

**Variables**（選填）：
- `LLM_PROVIDER`、`GEMINI_MODEL`、`MAX_NEW_EPISODES_PER_PODCAST`

## 檔案結構

```
.
├── podcasts.config.json        # ⭐ 新增節目改這裡
├── src/
│   ├── content.config.ts        # Content Collection schema
│   ├── content/episodes/*.md    # 摘要檔（pipeline 自動產生）
│   ├── layouts/BaseLayout.astro
│   └── pages/
│       ├── index.astro          # 首頁
│       ├── about.astro
│       └── episodes/[id].astro  # 單集頁
├── scripts/update-podcasts.ts   # 抓取與摘要流程
├── data/processed.json          # videoId 去重索引
└── .github/workflows/update.yml # 每日排程
```

## 摘要欄位（筆記本級）

每集 markdown frontmatter 包含：

- `oneLiner` — 一句話總結
- `summary` — 300~500 字整集摘要
- `keyPoints[]` — 10~20 條重點
- `keywords[]` — 3~6 個關鍵字
- `sections[{heading,content}]` — 6~12 個逐段筆記
- `glossary[{term,definition}]` — 3~8 個名詞解釋
- `quotes[]` — 2~5 句金句
- `timestamps[{time,label}]` — 6~12 個時間點

## 維護備忘

- **想重新生成某集**：刪除 `src/content/episodes/<那一集>.md` 並從 `data/processed.json` 移除對應 videoId
- **想換模型**：改 `GEMINI_MODEL` env 即可（建議 `gemini-2.5-flash` 或 `gemini-2.5-pro`）
- **配額用完**：調低 `MAX_NEW_EPISODES_PER_PODCAST`

## License

MIT
