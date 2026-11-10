# Kitaplığım auf der Synology DS224+

Die App läuft wie die Automaten Kassierung als Container auf der Synology. Bücher, Regale und Cover-Fotos
liegen auf der NAS. iPhone, iPad und PC sehen dieselbe Bibliothek. Die App funktioniert auch ohne Verbindung
und gleicht ab, sobald die NAS wieder erreichbar ist.

```
iPhone / PC  ──HTTPS──▶  Synology (Reverse Proxy, Zertifikat)  ──▶  Container "kitapligim" :8081
                         https://bakkoz.synology.me:8444             ├─ App (index.html, app.js …)
                                                                     ├─ Python-Server (server/app)
                                                                     └─ /data: kitapligim.db, fotos/, sicherung/
```

Container Manager, DDNS-Adresse und Let's-Encrypt-Zertifikat sind von der Kassierung schon da.

## 1. Dateien auf die NAS legen

1. Auf GitHub im Repository **Code → Download ZIP** und entpacken.
2. In der **File Station** den Ordner `docker/kitapligim` anlegen und den entpackten Inhalt hineinkopieren
   (`docker-compose.yml` muss direkt in `docker/kitapligim` liegen).
3. Im selben Ordner den Unterordner `data` anlegen.
4. `kitapligim.env.beispiel` kopieren, die Kopie `kitapligim.env` nennen und ausfüllen:
   - `PW_HASH`: am einfachsten denselben Wert wie `PW_HASH_KENAN` aus
     `docker/automaten-kassierung/kassierung.env` eintragen. Dann gilt dasselbe Passwort wie bei der Kassierung.

`kitapligim.env` enthält die Passwort-Prüfsumme und gehört nie ins GitHub.

## 2. Projekt starten

Container Manager → **Projekt** → **Erstellen**:

- Projektname: `kitapligim`
- Pfad: `docker/kitapligim`
- Quelle: „Vorhandene docker-compose.yml verwenden“
- **Weiter** → **Fertig**.

Test im Büro-Netz: `http://servermunih:8081` im Browser öffnen und mit dem Passwort anmelden.
Ohne HTTPS geht dort alles außer dem Barcode-Scanner (die Kamera braucht HTTPS).

## 3. Von unterwegs erreichbar machen (HTTPS)

1. **Systemsteuerung → Anmeldeportal → Erweitert → Reverse Proxy → Erstellen**:
   - Beschreibung: `Kitaplığım`
   - Quelle: Protokoll **HTTPS**, Hostname `bakkoz.synology.me`, Port **8444**
   - Ziel: Protokoll **HTTP**, Hostname `localhost`, Port **8081**
2. **FritzBox**: Internet → Freigaben → Portfreigaben → NAS → **Neue Freigabe** → Andere Anwendung, TCP,
   Port **8444** an die NAS.
3. **Systemsteuerung → Sicherheit → Zertifikat → Einstellungen**: dem neuen Eintrag `bakkoz.synology.me:8444`
   das Let's-Encrypt-Zertifikat zuordnen (dasselbe wie für die Kassierung).

Danach: auf dem iPhone in Safari `https://bakkoz.synology.me:8444` öffnen, anmelden, dann
**Teilen → Zum Home-Bildschirm**. Jedes Gerät bleibt ein Jahr angemeldet.

Nach 8 falschen Passwörtern sperrt der Server die Anmeldung für 15 Minuten.

## 4. Datensicherung

Alles liegt in `docker/kitapligim/data`:

- `kitapligim.db`: Bücher und Regale
- `fotos/`: Cover-Fotos
- `sicherung/`: tägliche Kopie der Datenbank (60 Tage)

In **Hyper Backup** die bestehende Sicherungsaufgabe um den Ordner `docker/kitapligim/data` erweitern.

## 5. Updates (automatisch)

Nach jeder Änderung baut GitHub das Paket `ghcr.io/sindoma-bot/kitapligim` (Workflow „NAS-Image“).
Der Container `automaten-kassierung-updater` (Watchtower) aktualisiert alle Container mit dem Label
`com.centurylinklabs.watchtower.enable`, also auch diesen. Ein zweiter Updater ist nicht nötig.

Falls das Paket beim ersten Start noch nicht auf GitHub liegt, baut die NAS es einmal selbst aus dem Ordner.

## Für Entwickler

- Server: `server/app` (FastAPI, SQLite). Tests: `pip install -r server/requirements-dev.txt`, dann im Ordner
  `server` `python -m pytest`.
- Lokal starten: `cd server && DATA_DIR=./data WEB_DIR=.. PW_HASH=<sha256> uvicorn app.main:app --port 8081`.
- Schnittstelle: `/api/anmelden`, `/api/abmelden`, `/api/ich`, `/api/sync?seit=<rev>` (GET holt Änderungen,
  POST schickt geänderte Bücher/Regale und holt Änderungen), `/api/fotos/<id>` (GET/PUT).
- Abgleich: jeder Datensatz trägt `updatedAt`; der neuere gewinnt. Gelöschte Datensätze bleiben als
  `{id, deleted: true}` stehen, damit andere Geräte sie ebenfalls entfernen.
- Die Oberfläche (Wurzelordner) läuft auch ohne Server, z. B. auf GitHub Pages; dann bleiben die Daten nur im Gerät.
