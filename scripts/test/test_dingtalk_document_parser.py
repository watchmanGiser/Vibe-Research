"""扫描页识别失败的真实 PDF 回归，避免缺页资料进入自动整理。"""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import fitz

spec = importlib.util.spec_from_file_location('document_parser', Path(__file__).parents[1] / 'parse-dingtalk-document.py')
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


class DocumentParserTests(unittest.TestCase):
    def test_failed_scan_page_returns_partial_with_preview(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pdf = fitz.open()
            first = pdf.new_page()
            first.insert_text((50, 50), 'Visible introduction and assumptions for a research document. ' * 3)
            picture = fitz.Pixmap(fitz.csRGB, (0, 0, 240, 100), False)
            picture.clear_with(120)
            second = pdf.new_page()
            second.insert_image(fitz.Rect(40, 40, 500, 300), stream=picture.tobytes('png'))
            data = pdf.tobytes()
            source = root / (hashlib.sha256(data).hexdigest() + '.pdf')
            source.write_bytes(data)
            with patch.object(fitz.Page, 'get_textpage_ocr', side_effect=RuntimeError('OCR unavailable')):
                result = parser.parse(source, root)
            self.assertEqual(result['unreadablePages'], [2])
            self.assertEqual(result['pageCount'], 2)
            self.assertEqual(len(result['pageImages']), 2)
            self.assertIn('本页文字识别未完成', (root / result['textFile']).read_text())
            self.assertGreater(result['textChars'], 40)


if __name__ == '__main__':
    unittest.main()
