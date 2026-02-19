const Parser = require("rss-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const parser = new Parser();

const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK env var");

// Estado (bom para cache no GitHub Actions)
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "state");
const SEEN_FILE = path.join(STATE_DIR, "seen.json");

// Quantas notícias novas mandar por execução
const MAX_POSTS_PER_RUN = Number(process.env.MAX_POSTS_PER_RUN || 3);

// RSS feeds (PT-BR + EN)
const FEEDS = [
  { name: "The Hacker News", lang: "EN", url: "https://feeds.feedburner.com/TheHackersNews" },
  { name: "TecMundo", lang: "PT-BR", url: "https://www.tecmundo.com.br/rss" },
  { name: "Canaltech", lang: "PT-BR", url: "https://feeds.feedburner.com/canaltech" },
  { name: "Olhar Digital", lang: "PT-BR", url: "https://olhardigital.com.br/feed/" },
  { name: "CERT.br", lang: "PT-BR", url: "https://www.cert.br/rss/" },
];

// Palavras-chave pra filtrar (PT/EN)
const KEYWORDS = [
  // EN
  "cve", "vulnerability", "exploit", "zero-day", "zeroday", "ransomware", "phishing",
  "malware", "botnet", "breach", "leak", "ddos", "cyber", "hacker", "hack",
  "backdoor", "trojan", "spyware", "credential", "stealer", "apt",
  // PT-BR
  "vulnerabilidade", "exploração", "exploit", "falha", "brecha", "vazamento", "golpe",
  "ransomware", "phishing", "malware", "invasão", "ataque", "ciber", "hacker",
  "sequestro", "dados", "credenciais", "roubo", "botnet", "spyware",
];

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadSeen() {
  ensureStateDir();

  // compat: se você usava lastNews.txt, não quebra
  const legacyLast = path.join(STATE_DIR, "lastNews.txt");
  let seen = [];

  if (fs.existsSync(SEEN_FILE)) {
    try {
      seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
      if (!Array.isArray(seen)) seen = [];
    } catch {
      seen = [];
    }
  } else if (fs.existsSync(legacyLast)) {
    const one = fs.readFileSync(legacyLast, "utf8").trim();
    if (one) seen = [one];
  }

  // garante unicidade
  return Array.from(new Set(seen));
}

function saveSeen(seenArr) {
  ensureStateDir();
  // mantém só os últimos 300 links pra não crescer infinito
  const trimmed = seenArr.slice(-300);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
}

function matchesCyber(title, contentSnippet) {
  const text = `${title || ""} ${contentSnippet || ""}`.toLowerCase();
  return KEYWORDS.some((k) => text.includes(k));
}

function parseDate(item) {
  const d =
    item.isoDate ||
    item.pubDate ||
    item.published ||
    item.updated ||
    null;

  const dt = d ? new Date(d) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt : null;
}

async function sendToDiscord(text) {
  await axios.post(WEBHOOK, { content: text });
}

async function fetchFeed(feed) {
  try {
    const data = await parser.parseURL(feed.url);
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map((it) => ({
      source: feed.name,
      lang: feed.lang,
      title: it.title || "(sem título)",
      link: it.link,
      date: parseDate(it),
      snippet: it.contentSnippet || it.content || "",
    })).filter((x) => !!x.link);
  } catch (e) {
    console.error(`Falha ao ler RSS (${feed.name}):`, e?.message || e);
    return [];
  }
}

async function run() {
  const seen = loadSeen();
  const seenSet = new Set(seen);

  // Busca todos os feeds em paralelo
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();

  // Filtra por cyber + remove já vistos
  const candidates = all
    .filter((x) => matchesCyber(x.title, x.snippet))
    .filter((x) => !seenSet.has(x.link));

  // Ordena por data (mais recente primeiro). Se não tiver data, joga pro fim.
  candidates.sort((a, b) => {
    const ta = a.date ? a.date.getTime() : 0;
    const tb = b.date ? b.date.getTime() : 0;
    return tb - ta;
  });

  if (candidates.length === 0) {
    console.log("Nenhuma notícia nova (cyber) 🚫");
    return;
  }

  const toPost = candidates.slice(0, MAX_POSTS_PER_RUN);

  for (const item of toPost) {
    const tag = item.lang === "PT-BR" ? "🇧🇷 PT-BR" : "🇺🇸 EN";
    const msg = `🛡️ ${tag} • **${item.source}**\n${item.title}\n${item.link}`;
    await sendToDiscord(msg);
    seenSet.add(item.link);
    console.log("Enviado:", item.title);
  }

  saveSeen(Array.from(seenSet));
  console.log(`OK ✅ Enviadas ${toPost.length} notícia(s).`);
}

run().catch((e) => {
  console.error("Erro ao executar bot:", e?.message || e);
  process.exit(1);
});