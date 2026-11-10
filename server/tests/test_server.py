import hashlib

import pytest
from fastapi.testclient import TestClient

from app.main import erstelle_app

PW = "kitap123"


@pytest.fixture
def web(tmp_path):
    w = tmp_path / "web"
    w.mkdir()
    (w / "index.html").write_text("<title>Kitaplığım</title>", encoding="utf-8")
    (w / "app.js").write_text("// app", encoding="utf-8")
    return w


@pytest.fixture
def client(tmp_path, web):
    app = erstelle_app(str(tmp_path / "data"), str(web), {"PW_HASH": hashlib.sha256(PW.encode()).hexdigest()})
    return TestClient(app)


def login(c):
    r = c.post("/api/anmelden", json={"passwort": PW})
    assert r.status_code == 200, r.text


def book(id, t, **kw):
    return {"id": id, "title": "Kitap " + id, "updatedAt": t, **kw}


def test_requires_login(client):
    assert client.get("/api/sync").status_code == 401
    assert client.post("/api/sync", json={}).status_code == 401
    assert client.get("/api/gesundheit").json()["app"] == "kitapligim"


def test_wrong_password_and_lockout(client):
    for _ in range(8):
        assert client.post("/api/anmelden", json={"passwort": "yanlis"}).status_code == 401
    assert client.post("/api/anmelden", json={"passwort": PW}).status_code == 429


def test_sync_roundtrip_and_incremental(client):
    login(client)
    r = client.post("/api/sync?seit=0", json={"books": [book("a", 1), book("b", 1)], "shelves": [{"id": "s1", "name": "Roman", "updatedAt": 1}]})
    d = r.json()
    assert {b["id"] for b in d["books"]} == {"a", "b"} and d["shelves"][0]["name"] == "Roman"
    rev = d["rev"]
    # nothing new
    d2 = client.get(f"/api/sync?seit={rev}").json()
    assert d2["books"] == [] and d2["rev"] == rev and not d2["voll"]
    # update one
    client.post(f"/api/sync?seit={rev}", json={"books": [book("a", 2, note="not")]})
    d3 = client.get(f"/api/sync?seit={rev}").json()
    assert [b["id"] for b in d3["books"]] == ["a"] and d3["books"][0]["note"] == "not"


def test_last_writer_wins_and_tombstones(client):
    login(client)
    client.post("/api/sync", json={"books": [book("a", 10, note="yeni")]})
    client.post("/api/sync", json={"books": [book("a", 5, note="eski")]})  # older edit from offline device
    d = client.get("/api/sync").json()
    assert d["books"][0]["note"] == "yeni"
    client.post("/api/sync", json={"books": [{"id": "a", "deleted": True, "updatedAt": 11}]})
    d = client.get("/api/sync").json()
    assert d["books"] == [{"id": "a", "deleted": True, "updatedAt": 11}]
    assert client.get("/api/ich").json()["anzahl"] == {}


def test_private_fields_not_stored(client):
    login(client)
    client.post("/api/sync", json={"books": [book("a", 1, _dirty=True)]})
    assert "_dirty" not in client.get("/api/sync").json()["books"][0]


def test_full_resync_when_device_is_ahead(client):
    login(client)
    client.post("/api/sync", json={"books": [book("a", 1)]})
    d = client.get("/api/sync?seit=999").json()
    assert d["voll"] and [b["id"] for b in d["books"]] == ["a"]


def test_bad_payload(client):
    login(client)
    assert client.post("/api/sync", json={"books": "x"}).status_code == 400
    assert client.post("/api/sync", content=b"nope", headers={"content-type": "application/json"}).status_code == 400


def test_photos(client):
    login(client)
    jpg = b"\xff\xd8\xff\xe0" + b"0" * 100
    assert client.put("/api/fotos/foto-123456", content=jpg).status_code == 201
    r = client.get("/api/fotos/foto-123456")
    assert r.status_code == 200 and r.content == jpg and r.headers["content-type"] == "image/jpeg"
    assert client.put("/api/fotos/foto-123456", content=b"<html>").status_code == 400
    assert client.get("/api/fotos/..%2F..%2Fetc").status_code in (400, 404)
    assert client.get("/api/fotos/nicht-da-123").status_code == 404
    client.post("/api/sync", json={"books": [book("a", 1, photoId="foto-123456")]})
    assert client.delete("/api/fotos/foto-123456").status_code == 409


