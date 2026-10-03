# Production Dockerfile for the FireLens FastAPI backend
# Google Cloud Run (sets $PORT=8080), Render, Railway, Fly.io, AWS ECS

FROM python:3.11-slim

WORKDIR /app

# Prevent Python from writing .pyc files & enable unbuffered stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Expose port (Render/Railway dynamically inject $PORT)
EXPOSE 8000

# Start Uvicorn ASGI server
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
