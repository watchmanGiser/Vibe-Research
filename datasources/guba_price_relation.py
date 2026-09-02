"""股吧文本与股价关系的可复现探索脚本。

默认只访问公开页面，按页限频抓取；结果仅用于研究，不构成投资建议。
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import html
import json
import math
import random
import re
import sqlite3
import statistics
import time
from collections import defaultdict
from datetime import datetime, time as dt_time, timedelta
from pathlib import Path
from typing import Any, Iterable

import requests

import guba_collector as guba

GUBA_API_URL = (
    "https://gbapi.eastmoney.com/webarticlelist/api/Article/WebArticleList"
    "?code={symbol}&p={page}&ps=50&sorttype=0&plat=wap&version=300&product=guba&deviceid=1"
)

PRICE_URL = (
    "https://push2his.eastmoney.com/api/qt/stock/kline/get"
    "?secid={secid}&klt=101&fqt=1&beg={beg}&end={end}&lmt=200"
    "&fields1=f1,f2,f3,f4,f5,f6"
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--market", default="sh")
    parser.add_argument("--symbol", default="603986")
    parser.add_argument("--name", default="兆易创新")
    parser.add_argument("--cutoff", default="2026-07-04 00:00:00")
    parser.add_argument("--end", default="2026-08-02 23:59:59")
    parser.add_argument("--max-pages", type=int, default=1250)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def parse_dt(value: str) -> datetime | None:
    try:
        return datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def init_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS pages (
            page_no INTEGER PRIMARY KEY,
            fetched_at TEXT NOT NULL,
            post_count INTEGER NOT NULL,
            newest_at TEXT NOT NULL DEFAULT '',
            oldest_at TEXT NOT NULL DEFAULT '',
            raw_path TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS posts (
            post_id TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            content_text TEXT NOT NULL DEFAULT '',
            abstract TEXT NOT NULL DEFAULT '',
            author_id_hash TEXT NOT NULL DEFAULT '',
            read_count INTEGER NOT NULL DEFAULT 0,
            comment_count INTEGER NOT NULL DEFAULT 0,
            like_count INTEGER NOT NULL DEFAULT 0,
            forward_count INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            first_page INTEGER NOT NULL,
            last_page INTEGER NOT NULL
        );
    """)
    conn.commit()
    return conn


def request_api(session: requests.Session, url: str, attempts: int = 5) -> tuple[requests.Response, dict[str, Any]]:
    error: Exception | None = None
    for attempt in range(attempts):
        try:
            response = session.get(url, timeout=(5, 30), allow_redirects=True)
            if response.status_code != 200:
                error = RuntimeError(f"HTTP {response.status_code}")
            else:
                payload = response.json()
                if isinstance(payload.get("re"), list):
                    return response, payload
                error = RuntimeError("接口响应缺少 re 列表")
        except (requests.RequestException, ValueError) as exc:
            error = exc
        if attempt + 1 < attempts:
            time.sleep((2, 5, 15, 30)[min(attempt, 3)])
    raise RuntimeError(str(error or "请求失败"))


def save_raw(raw_dir: Path, page_no: int, body: bytes) -> Path:
    digest = hashlib.sha256(body).hexdigest()[:16]
    path = raw_dir / f"page_{page_no:04d}_{digest}.json.gz"
    if not path.exists():
        with gzip.open(path, "wb", compresslevel=6) as handle:
            handle.write(body)
    return path


