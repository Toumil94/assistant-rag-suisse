// Point d'entrée de l'assistant : POST /api/ask { question }
//
// 1. (si une IA est configurée) le LLM reformule la question en requêtes de recherche
// 2. BM25 + synonymes métier retrouve les passages officiels, fusion des requêtes (RRF)
// 3a. mode « rédigé » : le LLM répond uniquement à partir des passages, en citant [n]
// 3b. mode « extraits » (sans clé, ou quota gratuit atteint) : les phrases officielles
//     les plus pertinentes sont citées telles quelles. Gratuit et toujours disponible.
//
// Le corpus est relu depuis GitHub (mis à jour chaque semaine) : pas besoin de
// redéployer le site quand les données changent.

import bundled from "./data/chunks.json" with { type: "json" };
import { Retriever } from "./lib/retriever.mjs";
import { REWRITE_PROMPT, ANSWER_PROMPT, formatSources } from "./lib/prompts.mjs";
import { chat, llmAvailable, llmProvider, QuotaError } from "./lib/llm.mjs";
import { extractiveAnswer } from "./lib/extractive.mjs";

const DATA_URL = "https://raw.githubusercontent.com/Toumil94/assistant-rag-suisse/main/netlify/functions/data/chunks.json";
const REFRESH_MS = 6 * 3600_000;
let corpus = { retriever: new Retriever(bundled.chunks), meta: bundled.meta, loadedAt: 0 };

async function getCorpus() {
  if (Date.now() - corpus.loadedAt < REFRESH_MS) return corpus;
  corpus.loadedAt = Date.now(); // une seule tentative par période, même en cas d'échec
  try {
    const r = await fetch(DATA_URL, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      if (d.chunks?.length) corpus = { retriever: new Retriever(d.chunks), meta: d.meta, loadedAt: Date.now() };
    }
  } catch {
    // on garde la version embarquée dans la fonction
  }
  return corpus;
}

// Limite simple par adresse IP et par instance, contre les abus.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 3600_000, max = 30;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
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
  if (limited(context?.ip || "anon")) return json({ error: "Trop de questions en peu de temps. Réessayez dans une heure." }, 429);

  const t0 = Date.now();
  const { retriever } = await getCorpus();
  let useLLM = llmAvailable();
  let note = useLLM ? null : "no_key";

  let queries = [question];
  if (useLLM) {
    try {
      const raw = await chat(REWRITE_PROMPT, question, 200);
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (Array.isArray(parsed.queries)) queries = [question, ...parsed.queries.slice(0, 3)];
    } catch (e) {
      if (e instanceof QuotaError) { useLLM = false; note = "quota"; }
      // sinon : la reformulation est un plus, on cherche avec la question telle quelle
    }
  }
  const passages = fuse(queries.map((q) => retriever.search(q, { k: 8 })), 6);
  const tRetrieve = Date.now() - t0;

  if (!passages.length) {
    return json({
      answer: "Je n'ai trouvé aucune page officielle qui traite de cette question. Essayez de la reformuler avec d'autres mots, ou adressez-vous directement à l'office cantonal concerné.",
      mode: "none", sources: [], queries, timings: { retrieval_ms: tRetrieve },
    });
  }

  let answer = null, mode = "extractive";
  if (useLLM) {
    try {
      answer = await chat(ANSWER_PROMPT, `${formatSources(passages)}\n\nQUESTION : ${question}`, 900);
      mode = "generative";
    } catch (e) {
      note = e instanceof QuotaError ? "quota" : "llm_error";
    }
  }
  if (!answer) answer = extractiveAnswer(question, passages, retriever) ||
    "Les pages officielles ci-dessous sont les plus proches de votre question. Ouvrez-les pour le détail.";

  const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]));
  const sources = passages.map((p, i) => ({ n: i + 1, title: p.title, url: p.url, site: p.site, excerpt: p.text.slice(0, 280), cited: used.has(i + 1) }));
  return json({
    answer, mode, note, sources, queries,
    model: mode === "generative" ? llmProvider().model : null,
    timings: { retrieval_ms: tRetrieve, total_ms: Date.now() - t0 },
  });
};

export const config = { path: "/api/ask" };
