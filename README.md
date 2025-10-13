# 🚀 BTC Dashboard Backend

This is a **Python backend** for a Bitcoin dashboard that provides:  

- Real-time BTC candlestick data from Binance, resampled to any interval and timezone.  
- Latest Bitcoin news with **simple sentiment analysis**.  
- Lightweight **AI-based breakout prediction** using a custom heuristic strategy.  

It’s designed for hackathons, prototypes, and personal crypto tools.  

---

## 🔹 Features

1. **Candlestick Data API**  
   - Endpoint: `/api/candles`  
   - Query parameters:  
     - `interval` (default: `1m`) → options: `1m, 5m, 15m, 30m, 1h, 4h, 1d`  
     - `timezone` (default: `UTC`, or use `auto`)  
   - Returns OHLCV data aligned to your timezone.  

2. **Bitcoin News API**  
   - Endpoint: `/api/btc_news`  
   - Fetches latest Bitcoin and crypto news from Coindesk RSS.  
   - Returns titles, links, publish date, and a simple sentiment (`positive`, `negative`, `neutral`).  

3. **AI Breakout Prediction API**  
   - Endpoint: `/api/predict`  
   - Uses a **lightweight heuristic model** to predict BTC price breakout probability.  
   - Features used: recent momentum, volatility, volume spikes.  
   - Returns: probability, label (`bullish`, `bearish`, `neutral`), and explanation.  

---

## ⚡ Installation

1. Clone the repository:

```bash
git clone https://github.com/<your-username>/btc-dashboard-backend.git
cd btc-dashboard-backend
