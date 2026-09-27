"""股吧采集器离线测试。"""

import json
import tempfile
import unittest
from pathlib import Path

import guba_collector as guba


def _post(content: str = "看好增长") -> dict:
    return {
        "post_id": 1234567890,
        "post_user": {"user_id": "u1", "user_nickname": "测试用户"},
        "post_guba": {"stockbar_code": "603986"},
        "post_title": "存储景气改善",
        "post_content": content,
        "post_abstract": "测试摘要",
        "post_publish_time": "2026-08-02 20:00:00",
        "post_last_time": "2026-08-02 20:10:00",
        "post_click_count": 100,
        "post_comment_count": 2,
        "post_like_count": 3,
        "post_forward_count": 1,
        "post_from": "股吧网页版",
        "reply_list": [{
            "reply_id": 99,
            "reply_user": {"user_id": "u2", "user_nickname": "回复用户"},
            "reply_text": "利好",
            "reply_time": "2026-08-02 20:05:00",
            "reply_ar": "上海网友",
            "reply_is_author": False,
        }],
    }


def _page(variable: str, payload: dict) -> str:
    return f"<html><script>var {variable}={json.dumps(payload, ensure_ascii=False)};</script></html>"


class _Response:
    def __init__(self, text: str) -> None:
        self.status_code = 200
        self.content = text.encode("utf-8")
        self.headers = {"content-type": "text/html; charset=utf-8"}
        self.apparent_encoding = "utf-8"
        self.encoding = "utf-8"

    @property
    def text(self) -> str:
        return self.content.decode(self.encoding)


class _Session:
    def __init__(self) -> None:
        self.headers = {}

    def get(self, url: str, **_kwargs) -> _Response:
        if "/list," in url:
            return _Response(_page("article_list", {"re": [_post()]}))
        return _Response(_page("post_article", _post("<p>看好增长，业绩改善</p>")))


class GubaCollectorTests(unittest.TestCase):
    def test_parse_nested_json_and_strip_html(self):
        row = guba.parse_detail_page(_page("post_article", _post("<p>看好<b>增长</b></p>")), "sh", "603986")
        self.assertEqual(row["post_id"], "1234567890")
        self.assertEqual(row["content_text"], "看好 增长")
        self.assertEqual(len(row["replies"]), 1)
        self.assertNotEqual(row["author_id_hash"], "u1")

    def test_refresh_incremental_storage_and_sentiment(self):
        with tempfile.TemporaryDirectory() as temp:
            collector = guba.GubaCollector(data_dir=Path(temp), session=_Session(), sleep_fn=lambda _seconds: None)
            first = collector.refresh("sh", "603986", pages=1, detail_limit=1)
            second = collector.refresh("sh", "603986", pages=1, detail_limit=0)
            posts = collector.posts("sh", "603986")
            sentiment = collector.sentiment("sh", "603986", days=7)["data"]

            self.assertEqual(first["status"], "success")
            self.assertEqual(first["posts_inserted"], 1)
            self.assertEqual(first["details_fetched"], 1)
            self.assertEqual(second["posts_inserted"], 0)
            self.assertEqual(posts["meta"]["total"], 1)
            self.assertGreater(sentiment["score"], 0)
            self.assertTrue((Path(temp) / "guba.sqlite3").exists())
            self.assertTrue(any((Path(temp) / "raw").rglob("*.html.gz")))


if __name__ == "__main__":
    unittest.main()
