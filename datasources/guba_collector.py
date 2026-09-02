"""东方财富股吧公开页面采集器。

仅抓取无需登录即可访问的页面，不绕过验证码、签名或访问控制。
原始响应与结构化结果同时落盘，便于复盘页面变化。
"""

from __future__ import annotations

import gzip
import hashlib
import html as html_lib
import json
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable

import requests

PARSER_VERSION = "guba-1.0.0"
SOURCE_NAME = "东方财富股吧公开网页"
BASE_URL = "https://guba.eastmoney.com"
_ALLOWED_MARKETS = {"sh", "sz", "bj"}
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)

_POSITIVE_WORDS = (
    "看好", "利好", "增长", "增持", "突破", "上涨", "反弹", "盈利", "改善", "超预期",
    "回购", "中标", "景气", "创新高", "强势", "低估", "机会", "买入",
)
_NEGATIVE_WORDS = (
    "看空", "利空", "下跌", "亏损", "减持", "破位", "暴跌", "风险", "低迷", "不及预期",
    "处罚", "退市", "爆雷", "套牢", "高估", "出货", "跌停", "卖出",
)


class GubaError(RuntimeError):
    """股吧采集错误。"""


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self.parts.append(text)

    def get_text(self) -> str:
        return " ".join(self.parts)


def _utc8_now() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def _normalize_market(market: str) -> str:
    value = (market or "").strip().lower()
    aliases = {"sse": "sh", "sha": "sh", "shanghai": "sh", "szse": "sz", "shenzhen": "sz", "bse": "bj"}
    value = aliases.get(value, value)
    if value not in _ALLOWED_MARKETS:
        raise ValueError("market 仅支持 sh、sz、bj")
    return value


def _normalize_symbol(symbol: str) -> str:
    value = (symbol or "").strip()
    if not value.isdigit() or len(value) != 6:
        raise ValueError("symbol 必须是 6 位数字")
    return value


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _hash_user(value: Any) -> str:
    raw = str(value or "").strip()
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20] if raw else ""


