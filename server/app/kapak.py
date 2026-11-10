"""Cover-Suche auf der NAS.

Quellen in dieser Reihenfolge (Kitapyurdu sperrt automatische Abfragen mit HTTP 403, idefix per robots.txt):
  1. Google Books (mit GOOGLE_BOOKS_KEY zuverlässig; ohne Schlüssel oft "429 Quota").
  2. Open Library (ISBN oder Titel/Autor, nur bei passendem Titel).
Das gefundene Bild wird heruntergeladen und als Foto auf der NAS gespeichert, damit es offline und
dauerhaft verfügbar ist. Abfragen an Kitapyurdu höchstens eine pro Sekunde.
"""

from __future__ import annotations

import html
import json
import re
import threading
import time
import unicodedata
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Kitapligim; private Buchsammlung)"
_lock = threading.Lock()
_letzter = {"kitapyurdu": 0.0, "idefix": 0.0}

KY_IMG = re.compile(r'https://img\.kitapyurdu\.com/v1/getImage/fn:\d+[^"\'\s<>]*')
KY_PRODUKT = re.compile(r'<div[^>]+class="[^"]*product-cr[^"]*"[^>]*>(.*?)</div>\s*</div>\s*</div>', re.S)


def _get(url: str, timeout: float = 12, accept: str = "*/*") -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "tr-TR,tr;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(6 * 1024 * 1024), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, b"", ""


def _warte(quelle: str, abstand: float) -> None:
    with _lock:
        rest = _letzter[quelle] + abstand - time.time()
        if rest > 0:
            time.sleep(rest)
        _letzter[quelle] = time.time()


def _norm(s: str) -> str:
    s = (s or "").replace("İ", "i").replace("I", "ı").lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9ıçğöşü]+", " ", s).strip()


def _gross(url: str) -> str:
    # Kitapyurdu liefert Vorschaubilder mit wi:<Breite>; für das Cover reicht 500 px
    return re.sub(r"/wi:\d+", "/wi:500", url)


def kitapyurdu(titel: str, autor: str) -> tuple[str | None, str | None]:
    """Gibt (Bild-URL, Fehler) zurück."""
    q = " ".join(x for x in (titel, autor) if x).strip()
    if not q:
        return None, None
    _warte("kitapyurdu", 1.0)
    url = "https://www.kitapyurdu.com/index.php?route=product/search&filter_name=" + urllib.parse.quote(q)
    status, body, _ = _get(url, accept="text/html")
    if status != 200:
        return None, f"Kitapyurdu HTTP {status}"
    seite = body.decode("utf-8", "replace")
    # Erst die Ergebnisblöcke prüfen und das Buch nehmen, dessen Name zum Titel passt
    t = _norm(titel)
    for block in KY_PRODUKT.findall(seite):
        bild = KY_IMG.search(block)
        name = re.search(r'(?:alt|title)="([^"]+)"', block)
        if bild and name and t and t.split(" ")[0] in _norm(html.unescape(name.group(1))):
            return _gross(html.unescape(bild.group(0))), None
    bild = KY_IMG.search(seite)
    if bild:
        return _gross(html.unescape(bild.group(0))), None
    return None, None


IDEFIX_IMG = re.compile(r'https://image\d*\.idefix\.com/resize/\d+/0/product/\d+/([a-z0-9-]+?)(?:-[0-9a-f]{8,})?\.(?:jpe?g|png|webp)', re.I)
#: Zubehör mit Buchmotiv (Handyhalter, Tassen ...) steht oft vor dem Buch selbst
IDEFIX_ZUBEHOER = {"telefon", "tutucu", "kupa", "ayrac", "defter", "kalem", "canta", "magnet", "rozet", "poster", "tisort", "bardak", "puzzle", "set"}
_ASCII = str.maketrans("çğıöşüâîûÇĞİÖŞÜ", "cgiosuaiuCGIOSU")


def _slug_tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", (text or "").translate(_ASCII).lower()) if t]


def idefix_waehle(seite: str, titel: str, autor: str) -> str | None:
    """Wählt aus den Produktbildern das, dessen Dateiname am besten zum Titel passt."""
    t = _slug_tokens(titel)
    if not t:
        return None
    a = set(_slug_tokens(autor))
    beste, wert = None, None
    for i, m in enumerate(IDEFIX_IMG.finditer(seite)):
        slug = _slug_tokens(m.group(1))
        if IDEFIX_ZUBEHOER & set(slug):
            continue
        treffer = sum(1 for x in t if x in slug)
        if treffer / len(t) < (1.0 if len(t) <= 2 else 0.6):
            continue
        extra = len([x for x in slug if x not in t and x not in a])
        w = (treffer, -extra, -i)
        if wert is None or w > wert:
            beste, wert = m.group(0), w
    if not beste:
        return None
    return re.sub(r"/resize/\d+/0/", "/resize/500/0/", beste)


