"use strict";

const express = require("express");
const dotenv  = require("dotenv");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
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

// ─── Method 1: youtubei.js (InnerTube API) ───────────────────────────────────
// Uses YouTube's own internal API — exactly what the YouTube website/app uses.
// YouTube cannot block this without breaking their own service.
// It handles authentication challenges, visitor data, and client emulation.
// Try multiple YouTube client types — ANDROID/TV are less restricted on cloud IPs
const INNERTUBE_CLIENTS = ["ANDROID", "TV_EMBEDDED", "WEB"];

async function fetchTranscriptInnertube(videoId) {
  const { Innertube, UniversalCache } = await import("youtubei.js");

  let lastErr;
  for (const clientType of INNERTUBE_CLIENTS) {
    try {
      console.log(`[innertube] Trying client: ${clientType}`);
      const yt = await Innertube.create({
        retrieve_player: false,
        generate_session_locally: true,
        client_type: clientType,
      });

      const info           = await yt.getInfo(videoId);
      const transcriptData = await info.getTranscript();

      const segments =
        transcriptData?.transcript?.content?.body?.initial_segments ??
        transcriptData?.transcript?.content?.body?.items ??
        [];

      if (!segments || segments.length === 0) {
        throw new Error(`${clientType}: empty segments`);
      }

      const text = segments
        .map(seg =>
          seg?.snippet?.text ??
          seg?.transcript_segment_renderer?.snippet?.text ??
          ""
        )
        .filter(Boolean)
        .join(" ")
        .replace(/[\n\r]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length < 50) throw new Error(`${clientType}: text too short`);
      return text;
    } catch (e) {
      console.warn(`[innertube] ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error("Innertube: all clients failed");
}

// ─── Method 2: yt-dlp with pip-installed version + cookies workaround ────────
async function fetchTranscriptYtDlp(videoId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-"));
  const ytUrl  = `https://www.youtube.com/watch?v=${videoId}`;
  const outTpl = path.join(tmpDir, "%(id)s");

  const baseArgs = [
    "--skip-download",
    "--sub-format", "json3",
    "--sub-langs",  "en,en-US,en-orig,en.*",
    "--no-playlist",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "-o", outTpl,
    ytUrl,
  ];

  let downloaded = false;
  for (const subFlag of ["--write-auto-sub", "--write-subs"]) {
    try {
      await execFileAsync("yt-dlp", [subFlag, ...baseArgs], { timeout: 40_000 });
      downloaded = true;
      break;
    } catch {}
  }
  if (!downloaded) throw new Error("yt-dlp: subtitle download failed");

  const files  = fs.readdirSync(tmpDir);
  const json3  = files.find(f => f.endsWith(".json3"));
  if (!json3) throw new Error("yt-dlp: no subtitle file generated");

  const raw  = fs.readFileSync(path.join(tmpDir, json3), "utf8");
  const data = JSON.parse(raw);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const text = (data.events || [])
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || "").join(""))
    .join(" ")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 50) throw new Error("yt-dlp: transcript text too short");
  return text;
}

// ─── Method 3: youtube-transcript library (last resort) ──────────────────────
async function fetchTranscriptLegacy(videoId) {
  const { YoutubeTranscript } = require("youtube-transcript");
  const browserHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
  };
  const customFetch = (u, init = {}) =>
    fetch(u, { ...init, headers: { ...init.headers, ...browserHeaders } });

  for (const fn of [
    () => YoutubeTranscript.fetchTranscript(videoId, { lang: "en", fetch: customFetch }),
    () => YoutubeTranscript.fetchTranscript(videoId, { fetch: customFetch }),
    () => YoutubeTranscript.fetchTranscript(videoId),
  ]) {
    try {
      const items = await fn();
      if (items && items.length > 0) return items.map(t => t.text).join(" ");
    } catch {}
  }
  throw new Error("youtube-transcript: no items returned");
}

// ─── Master transcript fetcher ────────────────────────────────────────────────
async function fetchTranscript(videoId) {
  // 1) InnerTube — uses YouTube's own internal API, hardest to block
  try {
    console.log("[transcript] Trying InnerTube (youtubei.js)…");
    const text = await fetchTranscriptInnertube(videoId);
    console.log(`[transcript] InnerTube OK  — ${text.split(" ").length} words`);
    return text;
  } catch (e) {
    console.warn(`[transcript] InnerTube failed: ${e.message}`);
  }

  // 2) yt-dlp — browser impersonation mode
  try {
    console.log("[transcript] Trying yt-dlp…");
    const text = await fetchTranscriptYtDlp(videoId);
    console.log(`[transcript] yt-dlp OK     — ${text.split(" ").length} words`);
    return text;
  } catch (e) {
    console.warn(`[transcript] yt-dlp failed: ${e.message}`);
  }

  // 3) youtube-transcript library (legacy)
  try {
    console.log("[transcript] Trying youtube-transcript (legacy)…");
    const text = await fetchTranscriptLegacy(videoId);
    console.log(`[transcript] Legacy OK     — ${text.split(" ").length} words`);
    return text;
  } catch (e) {
    console.warn(`[transcript] Legacy failed: ${e.message}`);
  }

  throw new Error("All transcript methods exhausted");
}

// ─── /api/summarize ───────────────────────────────────────────────────────────
app.post("/api/summarize", async (req, res) => {
  const { url, language } = req.body;
  if (!url || !language)
    return res.status(400).json({ error: "Missing url or language" });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey)
    return res.status(500).json({
      error: "Server not configured — GROQ_API_KEY missing.",
    });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({
      error: "Could not extract video ID. Please use a valid YouTube URL.",
    });

  // Step 2 — Fetch transcript
  let transcriptText;
  try {
    console.log(`\n▶  videoId=${videoId}`);
    transcriptText = await fetchTranscript(videoId);
    const words = transcriptText.split(" ");
    if (words.length > 12000)
      transcriptText = words.slice(0, 12000).join(" ") + "…";
  } catch (err) {
    console.error("Transcript error:", err.message);
    return res.status(422).json({
      error:
        "Could not get transcript for this video. " +
        "Make sure it has captions enabled. " +
        "If it's a brand-new video, captions may not be ready yet.",
    });
  }

  // Step 3 — Summarize with Groq AI
  try {
    const prompt = `You are an expert video summarizer. Summarise the following YouTube transcript entirely in ${language}.

TRANSCRIPT:
${transcriptText}

Respond in Markdown with:
1. ## Title — a concise H2 heading
2. ## Overview — 2–3 paragraph summary
3. ## Key Takeaways — 5–8 bullet points
4. ## Tone & Sentiment — brief note on the tone

Use proper Markdown. Respond entirely in ${language}.`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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

    if (!groqRes.ok) {
      const e = await groqRes.json();
      if (groqRes.status === 401)
        return res.status(401).json({ error: "Invalid Groq API key." });
      if (groqRes.status === 429)
        return res.status(429).json({ error: "Rate limit reached. Please wait." });
      throw new Error(e?.error?.message || "Groq API request failed");
    }

    const data = await groqRes.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Groq AI");

    res.json({ summary: text });
  } catch (err) {
    console.error("Groq error:", err);
    res.status(500).json({ error: err.message || "Unexpected error." });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 YT Summarizer at http://localhost:${PORT}`);
  console.log(`   ✅ AI:  Groq (llama-3.3-70b-versatile)`);
  console.log(`   📡 API: http://localhost:${PORT}/api/summarize\n`);
});