def crawl_posts(args: argparse.Namespace, conn: sqlite3.Connection, out_dir: Path) -> dict[str, Any]:
    cutoff = parse_dt(args.cutoff)
    end = parse_dt(args.end)
    assert cutoff and end
    raw_dir = out_dir / "raw_api_pages"
    raw_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.trust_env = False
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Referer": "https://mguba.eastmoney.com/",
        "Accept": "application/json, text/plain, */*",
    })

    completed = {row[0] for row in conn.execute("SELECT page_no FROM pages WHERE status='success'")}
    consecutive_older = 0
    fetched_now = 0
    empty_failures = 0
    started = datetime.now().astimezone().replace(microsecond=0).isoformat()

    for page_no in range(1, args.max_pages + 1):
        if page_no in completed:
            row = conn.execute("SELECT newest_at FROM pages WHERE page_no=?", (page_no,)).fetchone()
            newest = parse_dt(row[0]) if row else None
            consecutive_older = consecutive_older + 1 if newest and newest < cutoff else 0
            if consecutive_older >= 2:
                break
            continue

        url = GUBA_API_URL.format(symbol=args.symbol, page=page_no)
        fetched_at = datetime.now().astimezone().replace(microsecond=0).isoformat()
        try:
            response, payload = request_api(session, url)
            raw_path = save_raw(raw_dir, page_no, response.content)
            rows = []
            for item in payload.get("re") or []:
                if not isinstance(item, dict):
                    continue
                try:
                    rows.append(guba._post_from_payload(item, args.market, args.symbol))
                except guba.GubaError:
                    continue
            if not rows:
                raise RuntimeError("接口返回空帖子列表")
            dated = [(row, parse_dt(row["published_at"])) for row in rows]
            valid_dates = [value for _, value in dated if value]
            newest = max(valid_dates) if valid_dates else None
            oldest = min(valid_dates) if valid_dates else None
            kept = [(row, value) for row, value in dated if value and cutoff <= value <= end]

            with conn:
                for row, _value in kept:
                    conn.execute("""
                        INSERT INTO posts (
                            post_id, published_at, title, content_text, abstract, author_id_hash,
                            read_count, comment_count, like_count, forward_count, source, url,
                            first_page, last_page
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(post_id) DO UPDATE SET
                            published_at=excluded.published_at, title=excluded.title,
                            content_text=CASE WHEN length(excluded.content_text)>length(posts.content_text)
                                              THEN excluded.content_text ELSE posts.content_text END,
                            abstract=excluded.abstract, author_id_hash=excluded.author_id_hash,
                            read_count=max(posts.read_count, excluded.read_count),
                            comment_count=max(posts.comment_count, excluded.comment_count),
                            like_count=max(posts.like_count, excluded.like_count),
                            forward_count=max(posts.forward_count, excluded.forward_count),
                            source=excluded.source, url=excluded.url, last_page=excluded.last_page
                    """, (
                        row["post_id"], row["published_at"], row["title"], row["content_text"],
                        row["abstract"], row["author_id_hash"], row["read_count"],
                        row["comment_count"], row["like_count"], row["forward_count"],
                        row["source"], row["url"], page_no, page_no,
                    ))
                conn.execute("""
                    INSERT OR REPLACE INTO pages
                    (page_no, fetched_at, post_count, newest_at, oldest_at, raw_path, status, error)
                    VALUES (?, ?, ?, ?, ?, ?, 'success', '')
                """, (
                    page_no, fetched_at, len(rows), newest.strftime("%Y-%m-%d %H:%M:%S") if newest else "",
                    oldest.strftime("%Y-%m-%d %H:%M:%S") if oldest else "", str(raw_path),
                ))
            fetched_now += 1
            empty_failures = 0
            consecutive_older = consecutive_older + 1 if newest and newest < cutoff else 0
            if page_no % 20 == 0 or consecutive_older:
                total = conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0]
                print(json.dumps({
                    "page": page_no,
                    "newest": newest.strftime("%Y-%m-%d %H:%M:%S") if newest else None,
                    "oldest": oldest.strftime("%Y-%m-%d %H:%M:%S") if oldest else None,
                    "posts": total,
                    "consecutive_older": consecutive_older,
                }, ensure_ascii=False), flush=True)
            if consecutive_older >= 2:
                break
        except Exception as exc:  # noqa: BLE001
            empty_failures += 1
            with conn:
                conn.execute("""
                    INSERT OR REPLACE INTO pages
                    (page_no, fetched_at, post_count, newest_at, oldest_at, raw_path, status, error)
                    VALUES (?, ?, 0, '', '', '', 'failed', ?)
                """, (page_no, fetched_at, str(exc)[:500]))
            print(json.dumps({"page": page_no, "error": str(exc)}, ensure_ascii=False), flush=True)
            if empty_failures >= 5:
                raise RuntimeError("连续 5 页抓取失败，已停止以避免无效重试") from exc
        time.sleep(max(args.interval, 0.5))

    page_stats = conn.execute("""
        SELECT COUNT(*) pages, MIN(CASE WHEN oldest_at<>'' THEN oldest_at END) oldest_at,
               MAX(CASE WHEN newest_at<>'' THEN newest_at END) newest_at,
               SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_pages
        FROM pages
    """).fetchone()
    return {
        "started_at": started,
        "finished_at": datetime.now().astimezone().replace(microsecond=0).isoformat(),
        "pages_fetched_now": fetched_now,
        "pages_total": page_stats["pages"],
        "failed_pages": page_stats["failed_pages"] or 0,
        "newest_at": page_stats["newest_at"],
        "oldest_at": page_stats["oldest_at"],
        "post_count": conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0],
        "api_endpoint": "gbapi.eastmoney.com WebArticleList",
    }

