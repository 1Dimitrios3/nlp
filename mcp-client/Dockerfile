FROM python:3.12-slim

# Install build tools for any C-extensions (brotli, etc.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      libbrotli-dev \
      python3-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the minimal requirements file & install
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of your client code
COPY . .

# Unbuffered output so logs show up immediately
ENV PYTHONUNBUFFERED=1

# Launch your client
CMD ["python", "-u", "client.py"]
