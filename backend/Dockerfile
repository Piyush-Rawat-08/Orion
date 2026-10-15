FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
EXPOSE 8100
# load Corvane on first start if the graph is empty, then serve
CMD ["sh", "-c", "python -c 'from orion import db, load; d=db.get_db(); d.exists(\"org:corvane\") or load.reset(d)' && uvicorn orion.api:app --host 0.0.0.0 --port 8100"]
