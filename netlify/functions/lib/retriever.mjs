// Recherche lexicale BM25 sur les passages, avec un dictionnaire de synonymes
// propre aux démarches suisses (« permis G » ↔ « frontalier », « LAMal » ↔
// « assurance maladie »...). Même code pour le site et pour l'évaluation.

const STOP = new Set(`a au aux avec ce ces cet cette dans de des du elle en et eux il ils je la le les leur lui ma mais me meme mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous c d j l m n s t y est sont ete etre avoir ai as avons avez ont suis es sommes etes comment quoi quel quelle quels quelles faire fait dois doit doivent peut peux puis-je puis si plus tres tout tous toute toutes alors donc car comme aussi bien chez`.split(/\s+/));

// Groupes d'expressions équivalentes. La requête est enrichie avec tout le groupe.
export const SYNONYMS = [
  ["permis g", "frontalier", "frontaliere", "frontaliers", "autorisation frontaliere"],
  ["permis b", "autorisation de sejour", "permis de sejour", "titre de sejour"],
  ["permis c", "autorisation d etablissement", "etablissement"],
  ["permis l", "autorisation de courte duree", "courte duree"],
  ["lamal", "assurance maladie", "assurance-maladie", "caisse maladie", "assurance obligatoire des soins"],
  ["impot a la source", "imposition a la source", "retenue a la source", "bareme"],
  ["tou", "taxation ordinaire ulterieure", "declaration d impot", "taxation ordinaire"],
  ["avs", "assurance vieillesse", "premier pilier", "1er pilier", "cotisations"],
  ["lpp", "deuxieme pilier", "2e pilier", "prevoyance professionnelle", "caisse de pension"],
  ["3e pilier", "troisieme pilier", "prevoyance individuelle", "pilier 3a"],
  ["chomage", "assurance chomage", "ac", "demandeur d emploi", "orp"],
  ["ocpm", "office cantonal de la population", "controle des habitants", "annoncer son arrivee", "s annoncer"],
  ["permis de conduire", "echange du permis", "permis etranger", "ocv"],
  ["plaques", "immatriculation", "vehicule", "voiture", "importation du vehicule"],
  ["serafe", "redevance radio tv", "redevance"],
  ["subside", "reduction de primes", "subsides"],
  ["bail", "contrat de bail", "location", "loyer", "garantie de loyer", "logement"],
  ["allocations familiales", "allocation familiale", "allocations pour enfant"],
  ["ue", "aele", "union europeenne", "libre circulation", "accord sur la libre circulation"],
];

export function normalize(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, " ");
}

// Racinisation légère du français : suffisant pour rapprocher pluriels et dérivés courants.
function stem(t) {
  if (t.length <= 3) return t;
  for (const suf of ["ements", "ement", "ations", "ation", "iques", "ique", "euses", "euse", "eurs", "eur", "ees", "ee", "es", "s", "x", "e"]) {
    if (t.length - suf.length >= 4 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

export function tokenize(s) {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t) && !(t.length === 1 && isNaN(t)))
    .map(stem);
}

export function expandQuery(q) {
  const n = " " + normalize(q).replace(/[^a-z0-9]+/g, " ") + " ";
  const extra = [];
  for (const group of SYNONYMS) {
    if (group.some((g) => n.includes(" " + g + " "))) extra.push(...group);
  }
  return extra.length ? q + " " + extra.join(" ") : q;
}

export class Retriever {
  constructor(chunks, { k1 = 1.4, b = 0.75, titleWeight = 2 } = {}) {
    this.chunks = chunks;
    this.k1 = k1;
    this.b = b;
    this.docs = chunks.map((c) => {
      const toks = tokenize(c.text);
      // le titre de la page compte plusieurs fois : il résume le sujet du passage
      const title = tokenize(c.title);
      for (let i = 0; i < titleWeight; i++) toks.push(...title);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      return { tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.N = this.docs.length;
  }

  idf(t) {
    const df = this.df.get(t) || 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  search(query, { k = 6, expand = true, maxPerPage = 2 } = {}) {
    const q = expand ? expandQuery(query) : query;
    const terms = [...new Set(tokenize(q))];
    const scores = [];
    this.docs.forEach((d, i) => {
      let s = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        s += this.idf(t) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / this.avgLen));
      }
      if (s > 0) scores.push([s, i]);
    });
    scores.sort((a, b) => b[0] - a[0]);
    // diversité : au plus maxPerPage passages par page, pour citer plusieurs sources
    const perPage = new Map();
    const out = [];
    for (const [s, i] of scores) {
      const c = this.chunks[i];
      const n = perPage.get(c.url) || 0;
      if (n >= maxPerPage) continue;
      perPage.set(c.url, n + 1);
      out.push({ ...c, score: Math.round(s * 100) / 100 });
      if (out.length >= k) break;
    }
    return out;
  }
}
