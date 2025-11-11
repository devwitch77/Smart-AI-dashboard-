# Smart-AI-dashboard-
A full-stack real-time facility management platform integrating IoT sensor streams, AI anomaly detection, natural-language summaries, and voice intelligence, all engineered end-to-end from scratch.



# Overview
This project is a unified “smart facility” platform that brings together:

Live sensor streaming via WebSockets and Node/Express

Real-time dashboard UI built with React + Vite

Advanced anomaly detection using Isolation Forest and z-score baselines

Natural-language summarization and automatic report generation (PDF + CSV)

Fully deployed end-to-end: frontend, backend, Python AI service, database

Designed for multiple facilities (e.g., Dubai, London, Tokyo) with custom thresholds and floor-plan visuals

# Architecture & Tech Stack

| Layer                  | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| **Frontend (client/)** | React (via Vite) dashboard with charts, 3D mini-map, alert voice TTS, AI panel                   |
| **Backend (server/)**  | Node.js + Express + Socket.IO; routes for sensor stream, AI endpoints, reports                   |
| **AI Service (pyai/)** | Python FastAPI micro-service; runs machine-learning model (Isolation Forest) & summary endpoints |
| **Data Storage**       | PostgreSQL for sensor data, alerts, and AI baselines                                             |
| **Deployment**         | GitHub repo → Railway for backend+AI service + Postgres → Netlify/Vercel for frontend            |
| **Reports**            | Server-generated PDF/CSV with branded header, KPI cards, sensor statistics, recommendations      |


# Key Features
- Real-time sensor feed: Dashboard displays latest values and history for Temperature, Humidity, CO₂, Light sensors.

- Alerting engine: Threshold checks + anomaly detection trigger alerts and voice announcements.

- AI Insights Panel: Uses historical baselines and machine-learning to compute a “Stability” Score, list top issues, and generate user-friendly summaries.

- Intelligence Layer: Models generate contextual summaries like “Temperature sensors in Dubai show sustained instability since 14:00. HVAC load likely high.”

- Reporting module: Export to CSV or professionally styled PDF with:

  - Header banner

  - Facility + time range

  - KPI cards (System Status, Active Alerts, Sensors Seen, Time Range)

  - Table: Anomalies by facility

  - Table: Sensor statistics (count, mean, std, last, z-score)

  - Generated recommendations (e.g., HVAC self-check, ventilation tweak)

- Multi-facility support: Named facilities (Dubai, London, Tokyo) with distinct threshold sets & 3D mini-map scenes.

- Deployment ready: Environment variables, CORS settings, and infrastructure instructions included for live web deployment.


#  ⚙️ Setup & Development Guide

1. Clone the Repository 
git clone https://github.com/devwitch77/Smart-AI-dashboard-.git
cd Smart-AI-dashboard

2. Set up the Database

psql -U postgres
CREATE DATABASE smart_facility;
\q

2.1 In your .env (inside /server), set

DB_HOST=localhost
DB_PORT=5432
DB_NAME=smart_facility
DB_USER=postgres
DB_PASS=your_password
PY_AI_URL=http://127.0.0.1:7001


3. Server (Express + Socket.IO)

cd server
npm install
npm run dev     # or: node server.js



4. AI Service (FastAPI + Isolation Forest)

cd ../pyai
python -m venv .venv
. .venv/Scripts/activate       (Windows)
 or: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 7001
(✅ Expected:
INFO: Uvicorn running on http://127.0.0.1:7001)

5. Client (React Dashboard)

cd ../client
npm install
cp .env.example .env
(then open .env and set:)
VITE_API_BASE=http://127.0.0.1:5000
VITE_SOCKET_URL=http://127.0.0.1:5000
npm run dev

The dashboard will display:

Live sensor values & charts

AI Insights Panel (Stability Score + Summary)

Real-time alerts with TTS

Facility map and PDF reports

6. Running All Together

Start PostgreSQL

Run server (npm run dev)

Run AI service (uvicorn app:app)

Run client (npm run dev)

(Tip: Use VS Code’s “Run Task → All Services” or a process manager like pm2 or forever to run them simultaneously.)

# 🔐 License & Contributions

This project is licensed under the MIT License.
Pull requests, issues and improvements welcome — just fork the repo and submit a PR.

# 🙏 Acknowledgements

Thanks to open-source communities for React, Express, FastAPI, PDFKit, Chart.js and many other tools.
Your contributions support this full-stack build and its real-world applicability.