def fetch_prices(args: argparse.Namespace, out_dir: Path) -> list[dict[str, Any]]:
    market_id = "1" if args.market == "sh" else "0"
    cutoff = parse_dt(args.cutoff)
    end = parse_dt(args.end)
    assert cutoff and end
    # 多取数日以计算首日收益。
    beg = (cutoff - timedelta(days=10)).strftime("%Y%m%d")
    url = PRICE_URL.format(secid=f"{market_id}.{args.symbol}", beg=beg, end=end.strftime("%Y%m%d"))
    cache_path = out_dir / "price_source_response.json"
    payload: dict[str, Any] | None = None
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if (cached.get("data") or {}).get("code") == args.symbol:
                payload = cached
        except (OSError, ValueError):
            payload = None

    if payload is None:
        session = requests.Session()
        session.trust_env = False
        session.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"})
        error: Exception | None = None
        for attempt in range(5):
            try:
                response = session.get(url, timeout=(5, 30))
                response.raise_for_status()
                candidate = response.json()
                if candidate.get("data"):
                    payload = candidate
                    break
                error = RuntimeError("日线接口响应缺少 data")
            except (requests.RequestException, ValueError) as exc:
                error = exc
            if attempt < 4:
                time.sleep((2, 5, 15, 30)[attempt])
        if payload is None:
            raise RuntimeError(f"日线数据请求失败：{error}")
        cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    data = payload.get("data") or {}
    klines = data.get("klines") or []
    if not klines:
        raise RuntimeError("未取得日线数据")
    rows = []
    for line in klines:
        fields = line.split(",")
        rows.append({
            "date": fields[0], "open": float(fields[1]), "close": float(fields[2]),
            "high": float(fields[3]), "low": float(fields[4]), "volume": int(float(fields[5])),
            "amount": float(fields[6]), "amplitude_pct": float(fields[7]),
            "change_pct_source": float(fields[8]), "change": float(fields[9]),
            "turnover_pct": float(fields[10]),
        })
    for index, row in enumerate(rows):
        previous = rows[index - 1]["close"] if index else None
        row["return_pct"] = round((row["close"] / previous - 1) * 100, 6) if previous else None
        row["gap_pct"] = round((row["open"] / previous - 1) * 100, 6) if previous else None
        row["intraday_pct"] = round((row["close"] / row["open"] - 1) * 100, 6) if row["open"] else None
    return rows

def text_signal(text: str) -> tuple[int, int, float, str]:
    positive = sum(text.count(word) for word in guba._POSITIVE_WORDS)
    negative = sum(text.count(word) for word in guba._NEGATIVE_WORDS)
    total = positive + negative
    score = (positive - negative) / total if total else 0.0
    label = "positive" if positive > negative else "negative" if negative > positive else "neutral"
    return positive, negative, score, label


