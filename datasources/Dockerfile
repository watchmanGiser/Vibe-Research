FROM python:3.11-slim

LABEL org.opencontainers.image.source="https://github.com/simonlin1212/Vibe-Research"
LABEL org.opencontainers.image.description="Vibe-Research Backend — AI 投研看板后端"

WORKDIR /app

# 安装系统编译依赖（akshare → lxml/numpy 等需要 build-essential）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码
COPY backend/ .

EXPOSE 8900

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8900/api/health')" || exit 1

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8900"]
