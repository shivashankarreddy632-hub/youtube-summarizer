---
title: YT Summarizer
emoji: 🎬
colorFrom: red
colorTo: purple
sdk: docker
pinned: false
license: mit
---

<div align="center">

# 🎬 YT Summarizer

**Free AI-powered YouTube Video Summarizer**

Paste any YouTube link → Get a smart summary in seconds — powered by Groq AI (Llama 3), completely free.

[![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev)
[![Groq AI](https://img.shields.io/badge/Groq-Llama%203-orange)](https://console.groq.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## ✨ Features

- 🚀 **Instant summaries** of any YouTube video with captions
- 🌐 **6 languages**: English, Hindi, Telugu, Tamil, Kannada, Malayalam
- 🤖 **Powered by Groq AI** (Llama 3.3 70B) — 100% free
- 📋 **Copy or Download** summaries as Markdown
- 📜 **History panel** — stores last 10 summaries locally
- 🎨 **Premium glassmorphism UI** with dark mode

## 🚀 Deploy Locally

**Prerequisites:** Node.js 18+

```bash
# 1. Clone the repo
git clone https://github.com/shivashankarreddy632-hub/youtube-summarizer.git
cd youtube-summarizer

# 2. Install dependencies
npm install

# 3. Set your Groq API key
cp .env.example .env
# Edit .env and set GROQ_API_KEY=your_key_here

# 4. Run locally (frontend + backend)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## 🔑 Get a Free Groq API Key

1. Visit [console.groq.com](https://console.groq.com)
2. Sign up for free
3. Create an API key
4. Add it as `GROQ_API_KEY` in your environment

## 🐳 Hugging Face Spaces (Docker)

This app runs as a Docker container on Hugging Face Spaces.

Set the `GROQ_API_KEY` secret in your Space settings under **Settings → Repository secrets**.

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS v4 + Custom CSS |
| Animations | Motion (Framer Motion) |
| Backend | Node.js + Express |
| AI | Groq API — Llama 3.3 70B |
| Transcript | youtube-transcript |
