r"""
Kitaplığım auf der Synology (Python/FastAPI).

Liefert die App aus und hält Bücher, Regale und Cover-Fotos auf der NAS, damit iPhone, iPad und PC
dieselbe Bibliothek sehen. Die App arbeitet weiter offline und gleicht ab, sobald der Server erreichbar ist.

Einstellungen über Umgebungsvariablen (docker-compose.yml, kitapligim.env):
  DATA_DIR        Datenordner (kitapligim.db, fotos/, sicherung/), Standard /data
  WEB_DIR         Ordner mit der Oberfläche (index.html, app.js ...), Standard /app/web
  PW_HASH         SHA-256 des Passworts (Kleinbuchstaben, hex)
  SITZUNG_TAGE    wie lange man auf einem Gerät angemeldet bleibt, Standard 365
  GOOGLE_BOOKS_KEY  optionaler API-Schlüssel für Google Books (Cover-Suche)
  SICHERUNG_TAGE  wie viele Tageskopien der Datenbank in DATA_DIR/sicherung bleiben, Standard 60
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from collections import defaultdict
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from starlette.concurrency import run_in_threadpool

from . import kapak as kp
from .db import ARTEN, Datenbank

COOKIE = "kitapligim_sitzung"
MAX_FOTO = 8 * 1024 * 1024
MAX_SYNC = 20 * 1024 * 1024
FOTO_ID = re.compile(r"^[A-Za-z0-9_-]{6,80}$")
BILDTYPEN = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG": "image/png", b"RIFF": "image/webp"}


def erstelle_app(data_dir: str | None = None, web_dir: str | None = None, env: dict | None = None, kapak_suche=None) -> FastAPI:
    env = dict(os.environ) if env is None else env
    data = Path(data_dir or env.get("DATA_DIR") or "/data")
    web = Path(web_dir or env.get("WEB_DIR") or Path(__file__).resolve().parents[2]).resolve()
    fotos = data / "fotos"
    fotos.mkdir(parents=True, exist_ok=True)
    db = Datenbank(data / "kitapligim.db", data / "sicherung", int(env.get("SICHERUNG_TAGE") or 60))
    aufgeraeumt = {"tag": ""}

    def taeglich() -> None:
        """Einmal am Tag: Datenbank sichern und Fotos entfernen, die seit 7 Tagen kein Buch mehr nutzt."""
        db.sichern()
        heute = time.strftime("%Y-%m-%d")
        if aufgeraeumt["tag"] == heute:
            return
        aufgeraeumt["tag"] = heute
        benutzt = db.foto_ids_in_benutzung()
        grenze = time.time() - 7 * 86400
        for f in fotos.glob("*.img"):
            if f.stem not in benutzt and f.stat().st_mtime < grenze:
                f.unlink(missing_ok=True)

    taeglich()
    pw_hash = (env.get("PW_HASH") or "").strip().lower()
    sitzung_sek = float(env.get("SITZUNG_TAGE") or 365) * 86400
    fehlversuche: dict[str, list[float]] = defaultdict(list)
    kapak_suche = kapak_suche or kp.suche

    app = FastAPI(title="Kitaplığım", docs_url=None, redoc_url=None, openapi_url=None)

    def no_store(inhalt, status: int = 200) -> JSONResponse:
        return JSONResponse(inhalt, status_code=status, headers={"Cache-Control": "no-store"})

    @app.exception_handler(HTTPException)
    async def http_fehler(_req: Request, exc: HTTPException):
        return no_store({"error": exc.detail}, exc.status_code)

    # ---------------------------------------------------------------- Anmeldung

    def angemeldet(request: Request) -> bool:
        token = request.cookies.get(COOKIE)
        if not token or not db.sitzung_gueltig(token, time.time()):
            raise HTTPException(401, "Lütfen giriş yap.")
        return True

    @app.get("/api/gesundheit")
    async def gesundheit():
        return no_store({"ok": True, "app": "kitapligim", "passwort": bool(pw_hash)})

    @app.post("/api/anmelden")
    async def anmelden(request: Request):
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "?")
        jetzt = time.time()
        versuche = fehlversuche[ip] = [t for t in fehlversuche[ip] if t > jetzt - 900]
        if len(versuche) >= 8:
            raise HTTPException(429, "Çok fazla yanlış deneme. 15 dakika sonra tekrar dene.")
        if not pw_hash:
            raise HTTPException(400, "Sunucuda henüz şifre tanımlı değil (kitapligim.env içinde PW_HASH).")
        try:
            body = await request.json()
        except Exception:
            body = {}
        passwort = str((body or {}).get("passwort") or "")
        if not passwort:
            raise HTTPException(400, "Şifreni gir.")
        if not hmac.compare_digest(hashlib.sha256(passwort.encode()).hexdigest(), pw_hash):
            versuche.append(jetzt)
            raise HTTPException(401, "Şifre yanlış.")
        fehlversuche.pop(ip, None)
        token = secrets.token_urlsafe(32)
        db.raeume_sitzungen(jetzt)
        db.neue_sitzung(token, jetzt + sitzung_sek)
        res = no_store({"ok": True})
        sicher = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        res.set_cookie(COOKIE, token, max_age=int(sitzung_sek), httponly=True, samesite="lax", secure=sicher, path="/")
        return res

    @app.post("/api/abmelden")
    async def abmelden(request: Request):
        token = request.cookies.get(COOKIE)
        if token:
            db.beende_sitzung(token)
        res = no_store({"ok": True})
        res.delete_cookie(COOKIE, path="/")
        return res

    @app.get("/api/ich")
    async def ich(_a: bool = Depends(angemeldet)):
        return no_store({"ok": True, "anzahl": db.zaehle()})

    # ---------------------------------------------------------------- Abgleich

    @app.get("/api/sync")
    async def holen(seit: int = 0, _a: bool = Depends(angemeldet)):
        taeglich()
        return no_store(db.aenderungen(seit))

    @app.post("/api/sync")
    async def abgleichen(request: Request, seit: int = 0, _a: bool = Depends(angemeldet)):
        roh = await request.body()
        if len(roh) > MAX_SYNC:
            raise HTTPException(413, "Çok büyük.")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Geçersiz veri.")
        if not isinstance(body, dict):
            raise HTTPException(400, "Geçersiz veri.")
        taeglich()
        for art in ARTEN:
            saetze = body.get(art) or []
            if not isinstance(saetze, list) or not all(isinstance(s, dict) for s in saetze):
                raise HTTPException(400, "Geçersiz veri.")
            db.uebernehmen(art, saetze)
        return no_store(db.aenderungen(seit))

    # ---------------------------------------------------------------- Cover-Fotos

    def foto_pfad(fid: str) -> Path:
        if not FOTO_ID.match(fid):
            raise HTTPException(400, "Geçersiz fotoğraf.")
        return fotos / f"{fid}.img"

    @app.get("/api/fotos/{fid}")
    async def foto(fid: str, _a: bool = Depends(angemeldet)):
        p = foto_pfad(fid)
        if not p.is_file():
            raise HTTPException(404, "Fotoğraf yok.")
        kopf = p.read_bytes()[:4]
        typ = next((t for sig, t in BILDTYPEN.items() if kopf.startswith(sig)), "application/octet-stream")
        # Ein Foto mit derselben ID ändert sich nie (neues Foto = neue ID)
        return FileResponse(p, media_type=typ, headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.put("/api/fotos/{fid}")
    async def foto_speichern(fid: str, request: Request, _a: bool = Depends(angemeldet)):
        p = foto_pfad(fid)
        inhalt = await request.body()
        if not inhalt or len(inhalt) > MAX_FOTO:
            raise HTTPException(413, "Fotoğraf çok büyük.")
        if not any(inhalt.startswith(sig) for sig in BILDTYPEN):
            raise HTTPException(400, "Bu bir fotoğraf değil.")
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(inhalt)
        tmp.replace(p)
        return no_store({"ok": True}, 201)

    @app.delete("/api/fotos/{fid}")
    async def foto_loeschen(fid: str, _a: bool = Depends(angemeldet)):
        p = foto_pfad(fid)
        if fid in db.foto_ids_in_benutzung():
            raise HTTPException(409, "Fotoğraf hâlâ bir kitapta kullanılıyor.")
        p.unlink(missing_ok=True)
        return no_store({"ok": True})

    # ---------------------------------------------------------------- Cover-Suche

    google_key = (env.get("GOOGLE_BOOKS_KEY") or "").strip()

    @app.post("/api/kapak")
    async def kapak_suchen(request: Request, _a: bool = Depends(angemeldet)):
        try:
            body = await request.json()
        except Exception:
            body = {}
        titel = str(body.get("title") or "").strip()[:200]
        autor = str(body.get("author") or "").strip()[:200]
        isbn = re.sub(r"[^0-9Xx]", "", str(body.get("isbn") or ""))[:13]
        if not titel and not isbn:
            raise HTTPException(400, "Kitap adı gerekli.")
        ergebnis = await run_in_threadpool(kapak_suche, titel, autor, isbn, google_key)
        if not ergebnis["bild"]:
            return no_store({"photoId": None, "quelle": None, "fehler": ergebnis["fehler"]})
        fid = "nas-" + secrets.token_hex(12)
        foto_pfad(fid).write_bytes(ergebnis["bild"])
        return no_store({"photoId": fid, "quelle": ergebnis["quelle"], "fehler": ergebnis["fehler"]})

    # ---------------------------------------------------------------- Oberfläche

    @app.get("/{pfad:path}")
    async def oberflaeche(pfad: str):
        if pfad.startswith("api/"):
            raise HTTPException(404, "Bulunamadı.")
        ziel = (web / pfad).resolve()
        if pfad and ziel.is_file() and web in ziel.parents and not any(part.startswith(".") for part in ziel.relative_to(web).parts) \
                and ziel.relative_to(web).parts[0] not in ("server",):
            return FileResponse(ziel, headers={"Cache-Control": "no-cache"})
        index = web / "index.html"
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return Response("Arayüz bulunamadı.", status_code=404, media_type="text/plain; charset=utf-8")

    return app


def __getattr__(name: str):
    # uvicorn app.main:app erzeugt die App erst beim Start
    if name == "app":
        globals()["app"] = erstelle_app()
        return globals()["app"]
    raise AttributeError(name)