def _html_to_text(value: Any) -> str:
    raw = str(value or "")
    if not raw:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(raw)
        text = parser.get_text()
    except Exception:  # noqa: BLE001
        text = re.sub(r"<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def _extract_json_assignment(page: str, variable: str) -> dict[str, Any]:
    """从 ``var name={...}`` 中提取 JSON，避免用贪婪正则截断嵌套对象。"""
    match = re.search(rf"(?:var\s+)?{re.escape(variable)}\s*=\s*", page)
    if not match:
        raise GubaError(f"页面缺少 {variable} 数据块，可能已改版")
    start = page.find("{", match.end())
    if start < 0:
        raise GubaError(f"{variable} 数据块格式异常")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(page)):
        char = page[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(page[start:index + 1])
                except json.JSONDecodeError as exc:
                    raise GubaError(f"{variable} JSON 解析失败：{exc}") from exc
    raise GubaError(f"{variable} 数据块未完整闭合")


def _post_from_payload(item: dict[str, Any], market: str, symbol: str) -> dict[str, Any]:
    post_id = str(item.get("post_id") or "").strip()
    if not post_id.isdigit():
        raise GubaError("帖子缺少有效 post_id")
    user = item.get("post_user") if isinstance(item.get("post_user"), dict) else {}
    content_html = str(item.get("post_content") or "")
    return {
        "market": market,
        "symbol": symbol,
        "post_id": post_id,
        "url": f"{BASE_URL}/news,{symbol},{post_id}.html",
        "title": _html_to_text(item.get("post_title")),
        "content_html": content_html,
        "content_text": _html_to_text(content_html),
        "abstract": _html_to_text(item.get("post_abstract")),
        "published_at": str(item.get("post_publish_time") or item.get("post_display_time") or ""),
        "updated_at": str(item.get("post_last_time") or item.get("post_mod_time") or ""),
        "author_id_hash": _hash_user(user.get("user_id") or user.get("user_name")),
        "author_name": str(user.get("user_nickname") or ""),
        "read_count": _safe_int(item.get("post_click_count")),
        "comment_count": _safe_int(item.get("post_comment_count")),
        "like_count": _safe_int(item.get("post_like_count")),
        "forward_count": _safe_int(item.get("post_forward_count")),
        "source": str(item.get("post_from") or SOURCE_NAME),
        "is_hot": 1 if item.get("post_is_hot") else 0,
        "is_top": 1 if _safe_int(item.get("post_top_status")) else 0,
        "replies": _replies_from_payload(item, market, symbol, post_id),
    }


def _replies_from_payload(item: dict[str, Any], market: str, symbol: str, post_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    replies = item.get("reply_list") if isinstance(item.get("reply_list"), list) else []
    for reply in replies:
        if not isinstance(reply, dict):
            continue
        reply_id = str(reply.get("reply_id") or "").strip()
        if not reply_id:
            continue
        user = reply.get("reply_user") if isinstance(reply.get("reply_user"), dict) else {}
        rows.append({
            "market": market,
            "symbol": symbol,
            "post_id": post_id,
            "reply_id": reply_id,
            "author_id_hash": _hash_user(user.get("user_id") or user.get("user_name")),
            "author_name": str(user.get("user_nickname") or ""),
            "content": _html_to_text(reply.get("reply_text")),
            "published_at": str(reply.get("reply_time") or ""),
            "location": str(reply.get("reply_ar") or ""),
            "is_author": 1 if reply.get("reply_is_author") else 0,
        })
    return rows


def parse_list_page(page: str, market: str, symbol: str) -> list[dict[str, Any]]:
    market = _normalize_market(market)
    symbol = _normalize_symbol(symbol)
    payload = _extract_json_assignment(page, "article_list")
    candidates = payload.get("re") or payload.get("data") or []
    if not isinstance(candidates, list):
        raise GubaError("article_list 未返回帖子数组")
    rows: list[dict[str, Any]] = []
    for item in candidates:
        if isinstance(item, dict) and item.get("post_id"):
            try:
                rows.append(_post_from_payload(item, market, symbol))
            except GubaError:
                continue
    if not rows and candidates:
        raise GubaError("帖子数组存在，但没有可识别的帖子")
    return rows


def parse_detail_page(page: str, market: str, symbol: str) -> dict[str, Any]:
    market = _normalize_market(market)
    symbol = _normalize_symbol(symbol)
    return _post_from_payload(_extract_json_assignment(page, "post_article"), market, symbol)


class GubaCollector:
    def __init__(
        self,
        data_dir: str | Path | None = None,
        session: requests.Session | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        default_dir = Path(__file__).resolve().parent / ".cache" / "guba"
        self.data_dir = Path(data_dir or os.environ.get("VR_GUBA_DATA_DIR") or default_dir).resolve()
        self.raw_dir = self.data_dir / "raw"
        self.db_path = self.data_dir / "guba.sqlite3"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": _USER_AGENT, "Referer": f"{BASE_URL}/"})
        self._force_proxy = os.environ.get("VR_DATA_PROXY", "").strip().lower() in {"1", "true", "yes"}
        self._min_interval = max(float(os.environ.get("VR_GUBA_MIN_INTERVAL", "1.2")), 0.2)
        self._timeout = max(float(os.environ.get("VR_GUBA_TIMEOUT", "20")), 3.0)
        self._sleep = sleep_fn
        self._request_lock = threading.Lock()
        self._last_request_at = 0.0
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def _db(self):
        conn = self._connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._db() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS posts (
                    market TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    post_id TEXT NOT NULL,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    content_html TEXT NOT NULL DEFAULT '',
                    content_text TEXT NOT NULL DEFAULT '',
                    abstract TEXT NOT NULL DEFAULT '',
                    published_at TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT '',
                    author_id_hash TEXT NOT NULL DEFAULT '',
                    author_name TEXT NOT NULL DEFAULT '',
                    read_count INTEGER NOT NULL DEFAULT 0,
                    comment_count INTEGER NOT NULL DEFAULT 0,
                    like_count INTEGER NOT NULL DEFAULT 0,
                    forward_count INTEGER NOT NULL DEFAULT 0,
                    source TEXT NOT NULL DEFAULT '',
                    is_hot INTEGER NOT NULL DEFAULT 0,
                    is_top INTEGER NOT NULL DEFAULT 0,
                    detail_fetched_at TEXT,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    raw_hash TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (market, symbol, post_id)
                );
                CREATE INDEX IF NOT EXISTS idx_posts_symbol_time
                    ON posts(market, symbol, published_at DESC);
                CREATE TABLE IF NOT EXISTS replies (
                    market TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    post_id TEXT NOT NULL,
                    reply_id TEXT NOT NULL,
                    author_id_hash TEXT NOT NULL DEFAULT '',
                    author_name TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    published_at TEXT NOT NULL DEFAULT '',
                    location TEXT NOT NULL DEFAULT '',
                    is_author INTEGER NOT NULL DEFAULT 0,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    PRIMARY KEY (market, symbol, post_id, reply_id)
                );
                CREATE TABLE IF NOT EXISTS raw_responses (
                    sha256 TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    status_code INTEGER NOT NULL,
                    content_type TEXT NOT NULL DEFAULT '',
                    parser_version TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    byte_count INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS crawl_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    status TEXT NOT NULL,
                    pages_requested INTEGER NOT NULL DEFAULT 0,
                    pages_fetched INTEGER NOT NULL DEFAULT 0,
                    posts_seen INTEGER NOT NULL DEFAULT 0,
                    posts_inserted INTEGER NOT NULL DEFAULT 0,
                    posts_updated INTEGER NOT NULL DEFAULT 0,
                    details_fetched INTEGER NOT NULL DEFAULT 0,
                    error TEXT NOT NULL DEFAULT ''
                );
            """)

    def _rate_limited_get(self, url: str) -> requests.Response:
        last_error: Exception | None = None
        for attempt in range(3):
            with self._request_lock:
                wait = self._min_interval - (time.monotonic() - self._last_request_at)
                if wait > 0:
                    self._sleep(wait)
                try:
                    response = self.session.get(
                        url,
                        timeout=(5, self._timeout),
                        allow_redirects=True,
                        proxies=None if self._force_proxy else {"http": None, "https": None},
                    )
                    self._last_request_at = time.monotonic()
                except requests.RequestException as exc:
                    self._last_request_at = time.monotonic()
                    last_error = exc
                    response = None
            if response is not None and response.status_code == 200:
                response.encoding = response.apparent_encoding or response.encoding or "utf-8"
                return response
            if response is not None and response.status_code not in {429, 500, 502, 503, 504}:
                raise GubaError(f"HTTP {response.status_code}：{url}")
            if response is not None:
                last_error = GubaError(f"HTTP {response.status_code}：{url}")
            if attempt < 2:
                self._sleep(min(2 ** attempt, 4))
        raise GubaError(f"请求失败：{last_error}")

    def _save_raw(self, url: str, response: requests.Response) -> str:
        body = response.content
        digest = hashlib.sha256(body).hexdigest()
        day_dir = self.raw_dir / datetime.now().strftime("%Y%m%d")
        day_dir.mkdir(parents=True, exist_ok=True)
        path = day_dir / f"{digest}.html.gz"
        if not path.exists():
            with gzip.open(path, "wb") as handle:
                handle.write(body)
        with self._db() as conn:
            conn.execute(
                """INSERT OR IGNORE INTO raw_responses
                   (sha256, url, fetched_at, status_code, content_type, parser_version, file_path, byte_count)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    digest,
                    url,
                    _utc8_now(),
                    response.status_code,
                    response.headers.get("content-type", ""),
                    PARSER_VERSION,
                    str(path),
                    len(body),
                ),
            )
        return digest

    @staticmethod
    def _list_url(symbol: str, page: int) -> str:
        return f"{BASE_URL}/list,{symbol}.html" if page == 1 else f"{BASE_URL}/list,{symbol},f_{page}.html"

    def _existing_post(self, market: str, symbol: str, post_id: str) -> sqlite3.Row | None:
        with self._db() as conn:
            return conn.execute(
                "SELECT * FROM posts WHERE market=? AND symbol=? AND post_id=?",
                (market, symbol, post_id),
            ).fetchone()

    def _upsert_list_post(self, post: dict[str, Any], raw_hash: str, seen_at: str) -> tuple[bool, bool]:
        old = self._existing_post(post["market"], post["symbol"], post["post_id"])
        changed = bool(old and any(
            old[key] != post[key]
            for key in ("title", "read_count", "comment_count", "like_count", "forward_count", "updated_at")
        ))
        with self._db() as conn:
            conn.execute("""
                INSERT INTO posts (
                    market, symbol, post_id, url, title, content_html, content_text, abstract,
                    published_at, updated_at, author_id_hash, author_name, read_count, comment_count,
                    like_count, forward_count, source, is_hot, is_top, first_seen_at, last_seen_at, raw_hash
                ) VALUES (
                    :market, :symbol, :post_id, :url, :title, :content_html, :content_text, :abstract,
                    :published_at, :updated_at, :author_id_hash, :author_name, :read_count, :comment_count,
                    :like_count, :forward_count, :source, :is_hot, :is_top, :seen_at, :seen_at, :raw_hash
                )
                ON CONFLICT(market, symbol, post_id) DO UPDATE SET
                    url=excluded.url, title=excluded.title, abstract=excluded.abstract,
                    published_at=excluded.published_at, updated_at=excluded.updated_at,
                    author_id_hash=excluded.author_id_hash, author_name=excluded.author_name,
                    read_count=excluded.read_count, comment_count=excluded.comment_count,
                    like_count=excluded.like_count, forward_count=excluded.forward_count,
                    source=excluded.source, is_hot=excluded.is_hot, is_top=excluded.is_top,
                    last_seen_at=excluded.last_seen_at, raw_hash=excluded.raw_hash
            """, {**post, "seen_at": seen_at, "raw_hash": raw_hash})
        self._upsert_replies(post.get("replies", []), seen_at)
        return old is None, changed

    def _upsert_replies(self, replies: list[dict[str, Any]], seen_at: str) -> None:
        if not replies:
            return
        with self._db() as conn:
            conn.executemany("""
                INSERT INTO replies (
                    market, symbol, post_id, reply_id, author_id_hash, author_name, content,
                    published_at, location, is_author, first_seen_at, last_seen_at
                ) VALUES (
                    :market, :symbol, :post_id, :reply_id, :author_id_hash, :author_name, :content,
                    :published_at, :location, :is_author, :seen_at, :seen_at
                )
                ON CONFLICT(market, symbol, post_id, reply_id) DO UPDATE SET
                    author_name=excluded.author_name, content=excluded.content,
                    published_at=excluded.published_at, location=excluded.location,
                    is_author=excluded.is_author, last_seen_at=excluded.last_seen_at
            """, [{**row, "seen_at": seen_at} for row in replies])

    def _update_detail(self, post: dict[str, Any], raw_hash: str, fetched_at: str) -> None:
        with self._db() as conn:
            conn.execute("""
                UPDATE posts SET
                    title=?, content_html=?, content_text=?, abstract=?, published_at=?, updated_at=?,
                    author_id_hash=?, author_name=?, read_count=?, comment_count=?, like_count=?,
                    forward_count=?, source=?, is_hot=?, is_top=?, detail_fetched_at=?,
                    last_seen_at=?, raw_hash=?
                WHERE market=? AND symbol=? AND post_id=?
            """, (
                post["title"], post["content_html"], post["content_text"], post["abstract"],
                post["published_at"], post["updated_at"], post["author_id_hash"], post["author_name"],
                post["read_count"], post["comment_count"], post["like_count"], post["forward_count"],
                post["source"], post["is_hot"], post["is_top"], fetched_at, fetched_at, raw_hash,
                post["market"], post["symbol"], post["post_id"],
            ))
        self._upsert_replies(post.get("replies", []), fetched_at)

    def refresh(self, market: str, symbol: str, pages: int = 1, detail_limit: int = 20) -> dict[str, Any]:
        market = _normalize_market(market)
        symbol = _normalize_symbol(symbol)
        pages = max(1, min(int(pages), 5))
        detail_limit = max(0, min(int(detail_limit), 50))
        started_at = _utc8_now()
        with self._db() as conn:
            cursor = conn.execute(
                "INSERT INTO crawl_runs(market, symbol, started_at, status, pages_requested) VALUES (?, ?, ?, 'running', ?)",
                (market, symbol, started_at, pages),
            )
            run_id = cursor.lastrowid

        unique_posts: dict[str, tuple[dict[str, Any], sqlite3.Row | None]] = {}
        stats = {"pages_fetched": 0, "posts_seen": 0, "posts_inserted": 0, "posts_updated": 0, "details_fetched": 0}
        errors: list[str] = []
        try:
            for page_no in range(1, pages + 1):
                url = self._list_url(symbol, page_no)
                try:
                    response = self._rate_limited_get(url)
                    raw_hash = self._save_raw(url, response)
                    posts = parse_list_page(response.text, market, symbol)
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"列表第 {page_no} 页：{exc}")
                    if page_no == 1:
                        raise
                    continue
                stats["pages_fetched"] += 1
                seen_at = _utc8_now()
                for post in posts:
                    if post["post_id"] in unique_posts:
                        continue
                    old = self._existing_post(market, symbol, post["post_id"])
                    inserted, changed = self._upsert_list_post(post, raw_hash, seen_at)
                    stats["posts_inserted"] += int(inserted)
                    stats["posts_updated"] += int(changed)
                    unique_posts[post["post_id"]] = (post, old)

            stats["posts_seen"] = len(unique_posts)
            candidates = []
            for post, old in unique_posts.values():
                if old is None or not old["detail_fetched_at"] or post["comment_count"] > old["comment_count"]:
                    candidates.append(post)
            candidates.sort(key=lambda row: (row["published_at"], int(row["post_id"])), reverse=True)

            for post in candidates[:detail_limit]:
                try:
                    response = self._rate_limited_get(post["url"])
                    raw_hash = self._save_raw(post["url"], response)
                    detail = parse_detail_page(response.text, market, symbol)
                    if detail["post_id"] != post["post_id"]:
                        raise GubaError("详情页 post_id 与列表不一致")
                    self._update_detail(detail, raw_hash, _utc8_now())
                    stats["details_fetched"] += 1
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"详情 {post['post_id']}：{exc}")

            status = "success" if not errors else "partial"
        except Exception as exc:  # noqa: BLE001
            status = "failed"
            if not errors:
                errors.append(str(exc))
        finished_at = _utc8_now()
        with self._db() as conn:
            conn.execute("""
                UPDATE crawl_runs SET finished_at=?, status=?, pages_fetched=?, posts_seen=?,
                    posts_inserted=?, posts_updated=?, details_fetched=?, error=? WHERE id=?
            """, (
                finished_at, status, stats["pages_fetched"], stats["posts_seen"],
                stats["posts_inserted"], stats["posts_updated"], stats["details_fetched"],
                " | ".join(errors)[:2000], run_id,
            ))
        result = {
            "run_id": run_id,
            "status": status,
            "market": market,
            "symbol": symbol,
            "source": SOURCE_NAME,
            "started_at": started_at,
            "finished_at": finished_at,
            **stats,
            "errors": errors,
            "notice": "仅采集公开网页；股吧内容属于情绪弱信号，不构成投资建议。",
        }
        if status == "failed":
            raise GubaError(errors[0] if errors else "股吧刷新失败")
        return result

    def posts(self, market: str, symbol: str, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        market = _normalize_market(market)
        symbol = _normalize_symbol(symbol)
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        with self._db() as conn:
            total = conn.execute(
                "SELECT COUNT(*) FROM posts WHERE market=? AND symbol=?", (market, symbol)
            ).fetchone()[0]
            rows = conn.execute("""
                SELECT market, symbol, post_id, url, title, content_text, abstract, published_at,
                       updated_at, author_id_hash, author_name, read_count, comment_count, like_count,
                       forward_count, source, is_hot, is_top, detail_fetched_at, first_seen_at, last_seen_at
                FROM posts WHERE market=? AND symbol=?
                ORDER BY CASE WHEN published_at='' THEN 1 ELSE 0 END, published_at DESC, post_id DESC
                LIMIT ? OFFSET ?
            """, (market, symbol, limit, offset)).fetchall()
            cutoff = conn.execute(
                "SELECT MAX(last_seen_at) FROM posts WHERE market=? AND symbol=?", (market, symbol)
            ).fetchone()[0]
        data = [dict(row) for row in rows]
        for row in data:
            row["is_hot"] = bool(row["is_hot"])
            row["is_top"] = bool(row["is_top"])
        return {
            "data": data,
            "meta": {
                "market": market,
                "symbol": symbol,
                "total": total,
                "limit": limit,
                "offset": offset,
                "data_cutoff": cutoff,
                "source": SOURCE_NAME,
            },
        }

    def sentiment(self, market: str, symbol: str, days: int = 7) -> dict[str, Any]:
        market = _normalize_market(market)
        symbol = _normalize_symbol(symbol)
        days = max(1, min(int(days), 90))
        since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
        with self._db() as conn:
            rows = conn.execute("""
                SELECT post_id, title, content_text, abstract, published_at, last_seen_at
                FROM posts WHERE market=? AND symbol=? AND (published_at='' OR published_at>=?)
                ORDER BY published_at DESC
            """, (market, symbol, since)).fetchall()
        distribution = {"positive": 0, "neutral": 0, "negative": 0}
        positive_hits = 0
        negative_hits = 0
        latest = ""
        for row in rows:
            text = " ".join((row["title"], row["abstract"], row["content_text"]))
            pos = sum(text.count(word) for word in _POSITIVE_WORDS)
            neg = sum(text.count(word) for word in _NEGATIVE_WORDS)
            positive_hits += pos
            negative_hits += neg
            label = "positive" if pos > neg else "negative" if neg > pos else "neutral"
            distribution[label] += 1
            latest = max(latest, row["last_seen_at"] or "")
        denominator = positive_hits + negative_hits
        score = round((positive_hits - negative_hits) / denominator, 4) if denominator else 0.0
        return {
            "data": {
                "market": market,
                "symbol": symbol,
                "window_days": days,
                "sample_size": len(rows),
                "score": score,
                "distribution": distribution,
                "keyword_hits": {"positive": positive_hits, "negative": negative_hits},
                "method": f"关键词净值法/{PARSER_VERSION}",
                "data_cutoff": latest or None,
                "source": SOURCE_NAME,
                "interpretation": "score 仅描述已采集文本中的关键词倾向，属于弱信号，不能替代公告、行情和基本面核验。",
            }
        }

    def crawl_status(self, market: str | None = None, symbol: str | None = None, limit: int = 20) -> dict[str, Any]:
        clauses: list[str] = []
        params: list[Any] = []
        if market:
            clauses.append("market=?")
            params.append(_normalize_market(market))
        if symbol:
            clauses.append("symbol=?")
            params.append(_normalize_symbol(symbol))
        limit = max(1, min(int(limit), 100))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._db() as conn:
            rows = conn.execute(
                f"SELECT * FROM crawl_runs{where} ORDER BY id DESC LIMIT ?",  # noqa: S608 — 列名固定
                (*params, limit),
            ).fetchall()
        return {
            "data": [dict(row) for row in rows],
            "meta": {"database": str(self.db_path), "raw_directory": str(self.raw_dir), "parser_version": PARSER_VERSION},
        }


_DEFAULT_COLLECTOR: GubaCollector | None = None
_DEFAULT_LOCK = threading.Lock()


def get_collector() -> GubaCollector:
    global _DEFAULT_COLLECTOR
    if _DEFAULT_COLLECTOR is None:
        with _DEFAULT_LOCK:
            if _DEFAULT_COLLECTOR is None:
                _DEFAULT_COLLECTOR = GubaCollector()
    return _DEFAULT_COLLECTOR


def refresh_posts(market: str, symbol: str, pages: int = 1, detail_limit: int = 20) -> dict[str, Any]:
    return get_collector().refresh(market, symbol, pages=pages, detail_limit=detail_limit)


def list_posts(market: str, symbol: str, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    return get_collector().posts(market, symbol, limit=limit, offset=offset)


def sentiment_summary(market: str, symbol: str, days: int = 7) -> dict[str, Any]:
    return get_collector().sentiment(market, symbol, days=days)


def crawl_status(market: str | None = None, symbol: str | None = None, limit: int = 20) -> dict[str, Any]:
    return get_collector().crawl_status(market=market, symbol=symbol, limit=limit)

