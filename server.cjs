"use strict";

const express  = require("express");
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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", provider: "Groq AI (Free)" });
});

// ─── Extract YouTube video ID ─────────────────────────────────────────────────
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

// ─── Decode HTML entities in subtitle text ────────────────────────────────────
function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ─── METHOD 1: @distube/ytdl-core (signed subtitle URLs) ─────────────────────
// ytdl-core fetches the YouTube player page and extracts SIGNED subtitle URLs
// that YouTube generates. These signed URLs work from any IP because YouTube
// generates them server-side. This bypasses cloud IP blocking completely.
async function fetchTranscriptViaYtdl(videoId) {
  const ytdl = require("@distube/ytdl-core");
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const info = await ytdl.getInfo(videoUrl, {
    requestOptions: {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "",
      },
    },
  });

  const captionTracks =
    info.player_response?.captions?.playerCaptionsTracklistRenderer
      ?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error("ytdl: no caption tracks found for this video");
  }

  // Prefer English manual → English auto → any language
  const track =
    captionTracks.find(t => t.languageCode === "en" && !t.kind) ||
    captionTracks.find(t => t.languageCode === "en") ||
    captionTracks.find(t => t.languageCode?.startsWith("en")) ||
    captionTracks[0];

  console.log(`[ytdl] Using caption track: ${track.languageCode} (${track.name?.simpleText || ""})`);

  // Fetch the XML subtitle file using the signed URL
  const resp = await fetch(track.baseUrl + "&fmt=json3");
  if (!resp.ok) throw new Error(`ytdl: caption fetch failed HTTP ${resp.status}`);

  const data   = await resp.json();
  const events = data.events || [];

  const text = events
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || "").join(""))
    .join(" ")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 50) throw new Error("ytdl: transcript text too short");
  return decodeHtml(text);
}

// ─── METHOD 2: youtubei.js InnerTube API (Android client) ────────────────────
// YouTube's internal API — uses the same protocol the YouTube Android app uses.
async function fetchTranscriptInnertube(videoId) {
  const { Innertube } = await import("youtubei.js");

  // ANDROID client is less restricted than WEB on cloud IPs
  const yt = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
    client_type: "ANDROID",
  });

  const info           = await yt.getInfo(videoId);
  const transcriptData = await info.getTranscript();

  const segments =
    transcriptData?.transcript?.content?.body?.initial_segments ??
    transcriptData?.transcript?.content?.body?.items ??
    [];

  if (!segments.length) throw new Error("innertube: no segments");

  const text = segments
    .map(s => s?.snippet?.text ?? s?.transcript_segment_renderer?.snippet?.text ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 50) throw new Error("innertube: text too short");
  return text;
}

// ─── METHOD 3: yt-dlp (installed via pip in Dockerfile) ──────────────────────
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
  for (const flag of ["--write-auto-sub", "--write-subs"]) {
    try {
      await execFileAsync("yt-dlp", [flag, ...baseArgs], { timeout: 40_000 });
      const f = fs.readdirSync(tmpDir).find(x => x.endsWith(".json3"));
      if (f) { downloaded = true; break; }
    } catch {}
  }

  if (!downloaded) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw new Error("yt-dlp: no subtitle file produced");
  }

  const json3 = fs.readdirSync(tmpDir).find(x => x.endsWith(".json3"));
  const data  = JSON.parse(fs.readFileSync(path.join(tmpDir, json3), "utf8"));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const text = (data.events || [])
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || "").join(""))
    .join(" ")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 50) throw new Error("yt-dlp: text too short");
  return text;
}

// ─── Master: try each method once, stop on first success ─────────────────────
async function fetchTranscript(videoId) {
  const methods = [
    { name: "ytdl-core (signed URLs)", fn: fetchTranscriptViaYtdl },
    { name: "InnerTube-Android",       fn: fetchTranscriptInnertube },
    { name: "yt-dlp",                  fn: fetchTranscriptYtDlp },
  ];

  for (const { name, fn } of methods) {
    try {
      console.log(`[transcript] Trying: ${name}`);
      const text = await fn(videoId);
      console.log(`[transcript] ✅ ${name} succeeded — ${text.split(" ").length} words`);
      return text;
    } catch (e) {
      console.warn(`[transcript] ❌ ${name} failed: ${e.message}`);
    }
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
    return res.status(500).json({ error: "Server not configured — GROQ_API_KEY missing." });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ error: "Could not extract video ID. Please use a valid YouTube URL." });

  // Step 2: Fetch transcript
  let transcriptText;
  try {
    console.log(`\n▶  videoId=${videoId}`);
    transcriptText = await fetchTranscript(videoId);
    const words = transcriptText.split(" ");
    if (words.length > 12000) transcriptText = words.slice(0, 12000).join(" ") + "…";
  } catch (err) {
    console.error("Transcript error — all methods exhausted:", err.message);
    return res.status(422).json({
      error:
        "Cannot fetch transcript for this video. " +
        "The video may not have captions, or may be too new/private. " +
        "Try a different video that has captions enabled.",
    });
  }

  // Step 3: Summarize with Groq AI
  try {
    const prompt = `You are an expert video summarizer. Summarise the following YouTube transcript entirely in ${language}.

TRANSCRIPT:
${transcriptText}

Respond in Markdown:
## Title — concise heading
## Overview — 2–3 paragraphs
## Key Takeaways — 5–8 bullet points
## Tone & Sentiment — brief note

Respond entirely in ${language}.`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!groqRes.ok) {
      const e = await groqRes.json();
      if (groqRes.status === 401) return res.status(401).json({ error: "Invalid Groq API key." });
      if (groqRes.status === 429) return res.status(429).json({ error: "Rate limit. Please wait." });
      throw new Error(e?.error?.message || "Groq API failed");
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
  console.log(`\n🚀 YT Summarizer → http://localhost:${PORT}`);
  console.log(`   AI: Groq llama-3.3-70b-versatile\n`);
});
