import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { YoutubeTranscript } from "youtube-transcript";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Serve static build files in production
app.use(express.static(path.join(__dirname, "dist")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", provider: "Google Gemini (Free)" });
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

// Summarize endpoint
app.post("/api/summarize", async (req, res) => {
  const { url, language } = req.body;

  if (!url || !language) {
    return res.status(400).json({ error: "Missing url or language" });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Server not configured. Add GOOGLE_API_KEY environment variable.",
    });
  }

  // Step 1: Extract video ID
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({
      error: "Could not extract video ID. Please use a valid YouTube URL.",
    });
  }

  // Step 2: Fetch transcript
  let transcriptText = "";
  try {
    console.log(`Fetching transcript for: ${videoId}`);
    let items;
    try {
      items = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
    } catch {
      // Fallback: try without language filter
      items = await YoutubeTranscript.fetchTranscript(videoId);
    }
    transcriptText = items.map((t) => t.text).join(" ");

    // Trim to ~12000 words
    const words = transcriptText.split(" ");
    if (words.length > 12000) {
      transcriptText = words.slice(0, 12000).join(" ") + "...";
    }
    console.log(`Transcript: ${transcriptText.split(" ").length} words`);
  } catch (err) {
    console.error("Transcript error:", err.message);
    return res.status(422).json({
      error:
        "Could not fetch transcript. This video may have disabled captions, be private, or age-restricted. Please try another video.",
    });
  }

  // Step 3: Summarize with Google Gemini
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `You are an expert video summarizer. Below is the transcript of a YouTube video. Please provide a comprehensive summary entirely in ${language}.

TRANSCRIPT:
${transcriptText}

Please structure your response in Markdown with the following sections:
1. A concise title as an H1 heading (## Title)
2. ## Overview — A 2-3 paragraph high-level summary
3. ## Key Takeaways — A bulleted list of 5-8 key points
4. ## Tone & Sentiment — A brief note on the video's overall tone

Respond entirely in ${language}. Use proper Markdown formatting.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    if (!text) throw new Error("Empty response from AI");

    res.json({ summary: text });
  } catch (err) {
    console.error("Gemini error:", err);
    if (err.status === 401 || err.message?.includes("API_KEY_INVALID")) {
      return res.status(401).json({ error: "Invalid Google API key." });
    }
    if (err.status === 429 || err.message?.includes("RESOURCE_EXHAUSTED")) {
      return res
        .status(429)
        .json({ error: "Rate limit reached. Please wait a moment." });
    }
    res.status(500).json({ error: err.message || "An unexpected error occurred." });
  }
});

// Serve React app for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 YT Summarizer running at http://localhost:${PORT}`);
  console.log(`   ✅ Using: Google Gemini AI (Free) — gemini-1.5-flash`);
  console.log(`   📡 API:   http://localhost:${PORT}/api/summarize\n`);
});
