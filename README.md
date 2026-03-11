# Hospital Management System (HMS) - V2

Flask (API) + VueJS (CDN) + Bootstrap + SQLite + Redis + Celery.

## Quickstart (local)

### 1) Start Redis

If you have Redis installed (recommended):

```bash
redis-server
```

Or with Docker:

```bash
### NOTE: Docker Desktop / Docker daemon must be running
docker run --rm -p 6379:6379 redis:7
```

### 2) Run backend (Flask API + UI)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
python backend/run.py
```

Open `http://127.0.0.1:5001/`.

### 3) Run Celery worker + scheduler

In two terminals (with the venv active):

```bash
celery -A backend.celery_app.celery worker --loglevel=info
celery -A backend.celery_app.celery beat --loglevel=info
```

## Default credentials (created programmatically)

- Admin: `admin` / `admin123`

You can change these in environment variables later.

