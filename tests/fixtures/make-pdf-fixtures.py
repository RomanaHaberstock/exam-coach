"""Builds the PDF test fixtures (run: python3 tests/fixtures/make-pdf-fixtures.py tests/fixtures; needs reportlab).
lecture-large.pdf: 160 pages like a real lecture deck: title-only figure slides (vector charts,
no text in the chart), image-only slides, bullet slides and dense text pages.
figure-deck.pdf: 130 slides that are mostly pictures: a short title on most slides, a few
bullet slides, many image-only slides (little text overall, but clearly not scanned). The old
"under 25 characters per page" rule flagged it as scanned.
symbol-office.pdf: Greek letters in the Symbol font with a ToUnicode map to private-use codes
U+F061 etc., the way Microsoft Office writes them."""
import sys, os, random
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import io, zlib, struct

def png(w, h, seed):
    random.seed(seed)
    raw = b"".join(b"\x00" + bytes(random.randrange(256) for _ in range(w * 3)) for _ in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

IMG = ImageReader(io.BytesIO(png(48, 32, 1)))
WORDS = ("trade gravity model tariff elasticity export import welfare equilibrium price index "
         "comparative advantage factor endowment Heckscher Ohlin Ricardo wage labour capital "
         "Öffnung Außenhandel Gütermarkt Präferenzen").split()

def chart(c, W, H):
    c.setLineWidth(2)
    c.line(80, 80, 80, H - 140); c.line(80, 80, W - 80, 80)
    pts = [(80 + i * 40, 80 + (i * 37) % (H - 240)) for i in range((int(W) - 160) // 40)]
    for a, b in zip(pts, pts[1:]): c.line(*a, *b)
    for i in range(6): c.rect(120 + i * 90, 90, 40, 30 + i * 25, fill=1)

def deck(path, n, pattern, seed):
    random.seed(seed)
    W, H = landscape(A4)
    c = canvas.Canvas(path, pagesize=(W, H))
    c.setTitle("Large test deck")
    for i in range(1, n + 1):
        kind = pattern[(i - 1) % len(pattern)]
        if kind == "title":  # figure slide: short title + vector chart
            c.setFont("Helvetica-Bold", 26); c.drawString(60, H - 70, random.choice(WORDS).capitalize())
            chart(c, W, H)
        elif kind == "image":  # only a picture (e.g. a pasted screenshot)
            c.drawImage(IMG, 60, 60, W - 120, H - 120)
        elif kind == "bullets":
            c.setFont("Helvetica-Bold", 26); c.drawString(60, H - 70, f"Slide {i}")
            c.setFont("Helvetica", 18)
            for j in range(4): c.drawString(80, H - 130 - j * 34, "- " + " ".join(random.choice(WORDS) for _ in range(6)))
        elif kind == "dense":  # a page of script text
            c.setFont("Helvetica", 10)
            y = H - 50
            while y > 40:
                c.drawString(50, y, " ".join(random.choice(WORDS) for _ in range(16))); y -= 13
            c.drawString(50, 25, f"MARKERPAGE{i}")
        c.showPage()
    c.save()

out = sys.argv[1] if len(sys.argv) > 1 else "."
deck(os.path.join(out, "lecture-large.pdf"), 160, ["title", "image", "title", "dense", "bullets", "image", "title", "image", "dense", "title"], 7)
deck(os.path.join(out, "figure-deck.pdf"), 130, ["title", "image", "title", "image", "image", "title", "image", "title", "image", "bullets"], 8)


def symbol_office(path):
    cmap = (b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def "
            b"/CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <FF> <F020> endbfrange endcmap "
            b"CMapName currentdict /CMap defineresource pop end end")
    ops = b"BT /F2 12 Tf 20 150 Td (Trade flows: ) Tj /F1 12 Tf (a b s t S D) Tj ET"
    desc = b"<< /Type /FontDescriptor /FontName /Symbol /Flags 4 /FontBBox [0 -220 1113 1005] /ItalicAngle 0 /Ascent 1005 /Descent -220 /CapHeight 1005 /StemV 80 >>"
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> /Contents 4 0 R >>",
            b"<< /Length %d >>\nstream\n" % len(ops) + ops + b"\nendstream",
            b"<< /Type /Font /Subtype /TrueType /BaseFont /Symbol /ToUnicode 6 0 R /FontDescriptor " + desc + b" >>",
            b"<< /Length %d >>\nstream\n" % len(cmap) + cmap + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer << /Root 1 0 R /Size %d >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
    open(path, "wb").write(out)

symbol_office(os.path.join(out, "symbol-office.pdf"))
