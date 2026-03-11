import os


class Config:
    SECRET_KEY = os.environ.get("HMS_SECRET_KEY", "dev-secret-change-me")
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "HMS_DATABASE_URL", f"sqlite:///{os.path.abspath('backend/hms.sqlite3')}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    REDIS_URL = os.environ.get("HMS_REDIS_URL", "redis://localhost:6379/0")
    CACHE_DEFAULT_TTL_SECONDS = int(os.environ.get("HMS_CACHE_TTL_SECONDS", "60"))

    ADMIN_USERNAME = os.environ.get("HMS_ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD = os.environ.get("HMS_ADMIN_PASSWORD", "admin123")
