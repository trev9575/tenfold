FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8090 \
    PUID=99 \
    PGID=100

WORKDIR /app
COPY server.py calendar_feed.py ./
COPY static ./static

# The server starts as root only long enough to take ownership of /data,
# then switches to PUID:PGID (Unraid's default nobody:users = 99:100).
VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','8090'))" || exit 1

CMD ["python", "server.py"]
