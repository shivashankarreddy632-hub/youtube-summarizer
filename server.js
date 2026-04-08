import express from "express";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import https from "https";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

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

// Helper: fetch a URL with browser-like headers
function fetchWithHeaders(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0",
      },
    };

    https
      .get(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      })
      .on("error", reject);
  });
}

// Helper: extract transcript from YouTube page HTML
async function fetchTranscriptFromYouTube(videoId) {
  // Step 1: Get the video page to extract the timedtext token
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageRes = await fetchWithHeaders(videoUrl);

  if (pageRes.status !== 200) {
    throw new Error(`YouTube returned status ${pageRes.status}`);
  }

  const html = pageRes.body;

  // Extract the caption tracks JSON from the page
  const captionMatch = html.match(/"captions":\s*(\{.*?"captionTracks":\s*\[.*?\]\s*.*?\})/s);
  
  if (!captionMatch) {
    // Try alternate pattern
    const altMatch = html.match(/"captionTracks":\[(\{.*?\})\]/s);
    if (!altMatch) {
      throw new Error("No captions available for this video");
    }
  }

  // Extract baseUrl from captionTracks
  const trackMatch = html.match(/"baseUrl":"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/);
  if (!trackMatch) {
    throw new Error("Could not extract caption track URL");
  }

  let captionUrl = trackMatch[1].replace(/\\u0026/g, "&").replace(/\\/g, "");

  // Prefer English captions
  const allTracks = [...html.matchAll(/"baseUrl":"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/g)];
  for (const match of allTracks) {
    const url = match[1].replace(/\\u0026/g, "&").replace(/\\/g, "");
    if (url.includes("lang=en") || url.includes("lang=en-")) {
      captionUrl = url;
      break;
    }
  }

  // Step 2: Fetch the transcript XML
  const transcriptRes = await fetchWithHeaders(captionUrl);
  if (transcriptRes.status !== 200) {
    throw new Error("Failed to fetch transcript XML");
  }

  const xml = transcriptRes.body;

  // Parse transcript text from XML
  const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  if (textMatches.length === 0) {
    throw new Error("Transcript XML is empty or malformed");
  }

  const transcript = textMatches
    .map((m) =>
      m[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, "")
        .trim()
    )
    .filter(Boolean)
    .join(" ");

  return transcript;
}

// Summarize endpoint — API key stays server-side
app.post("/api/summarize", async (req, res) => {
  const { url, language } = req.body;

  if (!url || !language) {
    return res.status(400).json({ error: "Missing url or language" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "Server is not configured. Add GROQ_API_KEY to .env file. Get a free key at https://console.groq.com",
    });
  }

  // Step 1: Extract video ID
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res
      .status(400)
      .json({
        error:
          "Could not extract video ID from URL. Please use a valid YouTube URL.",
      });
  }

  // Step 2: Fetch YouTube transcript
  let transcriptText = "";
  try {
    console.log(`Fetching transcript for video: ${videoId}`);
    transcriptText = await fetchTranscriptFromYouTube(videoId);

    // Trim transcript to ~12000 words to stay within context limits
    const words = transcriptText.split(" ");
    if (words.length > 12000) {
      transcriptText = words.slice(0, 12000).join(" ") + "...";
    }

    console.log(
      `Transcript fetched: ${transcriptText.split(" ").length} words`
    );
  } catch (transcriptErr) {
    console.error("Transcript error:", transcriptErr.message);
    return res.status(422).json({
      error:
        "Could not fetch transcript. This video may have disabled captions, be private, age-restricted, or not have English captions. Please try another video.",
    });
  }

  // Step 3: Summarize with Groq (free LLaMA 3 model)
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
    console.error("Groq API error:", err);
    if (err.status === 401) {
      return res.status(401).json({
        error:
          "Invalid Groq API key. Get a free key at https://console.groq.com",
      });
    }
    if (err.status === 429) {
      return res
        .status(429)
        .json({
          error: "Rate limit reached. Please wait a moment and try again.",
        });
    }
    res
      .status(500)
      .json({ error: err.message || "An unexpected error occurred." });
  }
});

// Serve React app for all other routes in production
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 YT Summarizer running at http://localhost:${PORT}`);
  console.log(`   ✅ Using: Groq AI (Free) — llama-3.3-70b-versatile`);
  console.log(`   📡 API:   http://localhost:${PORT}/api/summarize\n`);
});
