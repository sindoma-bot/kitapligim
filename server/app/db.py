"""Datenbank von Kitaplığım (SQLite auf der NAS).

Jeder Datensatz (Buch oder Regal) ist ein JSON-Dokument mit Revisionsnummer. Geräte holen mit
`aenderungen(seit)` alles, was sich nach ihrer letzten Revision geändert hat. Gelöschte Datensätze
bleiben als Grabstein (deleted=1) stehen, damit auch andere Geräte das Löschen mitbekommen.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import date
from pathlib import Path

ARTEN = ("books", "shelves")


class Datenbank:
    def __init__(self, pfad: Path, sicherung_dir: Path | None = None, sicherung_tage: int = 60):
        pfad.parent.mkdir(parents=True, exist_ok=True)
        self.pfad = pfad
        self.sicherung_dir = sicherung_dir
        self.sicherung_tage = sicherung_tage
        self._gesichert_am: str | None = None
        self.lock = threading.RLock()
        self.con = sqlite3.connect(str(pfad), check_same_thread=False)
        self.con.row_factory = sqlite3.Row
        with self.lock, self.con:
            self.con.execute("PRAGMA journal_mode=WAL")
            self.con.executescript(
                """
                CREATE TABLE IF NOT EXISTS datensaetze (
                    art TEXT NOT NULL,
                    id TEXT NOT NULL,
                    daten TEXT NOT NULL,
                    geaendert REAL NOT NULL,
                    geloescht INTEGER NOT NULL DEFAULT 0,
                    rev INTEGER NOT NULL,
                    PRIMARY KEY (art, id)
                );
                CREATE INDEX IF NOT EXISTS ix_rev ON datensaetze(rev);
                CREATE TABLE IF NOT EXISTS sitzungen (token TEXT PRIMARY KEY, ablauf REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS yazarlar (schluessel TEXT PRIMARY KEY, daten TEXT NOT NULL, geaendert REAL NOT NULL);
                """
            )

    # ------------------------------------------------------------ Sicherung

    def sichern(self) -> Path | None:
        """Tageskopie der Datenbank, ältere Kopien werden aufgeräumt."""
        if not self.sicherung_dir:
            return None
        heute = date.today().isoformat()
        if self._gesichert_am == heute:
            return None
        with self.lock:
            self.sicherung_dir.mkdir(parents=True, exist_ok=True)
            ziel = self.sicherung_dir / f"kitapligim-{heute}.db"
            if not ziel.exists():
                tmp = ziel.with_suffix(".tmp")
                kopie = sqlite3.connect(str(tmp))
                try:
                    self.con.backup(kopie)
                finally:
                    kopie.close()
                tmp.replace(ziel)
            self._gesichert_am = heute
            alle = sorted(self.sicherung_dir.glob("kitapligim-*.db"))
            for alt in alle[: max(0, len(alle) - self.sicherung_tage)]:
                alt.unlink(missing_ok=True)
            return ziel

    # ------------------------------------------------------------ Datensätze

    def rev(self) -> int:
        with self.lock:
            r = self.con.execute("SELECT COALESCE(MAX(rev), 0) FROM datensaetze").fetchone()[0]
            return int(r)

    def uebernehmen(self, art: str, saetze: list[dict]) -> int:
        """Änderungen eines Geräts speichern. Pro Datensatz gewinnt der neuere Zeitstempel (updatedAt).
        Gibt die Anzahl übernommener Datensätze zurück."""
        if art not in ARTEN:
            raise ValueError(art)
        n = 0
        with self.lock, self.con:
            rev = self.rev()
            for s in saetze:
                sid = str(s.get("id") or "").strip()
                if not sid or len(sid) > 100:
                    continue
                geaendert = float(s.get("updatedAt") or 0)
                geloescht = 1 if s.get("deleted") else 0
                alt = self.con.execute("SELECT geaendert FROM datensaetze WHERE art=? AND id=?", (art, sid)).fetchone()
                if alt is not None and alt["geaendert"] > geaendert:
                    continue  # der Server kennt schon eine neuere Fassung
                daten = {k: v for k, v in s.items() if not k.startswith("_")}
                if geloescht:
                    daten = {"id": sid, "deleted": True, "updatedAt": geaendert}
                rev += 1
                self.con.execute(
                    "INSERT INTO datensaetze(art,id,daten,geaendert,geloescht,rev) VALUES(?,?,?,?,?,?) "
                    "ON CONFLICT(art,id) DO UPDATE SET daten=excluded.daten, geaendert=excluded.geaendert, "
                    "geloescht=excluded.geloescht, rev=excluded.rev",
                    (art, sid, json.dumps(daten, ensure_ascii=False), geaendert, geloescht, rev),
                )
                n += 1
        return n

    def aenderungen(self, seit: int) -> dict:
        with self.lock:
            voll = seit <= 0 or seit > self.rev()  # Gerät neu oder Datenbank zurückgespielt: alles schicken
            rows = self.con.execute(
                "SELECT art, daten, rev FROM datensaetze WHERE rev > ? ORDER BY rev", (0 if voll else seit,)
            ).fetchall()
            aus: dict = {a: [] for a in ARTEN}
            for r in rows:
                aus[r["art"]].append(json.loads(r["daten"]))
            aus["rev"] = rows[-1]["rev"] if rows else (0 if voll else seit)
            aus["voll"] = voll
            return aus

    def foto_ids_in_benutzung(self) -> set[str]:
        with self.lock:
            rows = self.con.execute(
                "SELECT json_extract(daten,'$.photoId') AS p FROM datensaetze WHERE art='books' AND geloescht=0"
            ).fetchall()
            ids = {r["p"] for r in rows if r["p"]}
            for r in self.con.execute("SELECT json_extract(daten,'$.photoId') AS p FROM yazarlar").fetchall():
                if r["p"]:
                    ids.add(r["p"])
            return ids

    # ------------------------------------------------------------ Autoren (Kurzbiografie, nur auf der NAS)

    def yazar(self, schluessel: str) -> dict | None:
        with self.lock:
            r = self.con.execute("SELECT daten FROM yazarlar WHERE schluessel=?", (schluessel,)).fetchone()
            return json.loads(r["daten"]) if r else None

    def yazar_speichern(self, schluessel: str, daten: dict, jetzt: float) -> None:
        with self.lock, self.con:
            self.con.execute(
                "INSERT INTO yazarlar(schluessel, daten, geaendert) VALUES(?,?,?) "
                "ON CONFLICT(schluessel) DO UPDATE SET daten=excluded.daten, geaendert=excluded.geaendert",
                (schluessel, json.dumps(daten, ensure_ascii=False), jetzt),
            )

    def zaehle(self) -> dict:
        with self.lock:
            rows = self.con.execute(
                "SELECT art, COUNT(*) AS n FROM datensaetze WHERE geloescht=0 GROUP BY art"
            ).fetchall()
            return {r["art"]: r["n"] for r in rows}

    # ------------------------------------------------------------ Sitzungen

    def neue_sitzung(self, token: str, ablauf: float) -> None:
        with self.lock, self.con:
            self.con.execute("INSERT INTO sitzungen(token, ablauf) VALUES(?,?)", (token, ablauf))

    def sitzung_gueltig(self, token: str, jetzt: float) -> bool:
        with self.lock:
            r = self.con.execute("SELECT ablauf FROM sitzungen WHERE token=?", (token,)).fetchone()
            return bool(r and r["ablauf"] > jetzt)

    def beende_sitzung(self, token: str) -> None:
        with self.lock, self.con:
            self.con.execute("DELETE FROM sitzungen WHERE token=?", (token,))

    def raeume_sitzungen(self, jetzt: float) -> None:
        with self.lock, self.con:
            self.con.execute("DELETE FROM sitzungen WHERE ablauf <= ?", (jetzt,))