def idefix(titel: str, autor: str) -> tuple[str | None, str | None]:
    """Produktbild aus der idefix-Suche (Titel + Autor), passend zum Titel. Höchstens eine Abfrage pro Sekunde."""
    q = " ".join(x for x in (titel, autor.split(",")[0] if autor else "") if x).strip()
    if not q:
        return None, None
    _warte("idefix", 1.0)
    status, body, _ = _get("https://www.idefix.com/arama?q=" + urllib.parse.quote(q), accept="text/html")
    if status != 200:
        return None, f"idefix HTTP {status}"
    seite = html.unescape(body.decode("utf-8", "replace").replace("\\u002F", "/").replace("\\/", "/"))
    return idefix_waehle(seite, titel, autor), None


def google(titel: str, autor: str, isbn: str, key: str) -> tuple[str | None, str | None]:
    if isbn:
        q = f"isbn:{isbn}"
    else:
        q = f"intitle:{titel}" + (f" inauthor:{autor.split(',')[0]}" if autor else "")
    url = "https://www.googleapis.com/books/v1/volumes?maxResults=5&printType=books&q=" + urllib.parse.quote(q)
    if key:
        url += "&key=" + urllib.parse.quote(key)
    status, body, _ = _get(url, accept="application/json")
    if status != 200:
        return None, f"Google Books HTTP {status}"
    t = _norm(titel)
    for item in json.loads(body or b"{}").get("items") or []:
        v = item.get("volumeInfo") or {}
        links = v.get("imageLinks") or {}
        bild = links.get("thumbnail") or links.get("smallThumbnail")
        if not bild:
            continue
        if isbn or not t or t[:12] in _norm(v.get("title", "")) or _norm(v.get("title", ""))[:12] in t:
            return bild.replace("http://", "https://").replace("&edge=curl", "").replace("zoom=1", "zoom=2"), None
    return None, None


def openlibrary(titel: str, autor: str, isbn: str) -> tuple[str | None, str | None]:
    if isbn:
        return f"https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg?default=false", None
    q = {"title": titel, "limit": "5", "fields": "cover_i,title"}
    if autor:
        q["author"] = autor.split(",")[0]
    status, body, _ = _get("https://openlibrary.org/search.json?" + urllib.parse.urlencode(q), accept="application/json")
    if status != 200:
        return None, f"Open Library HTTP {status}"
    t = _norm(titel)
    for d in json.loads(body or b"{}").get("docs") or []:
        n = _norm(d.get("title", ""))
        if d.get("cover_i") and t and (t[:12] in n or n[:12] in t):
            return f"https://covers.openlibrary.org/b/id/{d['cover_i']}-L.jpg", None
    return None, None


def bild_laden(url: str) -> bytes | None:
    status, body, typ = _get(url, accept="image/*")
    if status != 200 or len(body) < 1500:  # Platzhalter-Bilder sind winzig
        return None
    if not (body.startswith(b"\xff\xd8\xff") or body.startswith(b"\x89PNG") or body.startswith(b"RIFF")):
        return None
    return body


def suche(titel: str, autor: str, isbn: str, google_key: str = "") -> dict:
    """Sucht ein Cover. Ergebnis: {bild: bytes|None, quelle, fehler: [..]}"""
    fehler: list[str] = []
    # Kitapyurdu antwortet automatischen Abfragen mit HTTP 403 (gesperrt); deshalb nicht mehr abgefragt.
    # idefix verbietet automatische Suchabfragen (robots.txt sperrt /arama); deshalb nur als Link in der App.
    for name, f in (
        ("Google Books", lambda: google(titel, autor, isbn, google_key)),
        # zweiter Versuch: nur Titel (Autor oft anders geschrieben, z. B. "Prof.Dr." oder zwei Autoren);
        # nicht bei Kontingent-Fehler (429), der würde nur noch einmal kommen
        ("Google Books", lambda: google(titel, "", "", google_key)
            if autor and not isbn and not any("HTTP 429" in e for e in fehler) else (None, None)),
        ("Open Library", lambda: openlibrary(titel, autor, isbn)),
    ):
        try:
            url, err = f()
        except Exception as e:  # Netzwerkfehler, Zeitüberschreitung
            url, err = None, f"{name}: {type(e).__name__}"
        if err:
            fehler.append(err)
        if url:
            try:
                bild = bild_laden(url)
                if not bild and "/resize/500/0/" in url:  # falls idefix diese Größe nicht anbietet
                    bild = bild_laden(url.replace("/resize/500/0/", "/resize/216/0/"))
            except Exception as e:
                bild, _ = None, fehler.append(f"{name} Bild: {type(e).__name__}")
            if bild:
                return {"bild": bild, "quelle": name, "fehler": fehler}
    return {"bild": None, "quelle": None, "fehler": fehler}
