const { YoutubeTranscript } = require("youtube-transcript");

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { url, language } = body;

  if (!url || !language) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing url or language" }),
    };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server not configured. GROQ_API_KEY missing." }),
    };
  }

  // Step 1: Extract video ID
  const videoId = extractVideoId(url);
  if (!videoId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Could not extract video ID. Please use a valid YouTube URL." }),
    };
  }

  // Step 2: Fetch transcript
  let transcriptText = "";
  try {
    console.log(`Fetching transcript for: ${videoId}`);
    let items;
    try {
      items = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
    } catch {
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
    return {
      statusCode: 422,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "Could not fetch transcript. This video may have disabled captions, be private, or age-restricted.",
      }),
    };
  }

  // Step 3: Summarize with Groq AI
  try {
    const prompt = `You are an expert video summarizer. Below is the transcript of a YouTube video. Please provide a comprehensive summary entirely in ${language}.

TRANSCRIPT:
${transcriptText}

Please structure your response in Markdown with the following sections:
1. A concise title as an H1 heading (## Title)
2. ## Overview — A 2-3 paragraph high-level summary
3. ## Key Takeaways — A bulleted list of 5-8 key points
4. ## Tone & Sentiment — A brief note on the video's overall tone

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
      if (response.status === 401) {
        return {
          statusCode: 401,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid Groq API key." }),
        };
      }
      if (response.status === 429) {
        return {
          statusCode: 429,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Rate limit reached. Please wait a moment." }),
        };
      }
      throw new Error(errData?.error?.message || "Groq API request failed");
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;

    if (!text) throw new Error("Empty response from Groq AI");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: text }),
    };
  } catch (err) {
    console.error("Groq error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "An unexpected error occurred." }),
    };
  }
};
