# Kitaplığım für die Synology (Container Manager).
# Python-Server (FastAPI) liefert die App aus und speichert Bücher, Regale und Cover-Fotos in /data.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data WEB_DIR=/app/web TZ=Europe/Berlin
WORKDIR /app/server
COPY server/requirements.txt ./
RUN pip install --no-cache-dir --retries 10 --timeout 60 -r requirements.txt
COPY server/app ./app
COPY index.html app.css app.js store.js lookup.js sw.js manifest.webmanifest /app/web/
COPY icons /app/web/icons
COPY vendor /app/web/vendor
VOLUME /data
EXPOSE 8081
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/api/gesundheit')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081", "--proxy-headers", "--forwarded-allow-ips", "*"]