def test_static_files(client):
    assert "Kitaplığım" in client.get("/").text
    assert client.get("/app.js").text == "// app"
    assert "Kitaplığım" in client.get("/irgendwas").text  # fallback to index
    assert client.get("/api/yok").status_code == 404


def test_logout(client):
    login(client)
    assert client.get("/api/ich").status_code == 200
    client.post("/api/abmelden")
    assert client.get("/api/ich").status_code == 401


def test_backup_created(tmp_path, web):
    erstelle_app(str(tmp_path / "d"), str(web), {"PW_HASH": "x"})
    assert list((tmp_path / "d" / "sicherung").glob("kitapligim-*.db"))


def test_cover_search(tmp_path, web):
    calls = []
    def fake(titel, autor, isbn, key):
        calls.append((titel, autor, isbn))
        if titel == "Efendi":
            return {"bild": b"\xff\xd8\xff" + b"1" * 2000, "quelle": "Kitapyurdu", "fehler": []}
        return {"bild": None, "quelle": None, "fehler": ["Google Books HTTP 429"]}
    c = TestClient(erstelle_app(str(tmp_path / "d"), str(web), {"PW_HASH": hashlib.sha256(PW.encode()).hexdigest()}, kapak_suche=fake))
    assert c.post("/api/kapak", json={"title": "Efendi"}).status_code == 401
    login(c)
    r = c.post("/api/kapak", json={"title": "Efendi", "author": "Soner Yalçın"}).json()
    assert r["quelle"] == "Kitapyurdu" and r["photoId"].startswith("nas-")
    assert c.get("/api/fotos/" + r["photoId"]).headers["content-type"] == "image/jpeg"
    r2 = c.post("/api/kapak", json={"title": "Yok"}).json()
    assert r2["photoId"] is None and r2["fehler"] == ["Google Books HTTP 429"]
    assert c.post("/api/kapak", json={}).status_code == 400


def test_kitapyurdu_parsing(monkeypatch):
    from app import kapak
    page = ('<div class="product-cr"><div class="image"><a href="x"><img src="https://img.kitapyurdu.com/v1/getImage/fn:111/wh:true/wi:220" '
            'alt="Başka Kitap"></a></div></div></div>'
            '<div class="product-cr"><div class="image"><a href="y"><img src="https://img.kitapyurdu.com/v1/getImage/fn:222/wh:true/wi:220" '
            'alt="Efendi 2"></a></div></div></div>')
    monkeypatch.setattr(kapak, "_get", lambda url, **kw: (200, page.encode(), "text/html"))
    monkeypatch.setattr(kapak, "_warte", lambda *a: None)
    url, err = kapak.kitapyurdu("Efendi", "Soner Yalçın")
    assert err is None and url == "https://img.kitapyurdu.com/v1/getImage/fn:222/wh:true/wi:500"


def test_openlibrary_requires_matching_title(monkeypatch):
    import json as _j
    from app import kapak
    docs = {"docs": [{"title": "Tamamen Başka", "cover_i": 1}, {"title": "Kürk Mantolu Madonna", "cover_i": 2}]}
    monkeypatch.setattr(kapak, "_get", lambda url, **kw: (200, _j.dumps(docs).encode(), "application/json"))
    url, _ = kapak.openlibrary("Kürk Mantolu Madonna", "Sabahattin Ali", "")
    assert url.endswith("/b/id/2-L.jpg")
    url, _ = kapak.openlibrary("Yok Böyle Kitap", "", "")
    assert url is None


