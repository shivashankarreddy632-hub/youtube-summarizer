/**
 * YouTube Summarizer — Premium Redesign
 * Public-ready with backend API proxy (Groq AI — Free)
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Youtube,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Copy,
  Download,
  History,
  Trash2,
  Languages,
  X,
  Check,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import "./index.css";

interface SummaryResult {
  id: string;
  url: string;
  title: string;
  summary: string;
  language: string;
  timestamp: number;
}

const SUPPORTED_LANGUAGES = [
  { label: "English", value: "English" },
  { label: "Hindi (हिन्दी)", value: "Hindi" },
  { label: "Telugu (తెలుగు)", value: "Telugu" },
  { label: "Tamil (தமிழ்)", value: "Tamil" },
  { label: "Kannada (ಕನ್ನಡ)", value: "Kannada" },
  { label: "Malayalam (മലയാളം)", value: "Malayalam" },
];

const LOADING_STEPS = [
  "Fetching YouTube transcript...",
  "Analyzing with Llama 3 AI...",
  "Generating summary...",
];

export default function App() {
  const [url, setUrl] = useState("");
  const [selectedLang, setSelectedLang] = useState("English");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SummaryResult[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load history from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("yt_summarizer_history");
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    }
  }, []);

  // Save history to localStorage
  useEffect(() => {
    localStorage.setItem("yt_summarizer_history", JSON.stringify(history));
  }, [history]);

  const validateUrl = (u: string) => {
    const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
    return pattern.test(u);
  };

  const summarizeVideo = async () => {
    if (!url.trim()) {
      setError("Please enter a YouTube URL");
      return;
    }
    if (!validateUrl(url)) {
      setError("Please enter a valid YouTube URL (e.g. https://youtube.com/watch?v=...)");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, language: selectedLang }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to summarize video");
      }

      const text: string = data.summary;
      if (!text) throw new Error("Empty response from AI");

      const lines = text.split("\n");
      const title = lines[0].replace(/^#+\s*/, "").trim() || "Video Summary";

      const newResult: SummaryResult = {
        id: Math.random().toString(36).substring(7),
        url,
        title,
        summary: text,
        language: selectedLang,
        timestamp: Date.now(),
      };

      setResult(newResult);
      setHistory((prev) => [newResult, ...prev.slice(0, 9)]);
    } catch (err: any) {
      console.error("Summarization error:", err);
      setError(err.message || "An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadSummary = () => {
    if (!result) return;
    const blob = new Blob([result.summary], { type: "text/markdown" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `${result.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_summary.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory((prev) => prev.filter((item) => item.id !== id));
  };

  const loadFromHistory = (item: SummaryResult) => {
    setResult(item);
    setUrl(item.url);
    setSelectedLang(item.language);
    setShowHistory(false);
    setError(null);
  };

  return (
    <>
      {/* Background Orbs */}
      <div className="bg-orb bg-orb-1" />
      <div className="bg-orb bg-orb-2" />
      <div className="bg-orb bg-orb-3" />

      {/* Header */}
      <header className="header">
        <div className="header-inner">
          <a className="header-logo" href="/">
            <div className="logo-icon">
              <Youtube size={20} color="white" />
            </div>
            <span className="logo-text">
              YT <span>Summarizer</span>
            </span>
          </a>

          <nav className="header-nav">
            <button
              id="history-toggle"
              onClick={() => setShowHistory(!showHistory)}
              className={`nav-btn ${showHistory ? "active" : ""}`}
            >
              <History size={15} />
              History
              {history.length > 0 && <span className="badge" />}
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="main">
        {/* Hero */}
        <div className="hero">
          <div className="hero-badge anim-fade-up">
            <Sparkles size={12} />
            Powered by Groq AI — Free &amp; Fast
          </div>
          <h1 className="hero-title anim-fade-up-delay-1">
            Summarize Any{" "}
            <span className="gradient-text">YouTube Video</span>
            <br />
            Instantly
          </h1>
          <p className="hero-sub anim-fade-up-delay-2">
            Paste a YouTube link, choose your language, and get a smart AI
            summary with key takeaways in seconds — completely free.
          </p>
        </div>

        {/* Input Section */}
        <div className="input-wrapper anim-fade-up-delay-2">
          {/* Language Pills */}
          <div className="lang-pills">
            {SUPPORTED_LANGUAGES.map((lang) => (
              <button
                key={lang.value}
                id={`lang-${lang.value.toLowerCase()}`}
                onClick={() => setSelectedLang(lang.value)}
                className={`lang-pill ${selectedLang === lang.value ? "selected" : ""}`}
              >
                {lang.label}
              </button>
            ))}
          </div>

          {/* URL Input */}
          <div className="input-glow-wrap">
            <div className="input-card">
              <div className="input-row">
                <div className="url-input-wrap">
                  <Youtube size={20} className="url-input-icon" />
                  <input
                    id="youtube-url-input"
                    type="text"
                    placeholder="Paste YouTube URL here..."
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && !loading && summarizeVideo()}
                    className="url-input"
                    spellCheck={false}
                  />
                </div>
                <button
                  id="summarize-btn"
                  onClick={summarizeVideo}
                  disabled={loading}
                  className="summarize-btn"
                >
                  {loading ? (
                    <>
                      <Loader2 size={16} className="spin" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <Sparkles size={16} />
                      Summarize
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="error-box"
              >
                <AlertCircle size={16} />
                {error}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Content Area */}
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="loading-state"
            >
              <div className="loading-spinner-wrap">
                <div className="loading-glow" />
                <Loader2 size={56} color="#ef4444" className="spin" style={{ position: "relative", zIndex: 1 }} />
              </div>
              <h3 className="loading-title">Analyzing Video</h3>
              <p className="loading-sub">Llama 3 is reading and summarizing in {selectedLang}...</p>
              <div className="loading-steps">
                {LOADING_STEPS.map((step, i) => (
                  <div key={i} className="step-item">
                    <span className="step-dot" />
                    {step}
                  </div>
                ))}
              </div>
            </motion.div>
          ) : result ? (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <div className="result-card">
                {/* Result Header */}
                <div className="result-header">
                  <div>
                    <div className="result-badge">
                      <CheckCircle2 size={11} />
                      {result.language} · Summary Ready
                    </div>
                    <h2 className="result-title">{result.title}</h2>
                  </div>
                  <div className="result-actions">
                    <button
                      id="copy-btn"
                      onClick={() => copyToClipboard(result.summary)}
                      className="action-btn"
                      title="Copy summary"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? "Copied!" : "Copy"}
                    </button>
                    <button
                      id="download-btn"
                      onClick={downloadSummary}
                      className="action-btn"
                      title="Download as Markdown"
                    >
                      <Download size={14} />
                      Download
                    </button>
                    <button
                      id="watch-btn"
                      onClick={() => window.open(result.url, "_blank")}
                      className="action-btn watch-btn"
                      title="Watch on YouTube"
                    >
                      <Youtube size={14} />
                      Watch
                    </button>
                  </div>
                </div>

                {/* Result Body */}
                <div className="result-body">
                  <div className="prose">
                    <ReactMarkdown>{result.summary}</ReactMarkdown>
                  </div>
                </div>

                {/* Result Footer */}
                <div className="result-footer">
                  <p className="result-meta">
                    Generated by Groq (Llama 3.3 70B) · {new Date(result.timestamp).toLocaleString()}
                  </p>
                  <button
                    className="action-btn"
                    onClick={() => { setResult(null); setUrl(""); }}
                    style={{ fontSize: "12px", padding: "6px 12px" }}
                  >
                    <X size={12} />
                    New Summary
                  </button>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="features-grid"
            >
              <div className="feature-card">
                <div className="feature-icon violet">
                  <Languages size={22} />
                </div>
                <h3 className="feature-title">Multilingual</h3>
                <p className="feature-desc">
                  Get summaries in English, Hindi, Telugu, Tamil, Kannada, or Malayalam.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon red">
                  <Youtube size={22} />
                </div>
                <h3 className="feature-title">Any Video</h3>
                <p className="feature-desc">
                  Works with educational content, news, tutorials, podcasts, and more.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon green">
                  <Download size={22} />
                </div>
                <h3 className="feature-title">Export Ready</h3>
                <p className="feature-desc">
                  Copy to clipboard or download as a clean Markdown file instantly.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* History Panel */}
      <AnimatePresence>
        {showHistory && (
          <div className="history-overlay">
            <motion.div
              className="history-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
            />
            <motion.div
              className="history-panel"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 350, damping: 35 }}
            >
              <div className="history-header">
                <span className="history-title">
                  <History size={15} />
                  Recent Summaries
                </span>
                <button
                  className="history-close"
                  onClick={() => setShowHistory(false)}
                >
                  Close
                </button>
              </div>

              <div className="history-list">
                {history.length === 0 ? (
                  <div className="history-empty">
                    <History size={32} style={{ margin: "0 auto 12px", display: "block", opacity: 0.3 }} />
                    No summaries yet.
                    <br />
                    Summarize a video to get started.
                  </div>
                ) : (
                  history.map((item) => (
                    <div
                      key={item.id}
                      className="history-item"
                      onClick={() => loadFromHistory(item)}
                    >
                      <p className="history-item-title">{item.title}</p>
                      <div className="history-item-meta">
                        <span className="history-date">
                          {new Date(item.timestamp).toLocaleDateString()}
                        </span>
                        <span className="history-lang">{item.language}</span>
                      </div>
                      <button
                        className="history-delete"
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-inner">
          <p>
            Built with React &amp; Groq AI (Llama 3) ❤️
            <br />
            <a
              href="https://console.groq.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Get your free Groq API key →
            </a>
          </p>
        </div>
      </footer>
    </>
  );
}
