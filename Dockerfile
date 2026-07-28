FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
COPY start.sh ./
RUN pip install --no-cache-dir ".[web]" && chmod +x start.sh

# Ghostscript parses attacker-supplied PDFs, and it has a long history of
# sandbox escapes doing exactly that. It does not get to run as root.
RUN useradd --create-home --uid 10001 fitpdf \
    && mkdir -p /data \
    && chown -R fitpdf:fitpdf /data /app
USER fitpdf

ENV FITPDF_DATA_DIR=/data

EXPOSE 8000
CMD ["uvicorn", "fitpdf.web.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
