FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript pngquant \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
COPY start.sh ./
RUN pip install --no-cache-dir ".[web]" && chmod +x start.sh

# Ghostscript parses attacker-supplied PDFs, and it has a long history of
# sandbox escapes doing exactly that. It does not get to run as root.
# It gets /data (and /usage, the daily counts) and nothing else: the code
# stays root-owned, so a run that escapes Ghostscript still cannot rewrite the
# app it runs in.
RUN useradd --create-home --uid 10001 fitpdf \
    && mkdir -p /data /usage \
    && chown -R fitpdf:fitpdf /data /usage
USER fitpdf

ENV FITPDF_DATA_DIR=/data

EXPOSE 8000
CMD ["uvicorn", "fitpdf.web.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
