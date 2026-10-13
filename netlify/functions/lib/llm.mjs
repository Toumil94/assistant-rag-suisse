// Accès au modèle de langage, quel que soit le fournisseur.
//   GROQ_API_KEY      -> Groq, niveau gratuit, modèle open source (par défaut openai/gpt-oss-120b)
//   ANTHROPIC_API_KEY -> Claude (payant), utilisé seulement si Groq n'est pas configuré
// Sans clé, llmAvailable() renvoie false et l'assistant passe en mode extraits (gratuit, sans IA générative).

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export function llmProvider() {
  if (process.env.GROQ_API_KEY) return { name: "groq", model: process.env.GROQ_MODEL || "openai/gpt-oss-120b" };
  if (process.env.ANTHROPIC_API_KEY) return { name: "anthropic", model: process.env.CLAUDE_MODEL || "claude-haiku-5-5" };
  return null;
}

export const llmAvailable = () => llmProvider() !== null;

export class QuotaError extends Error {}

export async function chat(system, user, maxTokens = 800) {
  const p = llmProvider();
  if (!p) throw new Error("Aucune clé d'IA configurée");

  if (p.name === "groq") {
    const body = {
      model: p.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_completion_tokens: maxTokens,
      temperature: 0.2,
    };
    if (p.model.startsWith("openai/gpt-oss")) {
      body.reasoning_effort = "low";   // modèle de raisonnement : effort minimal pour économiser le quota gratuit
      body.include_reasoning = false;
    }
    let r = await post(GROQ_URL, { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body);
    if (r.status === 400 && "include_reasoning" in body) {
      delete body.include_reasoning; delete body.reasoning_effort;
      r = await post(GROQ_URL, { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body);
    }
    if (r.status === 429) throw new QuotaError("Quota gratuit atteint");
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || "").trim();
  }

  const r = await post("https://api.anthropic.com/v1/messages",
    { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    { model: p.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] });
  if (r.status === 429) throw new QuotaError("Quota atteint");
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.content.map((b) => b.text || "").join("").trim();
}

function post(url, headers, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
