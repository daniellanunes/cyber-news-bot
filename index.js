const Parser = require("rss-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const parser = new Parser();

const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK env var");

// Pasta/arquivo de estado (bom para GitHub Actions cache)
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "state");
const LAST_FILE = path.join(STATE_DIR, "lastNews.txt");

async function sendToDiscord(text) {
  await axios.post(WEBHOOK, { content: text });
}

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function getLastLink() {
  try {
    return fs.readFileSync(LAST_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function saveLastLink(link) {
  ensureStateDir();
  fs.writeFileSync(LAST_FILE, `${link}\n`);
}

async function run() {
  const feed = await parser.parseURL("https://feeds.feedburner.com/TheHackersNews");

  const latest = feed?.items?.[0];
  if (!latest?.link) throw new Error("No latest item/link found in RSS feed");

  const last = getLastLink();

  if (latest.link === last) {
    console.log("Nenhuma notícia nova 🚫");
    return;
  }

  const msg = `🛡️ ${latest.title}\n${latest.link}`;

  await sendToDiscord(msg);
  saveLastLink(latest.link);

  console.log("Nova notícia enviada 🚀");
}

run().catch((e) => {
  console.error("Erro ao executar bot:", e?.message || e);
  process.exit(1);
});