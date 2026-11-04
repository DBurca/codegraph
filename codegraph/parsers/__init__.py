from . import cpp_parser, python_parser, web_parser


def parse_file(lang: str, ext: str, text: str) -> dict:
    if lang == "python":
        return python_parser.parse(text)
    if lang in ("c", "cpp"):
        return cpp_parser.parse(text, ext in (".h", ".hpp", ".hh", ".hxx"))
    if lang in ("js", "ts"):
        return web_parser.parse_js(text, is_ts=(lang == "ts"))
    if lang == "html":
        return web_parser.parse_html(text)
    if lang == "css":
        return web_parser.parse_css(text)
    return {"doc": None, "symbols": [], "imports": [], "entry": False, "error": None}