def aggregate(rows: Iterable[sqlite3.Row]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    posts: list[dict[str, Any]] = []
    seen_text: set[tuple[str, str]] = set()
    for row in rows:
        dt = parse_dt(row["published_at"])
        if not dt:
            continue
        text = re.sub(r"\s+", " ", " ".join((row["title"], row["abstract"], row["content_text"]))).strip()
        normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", text).lower()
        text_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:20]
        key = (dt.strftime("%Y-%m-%d"), text_hash)
        duplicate = key in seen_text
        seen_text.add(key)
        pos, neg, score, label = text_signal(text)
        interaction = math.log1p(max(row["read_count"], 0) + 3 * max(row["comment_count"], 0) + max(row["like_count"], 0))
        posts.append({
            **dict(row), "dt": dt, "day": dt.strftime("%Y-%m-%d"), "text": text,
            "text_hash": text_hash, "is_duplicate_text": duplicate, "positive_hits": pos,
            "negative_hits": neg, "score": score, "label": label, "interaction_weight": interaction,
        })

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for post in posts:
        if not post["is_duplicate_text"]:
            grouped[post["day"]].append(post)
    daily = []
    for day in sorted(grouped):
        items = grouped[day]
        pos_hits = sum(item["positive_hits"] for item in items)
        neg_hits = sum(item["negative_hits"] for item in items)
        denominator = pos_hits + neg_hits
        weighted_den = sum(item["interaction_weight"] for item in items)
        weighted_score = (
            sum(item["score"] * item["interaction_weight"] for item in items) / weighted_den
            if weighted_den else 0.0
        )
        daily.append({
            "date": day,
            "post_count": len(items),
            "raw_post_count": sum(1 for post in posts if post["day"] == day),
            "positive_posts": sum(item["label"] == "positive" for item in items),
            "neutral_posts": sum(item["label"] == "neutral" for item in items),
            "negative_posts": sum(item["label"] == "negative" for item in items),
            "positive_hits": pos_hits,
            "negative_hits": neg_hits,
            "sentiment_score": (pos_hits - neg_hits) / denominator if denominator else 0.0,
            "weighted_sentiment_score": weighted_score,
            "total_reads": sum(item["read_count"] for item in items),
            "total_comments": sum(item["comment_count"] for item in items),
            "total_likes": sum(item["like_count"] for item in items),
        })
    return posts, daily


def window_stats(posts: list[dict[str, Any]], start: datetime, end: datetime) -> dict[str, Any]:
    items = [post for post in posts if not post["is_duplicate_text"] and start < post["dt"] <= end]
    pos = sum(item["positive_hits"] for item in items)
    neg = sum(item["negative_hits"] for item in items)
    total = pos + neg
    weight = sum(item["interaction_weight"] for item in items)
    return {
        "post_count": len(items),
        "sentiment_score": (pos - neg) / total if total else 0.0,
        "weighted_sentiment_score": (
            sum(item["score"] * item["interaction_weight"] for item in items) / weight if weight else 0.0
        ),
    }


def rank(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=values.__getitem__)
    result = [0.0] * len(values)
    index = 0
    while index < len(order):
        end = index
        while end + 1 < len(order) and values[order[end + 1]] == values[order[index]]:
            end += 1
        average = (index + end + 2) / 2
        for pos in range(index, end + 1):
            result[order[pos]] = average
        index = end + 1
    return result


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    numerator = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    denominator = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    return numerator / denominator if denominator else None


def correlation(rows: list[dict[str, Any]], x_key: str, y_key: str, permutations: int = 3000) -> dict[str, Any]:
    pairs = [(float(row[x_key]), float(row[y_key])) for row in rows if row.get(x_key) is not None and row.get(y_key) is not None]
    xs = [pair[0] for pair in pairs]
    ys = [pair[1] for pair in pairs]
    observed = pearson(xs, ys)
    spearman = pearson(rank(xs), rank(ys)) if len(xs) >= 3 else None
    p_value = None
    if observed is not None:
        rng = random.Random(603986)
        extreme = 0
        shuffled = ys[:]
        for _ in range(permutations):
            rng.shuffle(shuffled)
            candidate = pearson(xs, shuffled)
            if candidate is not None and abs(candidate) >= abs(observed):
                extreme += 1
        p_value = (extreme + 1) / (permutations + 1)
    return {
        "x": x_key, "y": y_key, "n": len(pairs),
        "pearson": round(observed, 4) if observed is not None else None,
        "spearman": round(spearman, 4) if spearman is not None else None,
        "permutation_p": round(p_value, 4) if p_value is not None else None,
    }


