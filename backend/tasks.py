from __future__ import annotations

import csv
import io
import json
import os
import smtplib
import ssl
import urllib.request
from datetime import date, datetime

from celery import shared_task

from backend.extensions import db
from backend.models import (
    Appointment,
    AppointmentStatus,
    DoctorProfile,
    PatientProfile,
    Treatment,
    User,
    UserRole,
)


def _send_gchat_message(message: str) -> bool:
    webhook = os.environ.get("HMS_GCHAT_WEBHOOK_URL")
    if not webhook:
        return False
    payload = json.dumps({"text": message}).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def _notify_user(channel: str, message: str) -> None:
    # channel is informational (username/phone/email). For this project we support GChat webhook.
    if _send_gchat_message(message):
        return
    print(f"[notify:{channel}] {message}")


def _send_email(to_email: str, subject: str, html_body: str) -> bool:
    host = os.environ.get("HMS_SMTP_HOST")
    port = int(os.environ.get("HMS_SMTP_PORT", "587"))
    username = os.environ.get("HMS_SMTP_USERNAME")
    password = os.environ.get("HMS_SMTP_PASSWORD")
    from_email = os.environ.get("HMS_SMTP_FROM", username or "no-reply@example.com")

    if not (host and username and password):
        return False

    msg = (
        f"From: {from_email}\r\n"
        f"To: {to_email}\r\n"
        f"Subject: {subject}\r\n"
        "MIME-Version: 1.0\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "\r\n"
        f"{html_body}"
    ).encode("utf-8")

    context = ssl.create_default_context()
    try:
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls(context=context)
            server.login(username, password)
            server.sendmail(from_email, [to_email], msg)
        return True
    except Exception:
        return False


def _email_or_log(to_email: str, subject: str, html_body: str) -> None:
    if _send_email(to_email=to_email, subject=subject, html_body=html_body):
        return
    print(f"[email to={to_email}] subject={subject}\n{html_body}\n---")


@shared_task(name="backend.tasks.send_daily_reminders")
def send_daily_reminders():
    today = date.today()
    appts = Appointment.query.filter_by(appointment_date=today, status=AppointmentStatus.BOOKED.value).all()
    for a in appts:
        patient = PatientProfile.query.get(a.patient_id)
        if not patient:
            continue
        u = patient.user
        msg = f"Reminder: you have an appointment today at {a.appointment_time.strftime('%H:%M')}."
        _notify_user(channel=u.username, message=msg)
    return {"date": today.isoformat(), "count": len(appts)}


@shared_task(name="backend.tasks.send_monthly_doctor_reports")
def send_monthly_doctor_reports(force: bool = False):
    """
    Generate and send monthly doctor activity reports.

    - When called on schedule by Celery Beat, runs with force=False and only sends
      reports on the first day of the month (for the previous month).
    - For demo/manual triggering, you can call with force=True to always
      generate the report regardless of today's date.
    """
    today = date.today()
    if not force and today.day != 1:
        return {"skipped": True, "reason": "not_first_day"}

    year = today.year
    month = today.month - 1
    if month == 0:
        month = 12
        year -= 1

    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)

    doctors = DoctorProfile.query.all()
    sent = 0
    for d in doctors:
        completed = (
            Appointment.query.filter(
                Appointment.doctor_id == d.id,
                Appointment.status == AppointmentStatus.COMPLETED.value,
                Appointment.appointment_date >= start,
                Appointment.appointment_date < end,
            )
            .order_by(Appointment.appointment_date.asc())
            .all()
        )
        rows = []
        for a in completed:
            t = a.treatment
            rows.append(
                f"<tr><td>{a.appointment_date}</td><td>{a.appointment_time.strftime('%H:%M')}</td>"
                f"<td>{(t.diagnosis if t else '')}</td><td>{(t.prescription if t else '')}</td></tr>"
            )
        html = (
            f"<h3>Monthly Activity Report</h3>"
            f"<p>Doctor: {d.user.full_name or d.user.username}</p>"
            f"<p>Period: {start} to {end}</p>"
            f"<table border='1' cellpadding='6' cellspacing='0'>"
            f"<tr><th>Date</th><th>Time</th><th>Diagnosis</th><th>Prescription</th></tr>"
            f"{''.join(rows) if rows else '<tr><td colspan=4>No completed appointments</td></tr>'}"
            f"</table>"
        )
        to_email = d.user.email or f"{d.user.username}@example.com"
        _email_or_log(to_email=to_email, subject="Monthly Activity Report", html_body=html)
        sent += 1
    return {"sent": sent, "month": month, "year": year}


@shared_task(name="backend.tasks.export_patient_treatments_csv")
def export_patient_treatments_csv(patient_user_id: int):
    patient_user = User.query.get(patient_user_id)
    if not patient_user or patient_user.role != UserRole.PATIENT.value:
        return {"error": "patient_not_found"}
    patient = patient_user.patient_profile
    if not patient:
        return {"error": "patient_profile_missing"}

    appts = (
        Appointment.query.filter_by(patient_id=patient.id)
        .order_by(Appointment.appointment_date.desc(), Appointment.appointment_time.desc())
        .all()
    )

    f = io.StringIO()
    w = csv.writer(f)
    w.writerow(
        [
            "user_id",
            "username",
            "consulting_doctor",
            "appointment_date",
            "appointment_time",
            "status",
            "diagnosis",
            "treatment_given",
            "next_visit_suggested",
            "notes",
        ]
    )
    for a in appts:
        t = a.treatment
        doctor_name = None
        if a.doctor_id:
            d = DoctorProfile.query.get(a.doctor_id)
            if d and d.user:
                doctor_name = d.user.full_name or d.user.username
        w.writerow(
            [
                patient_user.id,
                patient_user.username,
                doctor_name,
                a.appointment_date.isoformat(),
                a.appointment_time.strftime("%H:%M"),
                a.status,
                (t.diagnosis if t else ""),
                (t.prescription if t else ""),
                (t.next_visit_suggested if t else ""),
                (t.notes if t else ""),
            ]
        )

    content = f.getvalue()
    _notify_user(channel=patient_user.username, message="Your treatment CSV export is ready.")
    return {
        "ok": True,
        "kind": "patient_treatments_csv",
        "patient_user_id": patient_user.id,
        "patient_username": patient_user.username,
        "bytes": len(content),
        "csv": content,
    }

