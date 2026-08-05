"""Load pre-embedded (bge-m3, 1024-d) Wikipedia parquet shards into Qdrant.
Vectors are pre-computed -> no local embedding, just bulk upsert.
Usage: python wiki-load.py <shard.parquet> [<shard.parquet> ...]
"""
import sys, hashlib, json, urllib.request
import pyarrow.parquet as pq

QDRANT = "http://127.0.0.1:6333"
COLL = "wikipedia_bge_m3"


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(QDRANT + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120) as resp:
        return resp.status, resp.read()


def ensure():
    try:
        req("PUT", f"/collections/{COLL}",
            {"vectors": {"size": 1024, "distance": "Cosine"}})
    except Exception:
        pass  # already exists


def pid(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:15], 16)


def load(path):
    f = pq.ParquetFile(path)
    total = 0
    for tb in f.iter_batches(batch_size=1000, columns=["id", "url", "title", "text", "embedding"]):
        rows = tb.to_pylist()
        points = [{
            "id": pid(r["id"]),
            "vector": r["embedding"],
            "payload": {"title": r["title"], "url": r["url"], "text": r["text"][:1500]},
        } for r in rows]
        st, bd = req("PUT", f"/collections/{COLL}/points?wait=true", {"points": points})
        if st >= 300:
            print("upsert err", st, bd[:200]); return total
        total += len(rows)
        if total % 10000 == 0:
            print(f"  {path}: {total} loaded", flush=True)
    return total


if __name__ == "__main__":
    ensure()
    grand = 0
    for p in sys.argv[1:]:
        grand += load(p)
    print(f"LOAD DONE total={grand}")