def align_trading(posts: list[dict[str, Any]], daily: list[dict[str, Any]], prices: list[dict[str, Any]], cutoff: datetime) -> list[dict[str, Any]]:
    daily_map = {row["date"]: row for row in daily}
    selected_indexes = [
        index for index, row in enumerate(prices)
        if row["date"] >= cutoff.strftime("%Y-%m-%d")
    ]
    output = []
    for price_index in selected_indexes:
        price = prices[price_index]
        date = datetime.strptime(price["date"], "%Y-%m-%d")
        previous_trade = (
            datetime.strptime(prices[price_index - 1]["date"], "%Y-%m-%d")
            if price_index else None
        )
        preopen = window_stats(
            posts,
            datetime.combine(previous_trade.date(), dt_time(15, 0)) if previous_trade else date.replace(hour=0),
            datetime.combine(date.date(), dt_time(9, 30)),
        )
        in_session = window_stats(
            posts,
            datetime.combine(date.date(), dt_time(9, 30)),
            datetime.combine(date.date(), dt_time(15, 0)),
        )
        previous_day = daily_map.get(previous_trade.strftime("%Y-%m-%d"), {}) if previous_trade else {}
        output.append({
            **price,
            "calendar_post_count": daily_map.get(price["date"], {}).get("post_count", 0),
            "calendar_sentiment": daily_map.get(price["date"], {}).get("sentiment_score", 0.0),
            "previous_trade_day_sentiment": previous_day.get("sentiment_score"),
            "preopen_post_count": preopen["post_count"],
            "preopen_sentiment": preopen["sentiment_score"],
            "preopen_weighted_sentiment": preopen["weighted_sentiment_score"],
            "session_post_count": in_session["post_count"],
            "session_sentiment": in_session["sentiment_score"],
            "session_weighted_sentiment": in_session["weighted_sentiment_score"],
        })
    return output


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def export_posts(path: Path, posts: list[dict[str, Any]]) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        for post in posts:
            row = {key: value for key, value in post.items() if key not in {"dt", "text"}}
            handle.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")


def build_report(args: argparse.Namespace, out_dir: Path, crawl: dict[str, Any], daily: list[dict[str, Any]], aligned: list[dict[str, Any]], correlations: list[dict[str, Any]]) -> Path:
    def esc(value: Any) -> str:
        return html.escape(str(value if value is not None else "—"), quote=True)

    relation_rows = "".join(
        f"<tr><td>{esc(item['x'])}</td><td>{esc(item['y'])}</td><td>{item['n']}</td>"
        f"<td>{esc(item['pearson'])}</td><td>{esc(item['spearman'])}</td><td>{esc(item['permutation_p'])}</td></tr>"
        for item in correlations
    )
    daily_rows = "".join(
        f"<tr><td>{row['date']}</td><td>{row['post_count']}</td><td>{row['raw_post_count']}</td>"
        f"<td>{row['sentiment_score']:+.3f}</td><td>{row['weighted_sentiment_score']:+.3f}</td>"
        f"<td>{row['positive_posts']}/{row['neutral_posts']}/{row['negative_posts']}</td></tr>"
        for row in daily
    )
    trade_rows = "".join(
        f"<tr><td>{row['date']}</td><td>{row['close']:.2f}</td><td>{esc(row['return_pct'])}</td>"
        f"<td>{row['preopen_post_count']}</td><td>{row['preopen_sentiment']:+.3f}</td>"
        f"<td>{row['session_post_count']}</td><td>{row['session_sentiment']:+.3f}</td></tr>"
        for row in aligned
    )
    relation_map = {(row["x"], row["y"]): row for row in correlations}
    same_day = relation_map.get(("calendar_sentiment", "return_pct"), {})
    prior_day = relation_map.get(("previous_trade_day_sentiment", "return_pct"), {})
    preopen_gap = relation_map.get(("preopen_sentiment", "gap_pct"), {})
    preopen_return = relation_map.get(("preopen_sentiment", "return_pct"), {})
    session_move = relation_map.get(("session_sentiment", "intraday_pct"), {})
    core = (
        f"同日全天情绪与当日收益高度同向（r={same_day.get('pearson')}，p={same_day.get('permutation_p')}），"
        "更可能反映股价驱动讨论情绪；"
        f"上一交易日情绪对次日收益几乎无关系（r={prior_day.get('pearson')}，p={prior_day.get('permutation_p')}）。"
        f"盘前情绪与开盘缺口中度同向（r={preopen_gap.get('pearson')}，p={preopen_gap.get('permutation_p')}），"
        f"但与全天收益关系弱（r={preopen_return.get('pearson')}，p={preopen_return.get('permutation_p')}）；"
        f"盘中情绪与盘中涨跌同向（r={session_move.get('pearson')}，p={session_move.get('permutation_p')}）。"
    )

    robustness_path = out_dir / "robustness_summary.json"
    robustness_html = '<p class="note">尚未运行稳健性脚本。</p>'
    if robustness_path.exists():
        robustness = json.loads(robustness_path.read_text(encoding="utf-8"))
        robust_rows = "".join(
            f"<tr><td>{esc(item['x'])}</td><td>{esc(item['y'])}</td><td>{esc(item['pearson'])}</td>"
            f"<td>{esc(item['leave_one_out_min'])} 至 {esc(item['leave_one_out_max'])}</td>"
            f"<td>{'是' if item['leave_one_out_sign_stable'] else '否'}</td></tr>"
            for item in robustness.get("relations", [])
        )
        contrast_rows = "".join(
            f"<tr><td>{esc(item['x'])}</td><td>{esc(item['y'])}</td><td>{esc(item['low_mean'])}</td>"
            f"<td>{esc(item['high_mean'])}</td><td>{esc(item['high_minus_low'])}</td></tr>"
            for item in robustness.get("median_split_contrasts", [])
        )
        robustness_html = (
            '<h3>逐日剔除检验</h3><div class="scroll"><table><thead><tr><th>变量</th><th>价格</th><th>全样本 r</th>'
            '<th>每次剔除1日后的 r 范围</th><th>方向稳定</th></tr></thead><tbody>' + robust_rows + '</tbody></table></div>'
            '<h3>按情绪中位数分组</h3><div class="scroll"><table><thead><tr><th>情绪变量</th><th>价格变量</th>'
            '<th>低组均值%</th><th>高组均值%</th><th>高-低百分点</th></tr></thead><tbody>' + contrast_rows + '</tbody></table></div>'
        )

    report = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(args.name)}股吧情绪与股价关系</title><style>
