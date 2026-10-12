// Point d'entrée de l'assistant : POST /api/ask { question }
// 1. Claude reformule la question en requêtes de recherche
// 2. BM25 retrouve les passages officiels les plus pertinents (fusion des requêtes)
// 3. Claude répond uniquement à partir de ces passages, en citant ses sources

import data from "./data/chunks.json" with { type: "json" };
import { Retriever } from "./lib/retriever.mjs";
import { REWRITE_PROMPT, ANSWER_PROMPT, formatSources } from "./lib/prompts.mjs";

const retriever = new Retriever(data.chunks);
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const API = "https://api.anthropic.com/v1/messages";

// Limite simple par adresse IP et par instance, contre les abus et les coûts surprises.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 3600_000, max = 20;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

async function claude(system, user, maxTokens) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.content.map((b) => b.text || "").join("");
}

// Reciprocal Rank Fusion : combine les classements des différentes reformulations.
function fuse(lists, k = 6) {
  const score = new Map(), byId = new Map();
  for (const list of lists) {
    list.forEach((c, rank) => {
      score.set(c.id, (score.get(c.id) || 0) + 1 / (60 + rank));
      byId.set(c.id, c);
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => byId.get(id));
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "Utilisez POST avec { question }." }, 405);
  let question = "";
  try {
    question = String((await req.json()).question || "").trim();
  } catch {
    return json({ error: "Requête illisible." }, 400);
  }
  if (question.length < 5) return json({ error: "Posez une question un peu plus détaillée." }, 400);
  if (question.length > 600) return json({ error: "Question trop longue : 600 caractères maximum." }, 400);
  if (limited(context.ip || "anon")) return json({ error: "Trop de questions en peu de temps. Réessayez dans une heure." }, 429);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "L'assistant n'est pas encore configuré (clé API manquante)." }, 503);

  const t0 = Date.now();
  let queries = [question];
  try {
    const raw = await claude(REWRITE_PROMPT, question, 200);
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (Array.isArray(parsed.queries)) queries = [question, ...parsed.queries.slice(0, 3)];
  } catch {
    // la reformulation est un plus : sans elle, on cherche avec la question telle quelle
  }
  const passages = fuse(queries.map((q) => retriever.search(q, { k: 8 })), 6);
  const tRetrieve = Date.now() - t0;

  if (!passages.length) {
    return json({
      answer: "Je n'ai trouvé aucune page officielle qui traite de cette question. Essayez de la reformuler, ou adressez-vous directement à l'office cantonal concerné.",
      sources: [], queries, timings: { retrieval_ms: tRetrieve },
    });
  }

  try {
    const answer = await claude(ANSWER_PROMPT, `${formatSources(passages)}\n\nQUESTION : ${question}`, 900);
    const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]));
    const sources = passages.map((p, i) => ({ n: i + 1, title: p.title, url: p.url, site: p.site, excerpt: p.text.slice(0, 280), cited: used.has(i + 1) }));
    return json({ answer, sources, queries, timings: { retrieval_ms: tRetrieve, total_ms: Date.now() - t0 }, model: MODEL });
  } catch (e) {
    return json({ error: "Le service de réponse est momentanément indisponible. Réessayez dans un instant.", detail: String(e).slice(0, 120) }, 502);
  }
};

export const config = { path: "/api/ask" };
