#!/usr/bin/env python3
"""提取下载文档正文，并生成保留原排版的逐页预览。"""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

MAX_PAGES = 200
MAX_TEXT = 2_000_000
MAX_PREVIEW_PAGES = 100


def word_text(source):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > 5000 or sum(item.file_size for item in infos) > 100 * 1024 * 1024:
            raise ValueError('WORD_ARCHIVE_LIMIT')
        if any(item.file_size > 30 * 1024 * 1024 for item in infos):
            raise ValueError('WORD_ARCHIVE_LIMIT')
        if 'word/document.xml' not in archive.namelist():
            raise ValueError('WORD_FORMAT_INVALID')
        if any('vbaProject' in item.filename for item in infos):
            raise ValueError('WORD_MACRO_UNSUPPORTED')
    doc = Document(source)
    chunks = []
    for child in doc.element.body:
        if child.tag.endswith('}p'):
            chunks.append(Paragraph(child, doc).text)
        elif child.tag.endswith('}tbl'):
            table = Table(child, doc)
            chunks.extend(' | '.join(cell.text for cell in row.cells) for row in table.rows)
    return '\n'.join(chunks).strip()


def convert_word(source, temporary):
    profile = temporary / 'profile'
    profile.mkdir()
    (profile / 'registrymodifications.xcu').write_text(
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>'
        '<item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinks" oor:op="fuse"><value>0</value></prop></item>'
        '</oor:items>')
    result = subprocess.run([os.environ.get('DINGTALK_LIBREOFFICE_BIN', 'libreoffice'),
        '-env:UserInstallation=' + profile.as_uri(), '--headless', '--nologo', '--nodefault',
        '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', str(temporary), str(source)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=75, check=False)
    converted = temporary / (source.stem + '.pdf')
    if result.returncode or not converted.is_file():
        raise ValueError('WORD_PREVIEW_FAILED')
    return converted


def parse(source, directory):
    import fitz
    match = re.fullmatch(r'([a-f0-9]{64})\.(pdf|docx|doc)', source.name)
    if not match or hashlib.sha256(source.read_bytes()).hexdigest() != match[1]:
        raise ValueError('DOCUMENT_HASH_INVALID')
    fingerprint, kind = match.groups()
    with tempfile.TemporaryDirectory(prefix='jqz-document-') as work:
        temporary = Path(work)
        fallback_word = word_text(source) if kind == 'docx' else ''
        pdf = source
        if kind != 'pdf':
            try:
                pdf = convert_word(source, temporary)
            except (ValueError, FileNotFoundError, subprocess.TimeoutExpired):
                if not fallback_word:
                    raise ValueError('WORD_PREVIEW_FAILED')
                text_name = fingerprint + '.txt'
                (directory / text_name).write_text(fallback_word, encoding='utf-8')
                return dict(textFile=text_name, previewFile=None, pageImages=[], pageCount=None,
                    previewPageCount=0, textChars=len(fallback_word), parser='python-docx', ocrPages=0, unreadablePages=[])
        document = fitz.open(pdf)
        if document.needs_pass or not 0 < len(document) <= MAX_PAGES:
            raise ValueError('PDF_LOCKED_OR_PAGE_LIMIT')
        chunks, ocr_pages, page_images, unreadable_pages = [], 0, [], []
        for index, page in enumerate(document):
            text = page.get_text('text', sort=True).strip()
            if len(text) < 40 and (page.get_images() or page.get_drawings()):
                try:
                    recognized = page.get_text(textpage=page.get_textpage_ocr(language='chi_sim+eng', dpi=150, full=True)).strip()
                    if not recognized:
                        raise ValueError('OCR_EMPTY')
                    text = recognized
                    ocr_pages += 1
                except Exception:
                    unreadable_pages.append(index + 1)
                    text += '\n[本页文字识别未完成，请查看页面预览。]'
            chunks.append(f'\n--- 第 {index + 1} 页 ---\n{text}')
            if index < MAX_PREVIEW_PAGES:
                name = f'{fingerprint}-page-{index + 1:03d}.jpg'
                page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(directory / name, jpg_quality=82)
                page_images.append(name)
        text = '\n'.join(chunks).strip()
        parser = 'pymupdf-ocr' if ocr_pages else 'pymupdf'
        if not ocr_pages and not unreadable_pages and kind == 'pdf':
            try:
                import opendataloader_pdf
                output = temporary / 'structured'
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    opendataloader_pdf.convert(input_path=str(pdf), output_dir=str(output), format='markdown',
                        quiet=True, image_output='off', markdown_page_separator='\n--- 第 %page-number% 页 ---\n')
                structured = output / (pdf.stem + '.md')
                if structured.is_file():
                    candidate = structured.read_text(encoding='utf-8').strip()
                    if len(candidate) >= len(text) * 0.65:
                        text, parser = candidate, 'opendataloader-pdf'
            except Exception:
                pass
        if len(text) > MAX_TEXT or (not unreadable_pages and sum(len(part.split('---\n', 1)[-1].strip()) for part in chunks) < 40):
            raise ValueError('DOCUMENT_TEXT_UNREADABLE_OR_LIMIT')
        text_name = fingerprint + '.txt'
        (directory / text_name).write_text(text, encoding='utf-8')
        preview_name = fingerprint + '-preview.pdf' if kind != 'pdf' else source.name
        if kind != 'pdf':
            (directory / preview_name).write_bytes(pdf.read_bytes())
        return dict(textFile=text_name, previewFile=preview_name, pageImages=page_images,
            pageCount=len(document), previewPageCount=len(page_images), textChars=len(text), parser=parser, ocrPages=ocr_pages, unreadablePages=unreadable_pages)


def main():
    args = argparse.ArgumentParser()
    args.add_argument('source', type=Path)
    args.add_argument('output', type=Path)
    config = args.parse_args()
    try:
        result = parse(config.source.resolve(strict=True), config.output.resolve(strict=True))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z_]+', str(error)) else 'DOCUMENT_PARSE_FAILED'
        print(json.dumps({'error': code}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
