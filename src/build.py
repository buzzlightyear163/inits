# python3 build.py <dir>  -> inlines site.css, termkit.js and engine.js into <dir>/index.html (from index.src.html)
import sys, pathlib
d = pathlib.Path(sys.argv[1]); s = (d / "index.src.html").read_text()
s = s.replace('<link rel="stylesheet" href="site.css">', "<style>\n" + (d / "site.css").read_text() + "</style>")
s = s.replace('<script src="termkit.js"></script>', "<script>\n" + (d / "termkit.js").read_text() + "</script>")
s = s.replace('<script src="engine.js"></script>', "<script>\n" + (d / "engine.js").read_text() + "</script>")
(d / "index.html").write_text(s); print("index.html", len(s), "bytes")
