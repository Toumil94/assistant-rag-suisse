// Évaluation de la recherche : la bonne page officielle est-elle retrouvée ?
// Compare plusieurs configurations sur eval/questions.yaml et écrit
// eval/results.json (lu par le site) et eval/RESULTS.md (lu sur GitHub).
//
//   node eval/run.mjs
//   GROQ_API_KEY=... node eval/run.mjs   # ajoute la reformulation par LLM (Groq, gratuit)

import { readFileSync, writeFileSync } from "node:fs";
import { Retriever, normalize } from "../netlify/functions/lib/retriever.mjs";
import { REWRITE_PROMPT } from "../netlify/functions/lib/prompts.mjs";
import { chat, llmAvailable, llmProvider } from "../netlify/functions/lib/llm.mjs";

const data = JSON.parse(readFileSync(new URL("../netlify/functions/data/chunks.json", import.meta.url)));
const retriever = new Retriever(data.chunks);

// Lecteur minimal du format de questions.yaml (une question, puis sa liste attendue).
const questions = [];
for (const line of readFileSync(new URL("./questions.yaml", import.meta.url), "utf8").split("\n")) {
  const q = line.match(/^- q:\s*(.+)$/);
  if (q) questions.push({ q: q[1].trim(), expect: [] });
  const e = line.match(/^\s+expect:\s*\[(.*)\]\s*$/);
  if (e && questions.length) questions.at(-1).expect = e[1].split(",").map((s) => normalize(s.trim())).filter(Boolean);
}

const isHit = (chunk, expect) => {
  const hay = normalize(chunk.url + " " + chunk.title).replace(/[-_/]+/g, " ");
  return expect.some((x) => hay.includes(x) || normalize(chunk.url).includes(x.replace(/ /g, "-")));
};

function fuse(lists, k) {
  const score = new Map(), byId = new Map();
  for (const list of lists) list.forEach((c, r) => { score.set(c.id, (score.get(c.id) || 0) + 1 / (60 + r)); byId.set(c.id, c); });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => byId.get(id));
}

async function rewrite(q) {
  try {
    const raw = await chat(REWRITE_PROMPT, q, 200);
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).queries || [];
  } catch {
    return [];
  }
}

const configs = [
  { name: "BM25 seul", run: async (q) => retriever.search(q, { k: 10, expand: false }) },
  { name: "BM25 + synonymes métier", run: async (q) => retriever.search(q, { k: 10, expand: true }) },
];
if (llmAvailable()) {
  configs.push({
    name: `BM25 + synonymes + reformulation LLM (${llmProvider().model})`,
    run: async (q) => fuse([q, ...(await rewrite(q))].map((x) => retriever.search(x, { k: 10 })), 10),
  });
}

const results = [];
for (const cfg of configs) {
  let h1 = 0, h5 = 0, mrr = 0;
  const misses = [];
  for (const { q, expect } of questions) {
    const res = await cfg.run(q);
    const rank = res.findIndex((c) => isHit(c, expect));
    if (rank === 0) h1++;
    if (rank >= 0 && rank < 5) h5++;
    if (rank >= 0) mrr += 1 / (rank + 1);
    else misses.push(q);
  }
  const n = questions.length;
  results.push({ config: cfg.name, n, hit_at_1: h1 / n, recall_at_5: h5 / n, mrr_at_10: mrr / n, misses });
}

const out = { evaluated_at: new Date().toISOString().slice(0, 10), corpus: data.meta, results };
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(out, null, 2));
writeFileSync(new URL("../site/eval.json", import.meta.url), JSON.stringify(out));
const pct = (x) => (x * 100).toFixed(0) + " %";
const md = [
  `# Résultats de l'évaluation de la recherche`,
  ``,
  `${questions.length} questions de nouveaux arrivants, corpus de ${data.meta.n_pages} pages officielles (${data.meta.n_chunks} passages). Évalué le ${out.evaluated_at}.`,
  ``,
  `| Configuration | Bonne page en 1re position | Bonne page dans le top 5 | MRR@10 |`,
  `|---|---|---|---|`,
  ...results.map((r) => `| ${r.config} | ${pct(r.hit_at_1)} | ${pct(r.recall_at_5)} | ${r.mrr_at_10.toFixed(2)} |`),
  ``,
  `## Questions non résolues par la meilleure configuration`,
  ``,
  ...(results.at(-1).misses.length ? results.at(-1).misses.map((q) => `- ${q}`) : ["Aucune."]),
  ``,
].join("\n");
writeFileSync(new URL("./RESULTS.md", import.meta.url), md);
console.log(md);
