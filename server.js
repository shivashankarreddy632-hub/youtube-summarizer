import express from "express";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "2mb" }));

// Serve static build files in production
app.use(express.static(path.join(__dirname, "dist")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", provider: "Groq (Free)" });
});

// Helper: extract YouTube video ID from any URL format
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Fetch YouTube page HTML with browser-like headers
async function fetchYouTubePage(videoId) {
  const { default: fetch } = await import("node-fetch");
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) throw new Error(`YouTube page returned ${response.status}`);
  return response.text();
}

// Extract caption URL from page HTML
function extractCaptionUrl(html) {
  // Look for captionTracks in the page JSON data
  const splitHtml = html.split('"captionTracks":');
  if (splitHtml.length < 2) {
    throw new Error("No caption tracks found — this video may not have captions");
  }

  const captionData = splitHtml[1].split(',"audioTracks"')[0];
  
  // Parse base URLs from caption tracks
  const baseUrlMatches = [...captionData.matchAll(/"baseUrl":"([^"]+)"/g)];
  if (!baseUrlMatches.length) {
    throw new Error("Could not extract caption URL");
  }

  // Prefer English captions
  let captionUrl = null;
  
  // Try to find English caption
  const nameMatches = [...captionData.matchAll(/"vssId":"([^"]+)"/g)];
  const allUrls = baseUrlMatches.map((m, i) => ({
    url: m[1].replace(/\\u0026/g, "&"),
    vssId: nameMatches[i]?.capture?.[1] || "",
  }));

  // Try asr (auto-generated) english first, then any english
  for (const track of allUrls) {
    if (track.url.includes("lang=en")) {
      captionUrl = track.url;
      break;
    }
  }

  // Fallback to first available
  if (!captionUrl) {
    captionUrl = baseUrlMatches[0][1].replace(/\\u0026/g, "&");
  }

  return captionUrl;
}

// Fetch and parse transcript XML
async function fetchTranscriptXml(captionUrl) {
  const { default: fetch } = await import("node-fetch");
  
  // Add fmt=json3 for JSON format (easier to parse)
  const jsonUrl = captionUrl + "&fmt=json3";
  
  const response = await fetch(jsonUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) throw new Error(`Caption fetch returned ${response.status}`);
  
  const data = await response.json();
  
  // Parse JSON3 format
  const events = data?.events || [];
  const transcript = events
    .filter((e) => e.segs)
    .flatMap((e) => e.segs.map((s) => s.utf8 || ""))
    .join(" ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return transcript;
}

// Main transcript fetcher
async function getTranscript(videoId) {
  const html = await fetchYouTubePage(videoId);
  const captionUrl = extractCaptionUrl(html);
  const transcript = await fetchTranscriptXml(captionUrl);
  
  if (!transcript || transcript.trim().length < 50) {
    throw new Error("Transcript too short or empty");
  }
  
  return transcript;
}

// Summarize endpoint
app.post("/api/summarize", async (req, res) => {
  const { url, language } = req.body;

  if (!url || !language) {
    return res.status(400).json({ error: "Missing url or language" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Server is not configured. Add GROQ_API_KEY to .env file.",
    });
  }

  // Step 1: Extract video ID
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({
      error: "Could not extract video ID. Please use a valid YouTube URL.",
    });
  }

  // Step 2: Fetch transcript server-side
  let transcriptText = "";
  try {
    console.log(`Fetching transcript for: ${videoId}`);
    transcriptText = await getTranscript(videoId);

    // Trim to ~12000 words
    const words = transcriptText.split(" ");
    if (words.length > 12000) {
      transcriptText = words.slice(0, 12000).join(" ") + "...";
    }
    console.log(`Got transcript: ${transcriptText.split(" ").length} words`);
  } catch (transcriptErr) {
    console.error("Transcript error:", transcriptErr.message);
    return res.status(422).json({
      error: "Could not fetch transcript. This video may have disabled captions, be private, or age-restricted. Please try a video that has English subtitles enabled.",
    });
  }

  // Step 3: Summarize with Groq AI
  try {
    const groq = new Groq({ apiKey });

    const prompt = `You are an expert video summarizer. Below is the transcript of a YouTube video. Please provide a comprehensive summary entirely in ${language}.

TRANSCRIPT:
${transcriptText}

Please structure your response in Markdown with the following sections:
1. A concise title as an H1 heading (## Title)
2. ## Overview — A 2-3 paragraph high-level summary
3. ## Key Takeaways — A bulleted list of 5-8 key points
4. ## Tone & Sentiment — A brief note on the video's overall tone

Respond entirely in ${language}. Use proper Markdown formatting.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 2048,
    });

    const text = completion.choices[0]?.message?.content;
    if (!text) throw new Error("Empty response from AI");

    res.json({ summary: text });
  } catch (err) {
    console.error("Groq error:", err);
    if (err.status === 401) {
      return res.status(401).json({ error: "Invalid Groq API key." });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: "Rate limit reached. Please wait and try again." });
    }
    res.status(500).json({ error: err.message || "An unexpected error occurred." });
  }
});

// Serve React app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 YT Summarizer running at http://localhost:${PORT}`);
  console.log(`   ✅ Using: Groq AI (Free) — llama-3.3-70b-versatile`);
  console.log(`   📡 API:   http://localhost:${PORT}/api/summarize\n`);
});
