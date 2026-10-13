// Réponse « extractive » : sans modèle génératif, on sélectionne les phrases des
// pages officielles qui répondent le mieux à la question, et on les cite telles quelles.
// Gratuit, instantané, et impossible à « halluciner » : chaque phrase vient d'une source.

import { tokenize, expandQuery } from "./retriever.mjs";

function sentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?:])\s+(?=[A-ZÀ-ÖØ-Ý0-9«"(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 420)
    // on écarte les amorces de menu tronquées (« ... »), les questions de FAQ et les listes de liens
    .filter((s) => !/(\.\.\.|…)/.test(s) && !/\?\s*$/.test(s))
    .filter((s) => (s.match(/[,|]/g) || []).length < 9);
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

export function extractiveAnswer(question, passages, retriever, { maxSentences = 4 } = {}) {
  const terms = new Set(tokenize(expandQuery(question)));
  const cands = [];
  passages.forEach((p, pi) => {
    for (const s of sentences(p.text)) {
      const toks = tokenize(s);
      let score = 0;
      const seen = new Set();
      for (const t of toks) {
        if (terms.has(t) && !seen.has(t)) { score += retriever.idf(t); seen.add(t); }
      }
      if (!score) continue;
      // les premiers passages sont les plus pertinents ; les phrases très longues sont pénalisées
      score *= 1 / (1 + 0.15 * pi);
      score /= Math.sqrt(Math.max(8, toks.length) / 8);
      cands.push({ s, toks, score, source: pi + 1 });
    }
  });
  cands.sort((a, b) => b.score - a.score);
  // on ne garde que les phrases proches de la meilleure : mieux vaut 2 bonnes phrases que 4 moyennes
  const best = cands[0]?.score || 0;
  const strong = cands.filter((c) => c.score >= 0.5 * best);

  // sélection diversifiée (MMR) : on évite deux phrases qui disent la même chose
  const picked = [];
  for (const c of strong) {
    if (picked.length >= maxSentences) break;
    if (picked.some((p) => jaccard(p.toks, c.toks) > 0.5)) continue;
    picked.push(c);
  }
  if (!picked.length) return null;
  // on présente les phrases dans l'ordre des sources pour garder une lecture logique
  picked.sort((a, b) => a.source - b.source || b.score - a.score);
  return "Voici ce que disent les pages officielles sur votre question :\n" +
    picked.map((p) => `- ${p.s} [${p.source}]`).join("\n");
}
