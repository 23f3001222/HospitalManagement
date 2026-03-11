from __future__ import annotations

import os

from celery import Celery
from celery.schedules import crontab

from backend.app import create_app


def make_celery():
    flask_app = create_app()
    celery = Celery(
        "backend",
        broker=flask_app.config["REDIS_URL"],
        backend=flask_app.config["REDIS_URL"],
        include=["backend.tasks"],
    )
    celery.conf.timezone = os.environ.get("HMS_TIMEZONE", "UTC")
    celery.conf.beat_schedule = {
        "daily-reminders": {
            "task": "backend.tasks.send_daily_reminders",
            "schedule": crontab(hour=int(os.environ.get("HMS_REMINDER_HOUR", "9")), minute=0),
        },
        "monthly-doctor-report": {
            "task": "backend.tasks.send_monthly_doctor_reports",
            "schedule": crontab(
                day_of_month=1, hour=int(os.environ.get("HMS_REPORT_HOUR", "9")), minute=15
            ),
        },
    }

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with flask_app.app_context():
                return self.run(*args, **kwargs)

    celery.Task = ContextTask
    return celery


celery = make_celery()

