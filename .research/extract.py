import json, re, html, sys, os, urllib.request

urls = {
    "easy-prompt": "https://gc.ai/features/easy-prompt",
    "product-update": "https://gc.ai/blog/product-update-easy-prompt",
    "how-to-prompt": "https://gc.ai/learn/how-to-prompt-legal-ai",
    "features": "https://gc.ai/features",
    "about": "https://gc.ai/company",
    "pricing": "https://gc.ai/pricing",
}

outdir = os.path.dirname(os.path.abspath(__file__))

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")

def extract_text(raw):
    # Remove style/script blocks but KEEP the RSC payload scripts (they contain the text)
    # Strategy: html-unescape, strip tags, collapse whitespace.
    txt = raw
    # Remove css <style> contents
    txt = re.sub(r"<style[^>]*>.*?</style>", " ", txt, flags=re.S)
    # Unescape JS-escaped quotes inside RSC payload
    txt = txt.replace(r"\"", '"').replace(r"\n", " ").replace("\\\\", "\\")
    txt = html.unescape(txt)
    # Extract children text from RSC payload: "children":"...."
    children = re.findall(r'"children":"((?:[^"\\]|\\.)*)"', txt)
    text_parts = [c.replace('\\"', '"').replace("\\n", " ") for c in children]
    # Also grab meta descriptions
    body = " ".join(text_parts)
    # Filter out className garbage / css remnants
    body = re.sub(r"\s+", " ", body)
    return body

for name, url in urls.items():
    try:
        raw = fetch(url)
        text = extract_text(raw)
        with open(os.path.join(outdir, name + ".txt"), "w", encoding="utf-8") as f:
            f.write(text)
        print(name, "OK", len(text))
    except Exception as e:
        print(name, "FAIL", e)
