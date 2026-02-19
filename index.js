const Parser = require("rss-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const parser = new Parser();

const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK env var");

// Estado
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "state");
const SEEN_FILE = path.join(STATE_DIR, "seen.json");

// Quantas notícias novas mandar por execução
const MAX_POSTS_PER_RUN = Number(process.env.MAX_POSTS_PER_RUN || 3);

// RSS feeds (PT-BR + EN) — adicionados fontes confiáveis
const FEEDS = [
  // Oficiais / segurança
  { name: "CISA Advisories", lang: "EN", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml" },
  { name: "Google Security Blog", lang: "EN", url: "https://security.googleblog.com/feeds/posts/default" },

  // Cyber jornalismo / pesquisa (muito usados)
  { name: "Krebs on Security", lang: "EN", url: "https://krebsonsecurity.com/feed/" },
  { name: "Schneier on Security", lang: "EN", url: "https://www.schneier.com/feed/atom/" },

  // Os seus
  { name: "The Hacker News", lang: "EN", url: "https://feeds.feedburner.com/TheHackersNews" },
  { name: "TecMundo", lang: "PT-BR", url: "https://www.tecmundo.com.br/rss" },
  { name: "Canaltech", lang: "PT-BR", url: "https://feeds.feedburner.com/canaltech" },
  { name: "Olhar Digital", lang: "PT-BR", url: "https://olhardigital.com.br/feed/" },
  { name: "CERT.br", lang: "PT-BR", url: "https://www.cert.br/rss/" },
];

// Palavras-chave
const KEYWORDS = [
  "cve","vulnerability","exploit","zero-day","zeroday","ransomware","phishing",
  "malware","botnet","breach","leak","ddos","cyber","hacker","hack",
  "backdoor","trojan","spyware","credential","stealer","apt",
  "vulnerabilidade","exploração","falha","brecha","vazamento","golpe",
  "invasão","ataque","ciber","sequestro","dados","credenciais","roubo",
];

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadSeen() {
  ensureStateDir();
  if (!fs.existsSync(SEEN_FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSeen(seenArr) {
  ensureStateDir();
  const trimmed = seenArr.slice(-600); // pode aumentar um pouco
  fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
}

function matchesCyber(title, contentSnippet) {
  const text = `${title || ""} ${contentSnippet || ""}`.toLowerCase();
  return KEYWORDS.some((k) => text.includes(k));
}

// ✅ remove tracking pra evitar repost do MESMO link com utm diferente
function normalizeLink(link) {
  try {
    const u = new URL(link);
    u.hash = "";

    // remove parâmetros típicos de tracking
    const toRemove = [];
    for (const [k] of u.searchParams.entries()) {
      const key = k.toLowerCase();
      if (
        key.startsWith("utm_") ||
        key === "utm" ||
        key === "ref" ||
        key === "fbclid" ||
        key === "gclid" ||
        key === "mc_cid" ||
        key === "mc_eid"
      ) toRemove.push(k);
    }
    toRemove.forEach((k) => u.searchParams.delete(k));

    // normaliza trailing slash
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return (link || "").trim();
  }
}

function parseDate(item) {
  const d = item.isoDate || item.pubDate || item.published || item.updated || null;
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

    return items
      .map((it) => {
        const rawLink = it.link || it.guid || "";
        const link = normalizeLink(rawLink);
        const guid = (it.guid || it.id || link || "").toString();

        return {
          source: feed.name,
          lang: feed.lang,
          title: it.title || "(sem título)",
          link,
          guid,
          date: parseDate(it),
          snippet: it.contentSnippet || it.content || "",
        };
      })
      .filter((x) => !!x.link);
  } catch (e) {
    console.error(`Falha ao ler RSS (${feed.name}):`, e?.message || e);
    return [];
  }
}

async function run() {
  const seen = loadSeen();
  const seenSet = new Set(seen);

  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();

  const candidates = all
    .filter((x) => matchesCyber(x.title, x.snippet))
    // ✅ usa link normalizado como chave
    .filter((x) => !seenSet.has(x.link));

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

    // marca como visto
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