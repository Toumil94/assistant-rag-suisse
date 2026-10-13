"""Collecte les pages officielles listées dans ingest/sources.yaml.

Parcours en largeur depuis des pages de départ, limité à chaque site, à une
profondeur maximale et à un nombre de pages. Respecte robots.txt et attend
entre deux requêtes. Le texte utile de chaque page est extrait avec
trafilatura, puis enregistré dans corpus/pages.jsonl.
"""
from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
import urllib.robotparser
from collections import deque
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse

import requests
import trafilatura
import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "corpus" / "pages.jsonl"
SKIP_EXT = re.compile(r"\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|mp4|mp3|ics|xml)$", re.I)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href, " ".join(self._text).strip()))
            self._href = None


def relevant(url: str, anchor: str, keywords: list[str]) -> bool:
    tokens = re.split(r"[^a-z0-9]+", norm(url + " " + anchor))
    return any(t.startswith(k) for t in tokens if t for k in keywords)


def sitemap_urls(url: str, session: requests.Session, depth: int = 0) -> list[str]:
    """Lit un sitemap XML (ou un index de sitemaps) et renvoie les adresses des pages."""
    try:
        r = session.get(url, timeout=60)
    except requests.RequestException:
        return []
    if r.status_code != 200:
        print(f"  sitemap {url} -> HTTP {r.status_code}")
        return []
    print(f"  sitemap {url} -> {len(r.text)} octets, type {r.headers.get('content-type', '')[:30]}")
    locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", r.text)
    if not locs and "html" in r.headers.get("content-type", ""):
        # Plan du site au format HTML : on récupère ses liens.
        parser = Links()
        parser.feed(r.text)
        locs = [urljoin(r.url, h) for h, _ in parser.links if h]
    if "<sitemapindex" in r.text and depth < 2:
        out = []
        for sm in locs:
            out.extend(sitemap_urls(sm, session, depth + 1))
        return out
    return locs


def excluded(url: str, cfg: dict) -> bool:
    u = url.lower()
    return any(p in u for p in cfg.get("exclude_patterns", []))


def crawl_site(site: dict, cfg: dict, session: requests.Session) -> list[dict]:
    domain = site["domain"]
    robots = urllib.robotparser.RobotFileParser()
    robots.set_url(f"https://{domain}/robots.txt")
    try:
        robots.read()
    except Exception:  # noqa: BLE001  pas de robots.txt lisible : on reste prudent mais on continue
        robots = None

    seeds = list(site.get("seeds", []))
    if site.get("sitemap"):
        found = [u.split("?")[0] for u in sitemap_urls(site["sitemap"], session)]
        found = [u for u in found if urlparse(u).netloc == domain and not excluded(u, cfg)
                 and any(urlparse(u).path.startswith(p) for p in site["allow_prefixes"])
                 and (not site.get("keyword_filter") or relevant(u, "", cfg["keywords"]))]
        print(f"  sitemap : {len(found)} pages candidates (exemples : {found[:2]})")
        seeds += found
    queue = deque((u, 0) for u in dict.fromkeys(seeds))
    seen = set(seeds)
    status_log: dict = {}
    pages = []
    errors = 0
    while queue and len(pages) < site["max_pages"]:
        url, depth = queue.popleft()
        if robots and not robots.can_fetch(cfg["user_agent"], url):
            status_log["robots.txt"] = status_log.get("robots.txt", 0) + 1
            continue
        try:
            r = session.get(url, timeout=30)
            time.sleep(cfg["delay_seconds"])
        except requests.RequestException:
            errors += 1
            continue
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            key = f"{r.status_code} {r.headers.get('content-type', '')[:20]}"
            status_log[key] = status_log.get(key, 0) + 1
            continue
        html = r.text
        text = trafilatura.extract(html, include_tables=True, include_comments=False, favor_precision=True)
        meta = trafilatura.extract_metadata(html)
        title = (meta.title if meta and meta.title else url).split(" | ")[0].split(" - ch.ch")[0].strip()
        if not text or len(text) <= 300:
            status_log["texte trop court"] = status_log.get("texte trop court", 0) + 1
        if text and len(text) > 300 and not excluded(r.url, cfg):
            pages.append({
                "url": r.url, "domain": domain, "site": site["name"], "title": title, "text": text,
                "fetched_at": datetime.now(timezone.utc).date().isoformat(),
            })
        if depth >= cfg["max_depth"]:
            continue
        parser = Links()
        try:
            parser.feed(html)
        except Exception:  # noqa: BLE001
            continue
        for href, anchor in parser.links:
            if not href or href.startswith(("mailto:", "tel:", "javascript:")):
                continue
            link = urldefrag(urljoin(r.url, href))[0].split("?")[0]
            p = urlparse(link)
            if p.netloc != domain or SKIP_EXT.search(p.path) or link in seen or excluded(link, cfg):
                continue
            if not any(p.path.startswith(pre) for pre in site["allow_prefixes"]):
                continue
            if site.get("keyword_filter") and not relevant(link, anchor, cfg["keywords"]):
                continue
            seen.add(link)
            queue.append((link, depth + 1))
    rejected = ", ".join(f"{k} x{v}" for k, v in status_log.items()) or "aucune"
    print(f"{site['name']}: {len(pages)} pages gardées, {len(seen)} liens vus, {errors} erreurs réseau, réponses rejetées : {rejected}")
    return pages


def main() -> None:
    cfg = yaml.safe_load((ROOT / "ingest" / "sources.yaml").read_text(encoding="utf-8"))
    session = requests.Session()
    session.headers["User-Agent"] = cfg["user_agent"]
    session.headers["Accept-Language"] = "fr-CH,fr;q=0.9"
    all_pages = []
    for site in cfg["sites"]:
        all_pages.extend(crawl_site(site, cfg, session))
    # dédoublonnage sur l'URL finale (après redirections)
    uniq = {p["url"]: p for p in all_pages}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for p in uniq.values():
            f.write(json.dumps(p, ensure_ascii=False) + "\n")
    print(f"Total : {len(uniq)} pages -> {OUT.relative_to(ROOT)}")
    if len(uniq) < 50:
        sys.exit("Moins de 50 pages collectées : vérifier les sources avant de publier.")


if __name__ == "__main__":
    main()
