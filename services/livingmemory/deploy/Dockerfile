# LivingMemory sidecar — container build (AGPL-3.0 components, see NOTICE.md)
FROM python:3.12-slim

ENV PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY requirements.lock.txt /app/requirements.lock.txt
RUN pip install --no-cache-dir -r /app/requirements.lock.txt

COPY vendor /app/vendor
COPY sidecar /app/sidecar
COPY config /app/config

# Non-root; sidecar data volume mounted at /srv/livingmemory/data.
# IMPORTANT (LINUX_CHECKS): the runtime WORKDIR must be writable by the
# service user because importing astrbot.core incidentally creates a
# relative "data/" directory under CWD. Keep /app root-owned read-only and
# run from a dedicated writable dir; the module is found via PYTHONPATH.
RUN useradd -m -u 10001 lm \
    && mkdir -p /srv/livingmemory/data /srv/livingmemory/run \
    && chown -R lm:lm /srv/livingmemory
WORKDIR /srv/livingmemory/run
USER lm
ENV PYTHONPATH=/app \
    LM_DATA_DIR=/srv/livingmemory/data \
    LM_CONFIG_FILE=/app/config/service.json \
    LM_BIND=127.0.0.1 \
    LM_PORT=8765
EXPOSE 8765
CMD ["python", "-X", "utf8", "-m", "sidecar"]
