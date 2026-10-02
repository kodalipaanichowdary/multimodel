# Build context: repo root
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY packages/schemas/python /srv/packages/schemas/python
COPY apps/api/pyproject.toml /srv/apps/api/pyproject.toml
COPY apps/api/app /srv/apps/api/app
RUN pip install /srv/packages/schemas/python /srv/apps/api

COPY agents /srv/agents

RUN useradd --system --uid 10001 pos
USER pos
WORKDIR /srv/apps/api
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
