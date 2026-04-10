"use strict";

const express = require("express");
const dotenv   = require("dotenv");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

dotenv.config();

const execFileAsync = promisify(execFile);
const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, "dist")));

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", provider: "Groq AI (Free)" });
});

// ─── Helper: extract YouTube video ID ────────────────────────────────────────
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── Method 1: yt-dlp binary ─────────────────────────────────────────────────
// yt-dlp properly emulates a real YouTube client. It handles cloud-IP blocking
// that simple HTTP libraries cannot. Installed in Dockerfile.
async function fetchTranscriptYtDlp(videoId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-"));
  const ytUrl  = `https://www.youtube.com/watch?v=${videoId}`;
  const outTpl = path.join(tmpDir, "%(id)s");

  const langGroups = [
    ["en", "en-US", "en-GB", "en-orig"],
    ["en.*"],           // any English variant
    [".*"],             // absolutely any language
  ];

  let lastErr;
  for (const langs of langGroups) {
    for (const subFlag of ["--write-auto-sub", "--write-subs"]) {
      try {
        await execFileAsync(
          "yt-dlp",
          [
            "--skip-download",
            subFlag,
            "--sub-format", "json3",
            "--sub-langs",  langs.join(","),
            "--no-playlist",
            "--quiet",
            "-o", outTpl,
            ytUrl,
          ],
          { timeout: 35_000 }
        );

        const files   = fs.readdirSync(tmpDir);
        const json3   = files.find(f => f.endsWith(".json3"));
        if (!json3) continue;

        const raw     = fs.readFileSync(path.join(tmpDir, json3), "utf8");
        const data    = JSON.parse(raw);
        const text    = (data.events || [])
          .filter(e => e.segs)
          .map(e => e.segs.map(s => s.utf8 || "").join(""))
          .join(" ")
          .replace(/[\n\r]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (text.length > 50) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return text;
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  throw lastErr || new Error("yt-dlp: no subtitles found");
}

// ─── Method 2: youtube-transcript (legacy fallback) ──────────────────────────
// May work for some videos even on cloud IPs; kept as a last resort.
async function fetchTranscriptLegacy(videoId) {
  const { YoutubeTranscript } = require("youtube-transcript");
  const browserHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    Origin:  "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
  };

  const customFetch = (u, init = {}) =>
    fetch(u, { ...init, headers: { ...init.headers, ...browserHeaders } });

  const attempts = [
    () => YoutubeTranscript.fetchTranscript(videoId, { lang: "en", fetch: customFetch }),
    () => YoutubeTranscript.fetchTranscript(videoId, { fetch: customFetch }),
    () => YoutubeTranscript.fetchTranscript(videoId),
  ];

  let lastErr;
  for (const attempt of attempts) {
    try {
      const items = await attempt();
      if (items && items.length > 0) {
        return items.map(t => t.text).join(" ");
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("youtube-transcript: no items returned");
}

// ─── Master transcript fetcher: tries all methods in order ───────────────────
async function fetchTranscript(videoId) {
  // 1. yt-dlp (most reliable on cloud IPs)
  try {
    console.log(`[transcript] Trying yt-dlp…`);
    const text = await fetchTranscriptYtDlp(videoId);
    console.log(`[transcript] yt-dlp succeeded (${text.split(" ").length} words)`);
    return text;
  } catch (e) {
    console.warn(`[transcript] yt-dlp failed: ${e.message}`);
  }

  // 2. youtube-transcript library (fallback)
  try {
    console.log(`[transcript] Trying youtube-transcript library…`);
    const text = await fetchTranscriptLegacy(videoId);
    console.log(`[transcript] youtube-transcript succeeded (${text.split(" ").length} words)`);
    return text;
  } catch (e) {
    console.warn(`[transcript] youtube-transcript failed: ${e.message}`);
  }

  throw new Error("All transcript methods failed");
}

// ─── /api/summarize ───────────────────────────────────────────────────────────
app.post("/api/summarize", async (req, res) => {
  const { url, language } = req.body;

  if (!url || !language)
    return res.status(400).json({ error: "Missing url or language" });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey)
    return res.status(500).json({
      error: "Server not configured. Add GROQ_API_KEY environment variable.",
    });

  // Step 1 – Extract video ID
  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({
      error: "Could not extract video ID. Please use a valid YouTube URL.",
    });

  // Step 2 – Fetch transcript
  let transcriptText;
  try {
    console.log(`\n▶  Fetching transcript for: ${videoId}`);
    transcriptText = await fetchTranscript(videoId);

    // Trim to ~12 000 words so we don't exceed Groq context
    const words = transcriptText.split(" ");
    if (words.length > 12000) {
      transcriptText = words.slice(0, 12000).join(" ") + "…";
    }
  } catch (err) {
    console.error("Transcript error:", err.message);
    return res.status(422).json({
      error:
        "Could not fetch transcript for this video. " +
        "Make sure it has captions enabled (auto-generated or manual). " +
        "If the video is very new, captions may not be ready yet — try again in a few minutes.",
    });
  }

  // Step 3 – Summarize with Groq AI
  try {
    const prompt = `You are an expert video summarizer. Below is the transcript of a YouTube video. Provide a comprehensive summary entirely in ${language}.

TRANSCRIPT:
${transcriptText}

Structure your response in Markdown:
1. ## Title — a concise H2 heading
2. ## Overview — 2–3 paragraph high-level summary
3. ## Key Takeaways — bulleted list of 5–8 key points
4. ## Tone & Sentiment — brief note on the video's overall tone

Respond entirely in ${language}. Use proper Markdown formatting.`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      console.error("Groq API error:", errData);
      if (response.status === 401)
        return res.status(401).json({ error: "Invalid Groq API key." });
      if (response.status === 429)
        return res.status(429).json({ error: "Rate limit reached. Please wait a moment." });
      throw new Error(errData?.error?.message || "Groq API request failed");
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Groq AI");

    res.json({ summary: text });
  } catch (err) {
    console.error("Groq error:", err);
    res.status(500).json({ error: err.message || "An unexpected error occurred." });
  }
});

// Serve React SPA for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 YT Summarizer running at http://localhost:${PORT}`);
  console.log(`   ✅ AI:  Groq (llama-3.3-70b-versatile)`);
  console.log(`   📡 API: http://localhost:${PORT}/api/summarize\n`);
});