def test_idefix_parsing(monkeypatch):
    from app import kapak
    page = ('<img src="https://asset.idefix.com/images/app-icons/72x72.png">'
            '<img src="https://image03.idefix.com/resize/216/0/product/30629290/efendi-beyaz-turklerin-buyuk-sirri-soner-yalcin-telefon-tutucu-bir-kar-tanesi-6a9825aa8a405.jpg">'
            '<img src="https://image03.idefix.com/resize/216/0/product/1132833/efendi-2-beyaz-muslumanlarin-buyuk-sirri-654928515f957.jpg">'
            '<img src="https://image03.idefix.com/resize/216/0/product/23360242/beyaz-turklerin-buyuk-sirri-efendi-69d8a6560673d.jpg">')
    urls = []
    monkeypatch.setattr(kapak, "_get", lambda url, **kw: (urls.append(url), (200, page.encode(), "text/html"))[1])
    monkeypatch.setattr(kapak, "_warte", lambda *a: None)
    url, err = kapak.idefix("Efendi", "Soner Yalçın")
    assert "/arama?q=" in urls[0]
    assert err is None and url == "https://image03.idefix.com/resize/500/0/product/23360242/beyaz-turklerin-buyuk-sirri-efendi-69d8a6560673d.jpg"
    assert kapak.idefix("Efendi 2", "Soner Yalçın")[0].endswith("efendi-2-beyaz-muslumanlarin-buyuk-sirri-654928515f957.jpg")
    assert kapak.idefix("Kürk Mantolu Madonna", "Sabahattin Ali") == (None, None)
    monkeypatch.setattr(kapak, "_get", lambda url, **kw: (403, b"", ""))
    assert kapak.idefix("Efendi", "") == (None, "idefix HTTP 403")


def test_author_bio(tmp_path, web):
    calls = []
    def fake(ad):
        calls.append(ad)
        if "Maalouf" in ad:
            return {"titel": "Amin Maalouf", "bio": "1949'da Beyrut'ta doğdu.", "bild_url": "x", "url": "https://tr.wikipedia.org/wiki/Amin_Maalouf"}, None
        return None, None
    c = TestClient(erstelle_app(str(tmp_path / "d"), str(web), {"PW_HASH": hashlib.sha256(PW.encode()).hexdigest()},
                                yazar_suche=fake, yazar_bild=lambda u: b"\xff\xd8\xff" + b"1" * 2000))
    assert c.get("/api/yazar?ad=Amin%20Maalouf").status_code == 401
    login(c)
    r = c.get("/api/yazar?ad=Amin%20Maalouf").json()
    assert r["bio"].startswith("1949") and r["photoId"].startswith("yzr-") and r["quelle"] == "Vikipedi"
    assert c.get("/api/fotos/" + r["photoId"]).status_code == 200
    c.get("/api/yazar?ad=Amin%20Maalouf")
    assert calls == ["Amin Maalouf"]  # zweiter Aufruf aus dem Speicher
    assert c.get("/api/yazar?ad=Yok%20Biri").json()["bio"] is None
    c.get("/api/yazar?ad=Yok%20Biri")
    assert calls.count("Yok Biri") == 1  # nicht gefunden wird auch gemerkt
    r = c.put("/api/yazar", json={"ad": "Yok Biri", "bio": "Kendi yazdığım."}).json()
    assert r["bio"] == "Kendi yazdığım." and r["manuell"]
    assert c.get("/api/yazar?ad=Yok%20Biri&neu=1").json()["bio"] == "Kendi yazdığım."


def test_vikipedi_parsing(monkeypatch):
    import json as _j
    from app import kapak
    assert kapak.yazar_schluessel("Prof.Dr. Pertev Naili Boratav") == "pertev naili boratav"
    def fake(url):
        if "list=search" in url:
            return 200, _j.dumps({"query": {"search": [{"title": "Sait Faik (anlam ayrımı)"}, {"title": "Sait Faik Abasıyanık"}]}}).encode()
        if "Sait_Faik_Abas" in url:
            return 200, _j.dumps({"type": "standard", "title": "Sait Faik Abasıyanık", "extract": "Türk öykü yazarı.",
                                  "thumbnail": {"source": "https://upload.wikimedia.org/a.jpg"},
                                  "content_urls": {"desktop": {"page": "https://tr.wikipedia.org/wiki/Sait_Faik_Abas%C4%B1yan%C4%B1k"}}}).encode()
        return 404, b""
    monkeypatch.setattr(kapak, "_wiki_get", fake)
    info, err = kapak.vikipedi("Sait Faik Abasıyanık")
    assert err is None and info["bio"] == "Türk öykü yazarı." and info["bild_url"].endswith("a.jpg")
    assert kapak.vikipedi("Başka Birisi") == (None, None)
