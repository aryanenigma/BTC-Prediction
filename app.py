# ...existing code...
import http.server
import socketserver
import json
import requests
from urllib.parse import urlparse, parse_qs
import xml.etree.ElementTree as ET
import os
from email.utils import parsedate_to_datetime

# Added imports for timezone-aware resampling & simple AI
import pandas as pd
import pytz
from datetime import datetime
import math
import random

PORT = 8000

def json_response(handler, data, status=200):
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(json.dumps(data).encode())

def fetch_binance_klines(symbol="BTCUSDT", interval="1m", limit=500):
    """
    Return list of candles with UTC epoch seconds in 'time' and OHLC floats.
    """
    url = "https://api.binance.com/api/v3/klines"
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return [
        {
            "time": int(c[0] // 1000),  # UNIX seconds (UTC)
            "open": float(c[1]),
            "high": float(c[2]),
            "low": float(c[3]),
            "close": float(c[4]),
            "volume": float(c[5]) if len(c) > 5 else 0.0
        }
        for c in data
    ]

def resample_candles_to_timezone(candles, interval, tz_name):
    """
    Resample raw 1m candles to the requested interval but anchored to the specified timezone.
    Returns list of candles with 'time' being UTC epoch seconds of the candle OPEN (aligned to local timezone boundaries).
    """
    freq_map = {
        "1m": "1T", "5m": "5T", "10m": "10T", "15m": "15T", "30m": "30T",
        "1h": "1H", "4h": "4H", "1d": "1D"
    }
    freq = freq_map.get(interval)
    if freq is None:
        # unknown interval: return input as-is
        return candles

    if len(candles) == 0:
        return []

    df = pd.DataFrame(candles)
    df["time"] = pd.to_datetime(df["time"].astype(int), unit="s", utc=True)
    df = df.set_index("time").sort_index()

    try:
        tz = pytz.timezone(tz_name)
    except Exception:
        tz = pytz.UTC

    df_local = df.tz_convert(tz)
    agg = {"open":"first","high":"max","low":"min","close":"last","volume":"sum"}
    res = df_local.resample(freq, label="left", closed="left").agg(agg).dropna()
    if res.empty:
        return []

    idx_utc = res.index.tz_convert(pytz.UTC)
    epoch_secs = (idx_utc.astype("int64") // 10**9).astype(int)

    out = []
    for i, row in enumerate(res.itertuples()):
        out.append({
            "time": int(epoch_secs[i]),
            "open": float(row.open),
            "high": float(row.high),
            "low": float(row.low),
            "close": float(row.close),
            "volume": float(row.volume),
            "local_time": res.index[i].isoformat()
        })
    return out

def fetch_coindesk_rss(count=20):
    url = "https://www.coindesk.com/arc/outboundfeeds/rss/"
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
        items = []
        for item in root.findall(".//item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            try:
                pub_iso = parsedate_to_datetime(pub).isoformat()
            except Exception:
                pub_iso = pub
            items.append({"title": title, "link": link, "pubDate": pub_iso})
        btc_items = [it for it in items if "bitcoin" in it["title"].lower() or "btc" in it["title"].lower() or "crypto" in it["title"].lower()]
        return btc_items[:count] if btc_items else items[:count]
    except Exception:
        return []

def simple_sentiment(title):
    t = title.lower()
    pos_keywords = ["gain","gains","surge","rally","bull","bullish","beats","pump","soars","up","record"]
    neg_keywords = ["drop","drops","crash","crashes","slump","plunge","bear","bearish","falls","down","dip"]
    score = sum(1 for k in pos_keywords if k in t) - sum(1 for k in neg_keywords if k in t)
    return "positive" if score>0 else "negative" if score<0 else "neutral"

# --- Simple AI prediction helper (lightweight, explainable stub) ---
def sigmoid(x): return 1 / (1 + math.exp(-x))

def predict_breakout_probability(candles):
    """
    Simple heuristic model producing probability [0..1] and short reasons.
    Uses recent momentum, volatility and volume spike features.
    """
    if len(candles) < 6:
        return {"prob": 0.5, "label": "neutral", "reason": "not enough history"}

    # take last N candles
    N = min(20, len(candles))
    last = candles[-N:]
    closes = [c["close"] for c in last]
    opens = [c["open"] for c in last]
    volumes = [c.get("volume", 0) for c in last]

    returns = [(closes[i] - opens[i]) / opens[i] if opens[i] else 0 for i in range(len(last))]
    avg_return = float(pd.Series(returns).tail(5).mean())
    vol = float(pd.Series(returns).std())
    vol_mean = float(pd.Series(volumes).mean())
    latest_vol = volumes[-1] if volumes else 0
    vol_spike = 1.0 if vol_mean>0 and latest_vol > vol_mean * 1.5 else 0.0

    # small linear model (weights tuned by heuristic)
    score = 2.5 * avg_return - 4.0 * vol + 1.8 * vol_spike
    prob = float(sigmoid(score))

    label = "bullish" if prob > 0.62 else "bearish" if prob < 0.38 else "neutral"
    reasons = []
    if avg_return > 0.001: reasons.append("positive near-term momentum")
    if avg_return < -0.001: reasons.append("negative near-term momentum")
    if vol > 0.02: reasons.append("high short-term volatility")
    if vol_spike: reasons.append("volume spike")
    if not reasons: reasons.append("mixed signals")

    return {"prob": prob, "label": label, "reason": "; ".join(reasons)}

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        path = parsed.path

        if path == "/api/candles":
            interval = qs.get("interval", ["1m"])[0]
            timezone = qs.get("timezone", ["UTC"])[0]
            if timezone == "auto" or not timezone:
                timezone = "UTC"
            try:
                raw_1m = fetch_binance_klines(interval="1m", limit=1500)
                candles = resample_candles_to_timezone(raw_1m, interval, timezone)
                json_response(self, candles)
            except Exception as e:
                json_response(self, {"error": str(e)}, status=500)
            return

        if path == "/api/btc_news":
            try:
                items = fetch_coindesk_rss(count=20)
                out = []
                for it in items[:12]:
                    sentiment = simple_sentiment(it["title"])
                    out.append({
                        "title": it["title"],
                        "link": it["link"],
                        "pubDate": it["pubDate"],
                        "sentiment": sentiment
                    })
                    if len(out) >= 5:
                        break
                json_response(self, out)
            except Exception as e:
                json_response(self, {"error": str(e)}, status=500)
            return

        # AI predict endpoint (returns probability and short explanation)
        if path == "/api/predict":
            interval = qs.get("interval", ["15m"])[0]
            timezone = qs.get("timezone", ["UTC"])[0]
            if timezone == "auto" or not timezone:
                timezone = "UTC"
            try:
                raw_1m = fetch_binance_klines(interval="1m", limit=1500)
                candles = resample_candles_to_timezone(raw_1m, interval, timezone)
                model_out = predict_breakout_probability(candles)
                json_response(self, {"prediction": model_out})
            except Exception as e:
                json_response(self, {"error": str(e)}, status=500)
            return

        # favicon
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        # default static files
        return http.server.SimpleHTTPRequestHandler.do_GET(self)

if __name__ == "__main__":
    os.chdir(os.path.dirname(__file__))
    print(f"🚀 BTC Dashboard backend running on http://localhost:{PORT}")
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n🛑 Server stopped manually.")
            httpd.shutdown()
# ...existing code...