"""Découpe les pages collectées en passages pour la recherche.

Un passage regroupe des paragraphes consécutifs jusqu'à ~900 caractères, avec
un paragraphe de recouvrement pour ne pas couper une idée en deux. Le titre de
la page est conservé avec chaque passage : il aide la recherche et la citation.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / "corpus" / "pages.jsonl"
OUT = ROOT / "netlify" / "functions" / "data" / "chunks.json"
TARGET = 900
MAX = 1400

BOILERPLATE = re.compile(
    r"^(partager|imprimer|haut de page|retour|contact|cookies?|dernière mise à jour|"
    r"cette page vous a-t-elle été utile|avez-vous trouvé|plus d'informations)\b",
    re.I,
)


def paragraphs(text: str) -> list[str]:
    out = []
    for p in re.split(r"\n+", text):
        p = re.sub(r"\s+", " ", p).strip()
        if len(p) < 25 or BOILERPLATE.match(p):
            continue
        # un paragraphe trop long est coupé sur les phrases
        while len(p) > MAX:
            cut = p.rfind(". ", 0, MAX)
            cut = cut + 1 if cut > TARGET // 2 else MAX
            out.append(p[:cut].strip())
            p = p[cut:].strip()
        out.append(p)
    return out


def chunk_page(page: dict) -> list[dict]:
    paras = paragraphs(page["text"])
    chunks, cur = [], []
    for p in paras:
        if cur and sum(len(x) for x in cur) + len(p) > TARGET:
            chunks.append(cur)
            cur = cur[-1:] if len(cur[-1]) < TARGET // 2 else []
        cur.append(p)
    if cur:
        chunks.append(cur)
    result = []
    for i, c in enumerate(chunks):
        text = "\n".join(c)
        cid = hashlib.sha1(f"{page['url']}#{i}".encode()).hexdigest()[:10]
        result.append({
            "id": cid, "url": page["url"], "title": page["title"], "site": page["site"],
            "domain": page["domain"], "text": text,
        })
    return result


def main() -> None:
    pages = [json.loads(line) for line in PAGES.read_text(encoding="utf-8").splitlines() if line.strip()]
    chunks, seen_text = [], set()
    for page in pages:
        for c in chunk_page(page):
            key = re.sub(r"\W+", "", c["text"].lower())[:400]
            if key in seen_text:   # les menus et encadrés répétés d'une page à l'autre
                continue
            seen_text.add(key)
            chunks.append(c)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "n_pages": len(pages), "n_chunks": len(chunks),
        "sites": sorted({p["site"] for p in pages}),
        "fetched_at": max((p["fetched_at"] for p in pages), default=None),
    }
    OUT.write_text(json.dumps({"meta": meta, "chunks": chunks}, ensure_ascii=False), encoding="utf-8")
    print(f"{len(pages)} pages -> {len(chunks)} passages ({OUT.stat().st_size / 1e6:.1f} Mo)")


if __name__ == "__main__":
    main()
