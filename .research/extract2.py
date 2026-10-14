import re, html, os, urllib.request, json

outdir = os.path.dirname(os.path.abspath(__file__))

urls = {
    "product-update-full": "https://gc.ai/blog/product-update-easy-prompt",
    "glossary-prompting": "https://gc.ai/glossary/prompting",
    "learn-ai": "https://gc.ai/learn-ai",
    "opinion-overview-prompt": "https://gc.ai/blog/opinion-overview-prompt",
}

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")

def extract_all_strings(raw):
    # Grab every JSON-ish string literal in the page (RSC payload is JS strings)
    raw = raw.replace('\\"', '"')
    # find quoted strings at least 25 chars long
    strings = re.findall(r'"([^"\\]{25,})"', raw)
    out = []
    for s in strings:
        s2 = html.unescape(s).replace("\\n", " ")
        # skip css chunks, classNames, urls-only strings
        if re.search(r"[{}<>]|className|font-family|woff2|http[s]?://\S+\.(css|png|jpg|woff)", s2):
            continue
        if len(re.findall(r"[a-zA-Z] ", s2)) < 3 and len(s2) < 120:
            continue
        out.append(s2)
    # dedupe preserving order
    seen = set()
    result = []
    for s in out:
        key = s[:80]
        if key not in seen:
            seen.add(key)
            result.append(s)
    return "\n".join(result)

for name, url in urls.items():
    try:
        raw = fetch(url)
        text = extract_all_strings(raw)
        with open(os.path.join(outdir, name + ".txt"), "w", encoding="utf-8") as f:
            f.write(text)
        print(name, "OK", len(text))
    except Exception as e:
        print(name, "FAIL", e)
