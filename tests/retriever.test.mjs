import test from "node:test";
import assert from "node:assert/strict";
import { Retriever, tokenize, expandQuery } from "../netlify/functions/lib/retriever.mjs";

const chunks = [
  { id: "1", url: "https://www.ge.ch/impot-source", title: "Impôt à la source", site: "ge.ch", text: "Les personnes étrangères sans permis C sont imposées à la source sur leur salaire." },
  { id: "2", url: "https://www.ge.ch/demander-permis-travail-frontalier", title: "Demander un permis de travail frontalier", site: "ge.ch", text: "Le permis G est délivré aux travailleurs frontaliers qui résident dans la zone frontalière." },
  { id: "3", url: "https://www.ch.ch/fr/sante/assurance-maladie/", title: "Assurance maladie obligatoire", site: "ch.ch", text: "Toute personne domiciliée en Suisse doit s'assurer dans les trois mois." },
];
const r = new Retriever(chunks);

test("les accents et la casse sont ignorés", () => {
  assert.deepEqual(tokenize("Impôt À LA Source"), tokenize("impot a la source"));
});

test("les synonymes métier enrichissent la requête", () => {
  assert.match(expandQuery("Je suis frontalier"), /permis g/);
  assert.match(expandQuery("c'est quoi la LAMal ?"), /assurance maladie/);
});

test("la bonne page arrive en tête", () => {
  assert.equal(r.search("comment payer mes impôts sur mon salaire")[0].id, "1");
  assert.equal(r.search("je travaille en Suisse mais j'habite en France, quel permis ?")[0].id, "2");
  assert.equal(r.search("LAMal délai après mon arrivée")[0].id, "3");
});

test("aucun résultat pour une requête sans rapport", () => {
  assert.equal(r.search("recette de la fondue").length, 0);
});
