FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir ".[web]"

ENV FITPDF_DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8000
CMD ["uvicorn", "fitpdf.web.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