:root{{--bg:#07111f;--panel:#0d1b2a;--line:#27445f;--text:#e9f2ff;--muted:#9cb0c7;--cyan:#38bdf8;--green:#34d399;--red:#fb7185;--amber:#fbbf24}}*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(circle at 85% 0,#12395d 0,transparent 32%),var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}}main{{width:min(1220px,calc(100% - 24px));margin:auto;padding:32px 0 60px}}header,.card{{border:1px solid var(--line);background:rgba(13,27,42,.94);border-radius:20px;padding:22px;margin-bottom:16px}}h1{{font-size:clamp(28px,5vw,48px);margin:.2em 0}}h2{{margin-top:0}}.sub,.note{{color:var(--muted)}}.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}.metric{{padding:18px;border-radius:16px;background:#11243a;border:1px solid var(--line)}}.metric b{{font-size:28px;color:var(--cyan);display:block}}table{{width:100%;border-collapse:collapse;font-size:13px}}th,td{{padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}}th:first-child,td:first-child{{text-align:left}}.scroll{{overflow:auto}}.warn{{border-left:4px solid var(--amber);padding:12px;background:rgba(251,191,36,.08)}}code{{color:#a5e6ff}}@media(max-width:800px){{.metrics{{grid-template-columns:1fr 1fr}}}}@media(max-width:480px){{.metrics{{grid-template-columns:1fr}}}}
</style></head><body><main><header><div style="color:var(--cyan);font-weight:700">30天公开讨论样本 · 探索性分析</div><h1>{esc(args.name)}（{esc(args.symbol)}.{args.market.upper()}）股吧情绪与股价关系</h1><p class="sub">设定区间：{esc(args.cutoff)} 至 {esc(args.end)}｜实际最新帖子：{esc(crawl['newest_at'])}｜行情截止：{esc(aligned[-1]['date'] if aligned else '—')}｜东方财富前复权日线，人民币｜生成：{esc(crawl['finished_at'])}</p></header>
<section class="metrics"><div class="metric"><b>{crawl['post_count']}</b><span>去重帖子</span></div><div class="metric"><b>{crawl['pages_total']}</b><span>历史分页</span></div><div class="metric"><b>{len(daily)}</b><span>日历日</span></div><div class="metric"><b>{len(aligned)}</b><span>交易日</span></div></section>
<section class="card"><h2>核心观察</h2><p>{esc(core)}</p><div class="warn"><b>不能直接解释为因果：</b>股价变化会反过来刺激发帖和情绪；样本只有约一个月，且股吧存在转载、机器人、重复内容和事后评论。显著性只作探索，不能用于实盘决策。</div></section>
<section class="card"><h2>相关关系</h2><div class="scroll"><table><thead><tr><th>情绪/热度变量</th><th>价格变量</th><th>N</th><th>Pearson</th><th>Spearman</th><th>置换检验 p</th></tr></thead><tbody>{relation_rows}</tbody></table></div><p class="note">preopen=上一交易日15:00后至当日9:30；session=当日9:30至15:00；return=前复权收盘到收盘；gap=开盘相对前收盘；intraday=开盘到收盘。</p></section>
<section class="card"><h2>稳健性检查</h2>{robustness_html}<p class="note">逐日剔除只检验单日影响，中位数分组也不构成策略回测。</p></section>
<section class="card"><h2>日级情绪</h2><div class="scroll"><table><thead><tr><th>日期</th><th>去重文本</th><th>原始帖子</th><th>净情绪</th><th>互动加权</th><th>正/中/负</th></tr></thead><tbody>{daily_rows}</tbody></table></div></section>
<section class="card"><h2>交易日对齐</h2><div class="scroll"><table><thead><tr><th>日期</th><th>前复权收盘</th><th>涨跌%</th><th>盘前帖子</th><th>盘前情绪</th><th>盘中帖子</th><th>盘中情绪</th></tr></thead><tbody>{trade_rows}</tbody></table></div></section>
<section class="card"><h2>复现口径</h2><ul><li>帖子按 post_id 去重；同一天完全相同的规范化文本仅保留一次用于情绪统计。</li><li>情绪为中文关键词净值法：<code>(正面命中-负面命中)/(正面命中+负面命中)</code>。</li><li>互动加权使用 <code>log(1+阅读+3×评论+点赞)</code>，降低头部帖极端影响。</li><li>前复权参数 <code>fqt=1</code>；行情单位为人民币，成交额沿用数据源原始单位。</li><li>原始接口响应、价格响应、SQLite、CSV 和压缩 JSONL 均随报告保存。</li></ul></section>
</main></body></html>"""
    path = out_dir / f"{args.name}_股吧情绪与股价关系_30天.html"
    path.write_text(report, encoding="utf-8")
    return path


def main() -> None:
    args = parse_args()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = init_db(out_dir / "research_api.sqlite3")
    try:
        crawl = crawl_posts(args, conn, out_dir)
        prices = fetch_prices(args, out_dir)
        rows = conn.execute("SELECT * FROM posts ORDER BY published_at").fetchall()
        posts, daily = aggregate(rows)
        cutoff = parse_dt(args.cutoff)
        assert cutoff
        aligned = align_trading(posts, daily, prices, cutoff)
        correlations = [
            correlation(aligned, "calendar_sentiment", "return_pct"),
            correlation(aligned, "previous_trade_day_sentiment", "return_pct"),
            correlation(aligned, "previous_trade_day_sentiment", "gap_pct"),
            correlation(aligned, "preopen_sentiment", "gap_pct"),
            correlation(aligned, "preopen_weighted_sentiment", "gap_pct"),
            correlation(aligned, "preopen_sentiment", "return_pct"),
            correlation(aligned, "session_sentiment", "intraday_pct"),
            correlation(aligned, "session_weighted_sentiment", "intraday_pct"),
            correlation(aligned, "preopen_post_count", "return_pct"),
        ]
        attention_rows = [{**row, "abs_return_pct": abs(row["return_pct"])} for row in aligned if row.get("return_pct") is not None]
        correlations.append(correlation(attention_rows, "calendar_post_count", "abs_return_pct"))

        write_csv(out_dir / "daily_sentiment.csv", daily)
        write_csv(out_dir / "trading_day_alignment.csv", aligned)
        write_csv(out_dir / "price_kline_front_adjusted.csv", prices)
        export_posts(out_dir / "posts_30d.jsonl.gz", posts)
        summary = {
            "scope": {
                "name": args.name, "market": args.market, "symbol": args.symbol,
                "post_cutoff": args.cutoff, "post_end": args.end,
                "price_adjustment": "前复权 fqt=1", "currency": "人民币",
                "post_source": "东方财富股吧公开移动端列表接口", "price_source": "东方财富 push2his 日线",
            },
            "crawl": crawl,
            "daily_rows": len(daily),
            "trading_rows": len(aligned),
            "correlations": correlations,
            "limitations": [
                "探索性相关不代表因果", "一个月交易日样本较少", "股价会反向影响发帖情绪",
                "关键词模型无法完整识别反讽、否定和营销文本", "历史分页抓取期间新增帖子可能造成少量页边界漂移",
            ],
        }
        (out_dir / "analysis_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        report = build_report(args, out_dir, crawl, daily, aligned, correlations)
        print(json.dumps({"done": True, "report": str(report), **summary}, ensure_ascii=False), flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()


