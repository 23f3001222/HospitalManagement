from __future__ import annotations

import re
from datetime import datetime, date, timedelta, time as dtime

from flask import Flask, jsonify, request, session, render_template, make_response
from flask_cors import CORS
from sqlalchemy import text

from backend.cache import RedisCache
from backend.config import Config
from backend.extensions import db
from backend.models import (
    User,
    UserRole,
    Department,
    DoctorProfile,
    PatientProfile,
    DoctorAvailability,
    Appointment,
    AppointmentStatus,
    Treatment,
)
from backend.auth import current_user, login_required, role_required


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalize_email(email: str | None) -> str | None:
    if email is None:
        return None
    v = str(email).strip()
    if not v:
        return None
    return v.lower()


def _is_valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email))


def create_app():
    app = Flask(__name__, template_folder="../frontend/templates", static_folder="../frontend/static")
    app.config.from_object(Config)
    CORS(app, supports_credentials=True)

    db.init_app(app)
    cache = RedisCache(app.config["REDIS_URL"])
    app.extensions["cache"] = cache

    with app.app_context():
        db.create_all()
        _ensure_schema_upgrades()
        _ensure_admin(app)
        _seed_departments()

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True, "time": datetime.utcnow().isoformat()})

    @app.get("/api/redis/ping")
    def redis_ping():
        try:
            cache._r.ping()
            return jsonify({"ok": True, "redis_url": app.config["REDIS_URL"]})
        except Exception as e:
            return jsonify({"ok": False, "redis_url": app.config["REDIS_URL"], "error": str(e)}), 500

    # ---------- Auth ----------
    @app.post("/api/auth/login")
    def login():
        data = request.get_json(force=True)
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        # Allow logging in with either username or full_name (helps when admins think in names)
        user = (
            User.query.filter(
                db.or_(
                    User.username == username,
                    db.func.lower(User.full_name) == db.func.lower(username),
                )
            )
            .order_by(User.id.asc())
            .first()
        )
        if not user or not user.is_active or not user.check_password(password):
            return jsonify({"error": "invalid_credentials"}), 401
        session["user_id"] = user.id
        return jsonify({"id": user.id, "username": user.username, "role": user.role})

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return jsonify({"ok": True})

    @app.get("/api/auth/me")
    def me():
        user = current_user()
        if not user or not user.is_active:
            return jsonify({"user": None})
        return jsonify({"user": {"id": user.id, "username": user.username, "role": user.role}})

    @app.post("/api/auth/register")
    def register_patient():
        data = request.get_json(force=True)
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        full_name = (data.get("full_name") or "").strip()
        email = _normalize_email(data.get("email"))
        if not username or not password:
            return jsonify({"error": "username_and_password_required"}), 400
        if not email:
            return jsonify({"error": "email_required"}), 400
        if not _is_valid_email(email):
            return jsonify({"error": "invalid_email"}), 400
        if User.query.filter_by(username=username).first():
            return jsonify({"error": "username_taken"}), 409
        if (
            User.query.filter(db.func.lower(User.email) == email)
            .order_by(User.id.asc())
            .first()
            is not None
        ):
            return jsonify({"error": "email_taken"}), 409
        user = User(
            username=username,
            role=UserRole.PATIENT.value,
            full_name=full_name,
            email=email,
            is_active=True,
        )
        user.set_password(password)
        db.session.add(user)
        db.session.flush()
        db.session.add(PatientProfile(user_id=user.id))
        db.session.commit()
        return jsonify({"ok": True})

    # ---------- Admin ----------
    @app.get("/api/admin/stats")
    @role_required(UserRole.ADMIN)
    def admin_stats():
        return jsonify(
            {
                "doctors": DoctorProfile.query.count(),
                "patients": PatientProfile.query.count(),
                "appointments": Appointment.query.count(),
            }
        )

    @app.get("/api/admin/doctors")
    @role_required(UserRole.ADMIN)
    def admin_list_doctors():
        q = (request.args.get("q") or "").strip().lower()
        query = DoctorProfile.query.join(User).join(Department)
        if q:
            query = query.filter(
                db.or_(
                    db.func.lower(User.full_name).like(f"%{q}%"),
                    db.func.lower(DoctorProfile.specialization).like(f"%{q}%"),
                    db.func.lower(Department.name).like(f"%{q}%"),
                )
            )
        doctors = query.order_by(User.full_name.asc()).all()
        return jsonify(
            {
                "doctors": [
                    {
                        "id": d.id,
                        "user_id": d.user_id,
                        "name": d.user.full_name or d.user.username,
                        "username": d.user.username,
                        "phone": d.user.phone,
                        "email": d.user.email,
                        "specialization": d.specialization,
                        "department": d.department.name,
                        "department_id": d.department_id,
                        "is_active": d.user.is_active,
                    }
                    for d in doctors
                ]
            }
        )

    @app.patch("/api/admin/doctors/<int:doctor_id>")
    @role_required(UserRole.ADMIN)
    def admin_update_doctor(doctor_id: int):
        data = request.get_json(force=True)
        doc = DoctorProfile.query.get_or_404(doctor_id)
        user = doc.user

        full_name = data.get("full_name")
        phone = data.get("phone")
        email = data.get("email")
        specialization = data.get("specialization")
        department_id = data.get("department_id")

        if full_name is not None:
            user.full_name = full_name or None
        if phone is not None:
            user.phone = phone or None
        if email is not None:
            normalized = _normalize_email(email)
            if normalized is None:
                user.email = None
            else:
                if not _is_valid_email(normalized):
                    return jsonify({"error": "invalid_email"}), 400
                existing = (
                    User.query.filter(db.func.lower(User.email) == normalized, User.id != user.id)
                    .order_by(User.id.asc())
                    .first()
                )
                if existing is not None:
                    return jsonify({"error": "email_taken"}), 409
                user.email = normalized
        if specialization is not None:
            doc.specialization = specialization or doc.specialization
        if department_id is not None:
            dept = Department.query.get(int(department_id))
            if not dept:
                return jsonify({"error": "department_not_found"}), 404
            doc.department_id = dept.id

        db.session.commit()
        _invalidate_catalog_cache(app)
        return jsonify({"ok": True})

    @app.post("/api/admin/doctors")
    @role_required(UserRole.ADMIN)
    def admin_create_doctor():
        data = request.get_json(force=True)
        username = (data.get("username") or "").strip()
        password = data.get("password") or "doctor123"
        full_name = (data.get("full_name") or "").strip()
        specialization = (data.get("specialization") or "").strip()
        department_id = data.get("department_id")
        email = _normalize_email(data.get("email"))
        if not (username and full_name and specialization and department_id):
            return jsonify({"error": "missing_fields"}), 400
        if not email:
            return jsonify({"error": "email_required"}), 400
        if not _is_valid_email(email):
            return jsonify({"error": "invalid_email"}), 400
        if " " in username:
            return jsonify({"error": "username_no_spaces"}), 400
        if User.query.filter_by(username=username).first():
            return jsonify({"error": "username_taken"}), 409
        if (
            User.query.filter(db.func.lower(User.email) == email)
            .order_by(User.id.asc())
            .first()
            is not None
        ):
            return jsonify({"error": "email_taken"}), 409
        dept = Department.query.get(int(department_id))
        if not dept:
            return jsonify({"error": "department_not_found"}), 404
        user = User(
            username=username,
            role=UserRole.DOCTOR.value,
            full_name=full_name,
            email=email,
            is_active=True,
        )
        user.set_password(password)
        db.session.add(user)
        db.session.flush()
        doc = DoctorProfile(user_id=user.id, department_id=dept.id, specialization=specialization)
        db.session.add(doc)
        db.session.commit()
        _invalidate_catalog_cache(app)
        return jsonify({"ok": True, "doctor_id": doc.id})

    @app.patch("/api/admin/users/<int:user_id>/status")
    @role_required(UserRole.ADMIN)
    def admin_set_user_status(user_id: int):
        data = request.get_json(force=True)
        is_active = bool(data.get("is_active"))
        user = User.query.get_or_404(user_id)
        if user.role == UserRole.ADMIN.value:
            return jsonify({"error": "cannot_disable_admin"}), 400
        user.is_active = is_active
        db.session.commit()
        _invalidate_catalog_cache(app)
        return jsonify({"ok": True})

    @app.post("/api/admin/users/<int:user_id>/reset_password")
    @role_required(UserRole.ADMIN)
    def admin_reset_user_password(user_id: int):
        data = request.get_json(force=True)
        new_password = data.get("new_password") or "welcome123"
        user = User.query.get_or_404(user_id)
        if user.role == UserRole.ADMIN.value:
            return jsonify({"error": "cannot_reset_admin_password"}), 400
        user.set_password(new_password)
        db.session.commit()
        return jsonify({"ok": True})

    @app.get("/api/admin/patients")
    @role_required(UserRole.ADMIN)
    def admin_list_patients():
        q = (request.args.get("q") or "").strip().lower()
        query = PatientProfile.query.join(User)
        if q:
            query = query.filter(
                db.or_(
                    db.func.lower(User.full_name).like(f"%{q}%"),
                    db.func.lower(User.username).like(f"%{q}%"),
                    db.func.lower(User.phone).like(f"%{q}%"),
                    db.func.lower(User.email).like(f"%{q}%"),
                )
            )
        patients = query.order_by(User.full_name.asc()).all()
        return jsonify(
            {
                "patients": [
                    {
                        "id": p.id,
                        "user_id": p.user_id,
                        "name": p.user.full_name or p.user.username,
                        "username": p.user.username,
                        "phone": p.user.phone,
                        "email": p.user.email,
                        "is_active": p.user.is_active,
                    }
                    for p in patients
                ]
            }
        )

    @app.patch("/api/admin/patients/<int:patient_profile_id>")
    @role_required(UserRole.ADMIN)
    def admin_update_patient(patient_profile_id: int):
        data = request.get_json(force=True)
        patient = PatientProfile.query.get_or_404(patient_profile_id)
        user = patient.user

        full_name = data.get("full_name")
        phone = data.get("phone")
        email = data.get("email")

        if full_name is not None:
            user.full_name = full_name or None
        if phone is not None:
            user.phone = phone or None
        if email is not None:
            normalized = _normalize_email(email)
            if normalized is None:
                user.email = None
            else:
                if not _is_valid_email(normalized):
                    return jsonify({"error": "invalid_email"}), 400
                existing = (
                    User.query.filter(db.func.lower(User.email) == normalized, User.id != user.id)
                    .order_by(User.id.asc())
                    .first()
                )
                if existing is not None:
                    return jsonify({"error": "email_taken"}), 409
                user.email = normalized

        db.session.commit()
        return jsonify({"ok": True})

    @app.get("/api/admin/appointments")
    @role_required(UserRole.ADMIN)
    def admin_list_appointments():
        status = request.args.get("status")
        query = Appointment.query
        if status:
            query = query.filter_by(status=status)
        appts = query.order_by(Appointment.appointment_date.desc(), Appointment.appointment_time.desc()).limit(500).all()
        return jsonify({"appointments": [_serialize_appointment(a) for a in appts]})

    # ---------- Catalog for patients ----------
    @app.get("/api/catalog/departments")
    @login_required
    def list_departments():
        cache_key = "catalog:departments:v1"
        cached = cache.get_json(cache_key)
        if cached:
            return jsonify(cached)
        depts = Department.query.order_by(Department.name.asc()).all()
        payload = {
            "departments": [{"id": d.id, "name": d.name, "description": d.description} for d in depts]
        }
        cache.set_json(cache_key, payload, ttl_seconds=app.config["CACHE_DEFAULT_TTL_SECONDS"])
        return jsonify(payload)

    @app.get("/api/catalog/doctors")
    @login_required
    def list_doctors_catalog():
        dept_id = request.args.get("department_id")
        q = (request.args.get("q") or "").strip().lower()
        cache_key = f"catalog:doctors:v1:{dept_id}:{q}"
        cached = cache.get_json(cache_key)
        if cached:
            return jsonify(cached)

        query = DoctorProfile.query.join(User).join(Department).filter(User.is_active.is_(True))
        if dept_id:
            query = query.filter(DoctorProfile.department_id == int(dept_id))
        if q:
            query = query.filter(
                db.or_(
                    db.func.lower(User.full_name).like(f"%{q}%"),
                    db.func.lower(DoctorProfile.specialization).like(f"%{q}%"),
                    db.func.lower(Department.name).like(f"%{q}%"),
                )
            )
        docs = query.order_by(User.full_name.asc()).all()

        start = date.today()
        end = start + timedelta(days=7)
        doc_ids = [d.id for d in docs]
        avails = (
            DoctorAvailability.query.filter(
                DoctorAvailability.doctor_id.in_(doc_ids),
                DoctorAvailability.day >= start,
                DoctorAvailability.day < end,
                DoctorAvailability.is_available.is_(True),
            )
            .order_by(DoctorAvailability.day.asc(), DoctorAvailability.start_time.asc())
            .all()
        )
        av_by_doc = {}
        for a in avails:
            av_by_doc.setdefault(a.doctor_id, []).append(
                {
                    "day": a.day.isoformat(),
                    "start_time": a.start_time.strftime("%H:%M"),
                    "end_time": a.end_time.strftime("%H:%M"),
                }
            )

        payload = {
            "doctors": [
                {
                    "id": d.id,
                    "name": d.user.full_name or d.user.username,
                    "specialization": d.specialization,
                    "department": d.department.name,
                    "availabilities": av_by_doc.get(d.id, []),
                }
                for d in docs
            ]
        }
        cache.set_json(cache_key, payload, ttl_seconds=app.config["CACHE_DEFAULT_TTL_SECONDS"])
        return jsonify(payload)

    # ---------- Patient ----------
    @app.get("/api/patient/profile")
    @role_required(UserRole.PATIENT)
    def patient_profile():
        user = current_user()
        return jsonify(
            {
                "id": user.id,
                "username": user.username,
                "full_name": user.full_name,
                "phone": user.phone,
                "email": user.email,
            }
        )

    @app.patch("/api/patient/profile")
    @role_required(UserRole.PATIENT)
    def patient_update_profile():
        user = current_user()
        data = request.get_json(force=True)
        user.full_name = (data.get("full_name") or user.full_name) or None
        user.phone = (data.get("phone") or user.phone) or None
        if "email" in data:
            normalized = _normalize_email(data.get("email"))
            if normalized is None:
                user.email = None
            else:
                if not _is_valid_email(normalized):
                    return jsonify({"error": "invalid_email"}), 400
                existing = (
                    User.query.filter(db.func.lower(User.email) == normalized, User.id != user.id)
                    .order_by(User.id.asc())
                    .first()
                )
                if existing is not None:
                    return jsonify({"error": "email_taken"}), 409
                user.email = normalized
        db.session.commit()
        return jsonify({"ok": True})

    @app.post("/api/patient/appointments")
    @role_required(UserRole.PATIENT)
    def patient_book_appointment():
        user = current_user()
        patient = user.patient_profile
        data = request.get_json(force=True)
        doctor_id = int(data.get("doctor_id"))
        appt_date = date.fromisoformat(data.get("date"))
        appt_time = dtime.fromisoformat(data.get("time"))

        doctor = DoctorProfile.query.get_or_404(doctor_id)
        if not doctor.user.is_active:
            return jsonify({"error": "doctor_inactive"}), 400

        # Prevent conflicts for same doctor date/time (DB unique constraint is final guard)
        lock_key = f"lock:appt:{doctor_id}:{appt_date.isoformat()}:{appt_time.strftime('%H:%M')}"
        with cache.lock(lock_key, ttl_seconds=5):

            # Prevent same patient booking same doctor on the same day
            existing_patient_booking = Appointment.query.filter_by(
                doctor_id=doctor_id,
                patient_id=patient.id,
                appointment_date=appt_date
            ).first()

            if existing_patient_booking and existing_patient_booking.status != AppointmentStatus.CANCELLED.value:
                return jsonify({"error": "already_booked_same_day"}), 409


            # Prevent same doctor slot conflict
            existing = Appointment.query.filter_by(
                doctor_id=doctor_id,
                appointment_date=appt_date,
                appointment_time=appt_time
            ).first()

            if existing and existing.status != AppointmentStatus.CANCELLED.value:
                return jsonify({"error": "slot_taken"}), 409


            appt = Appointment(
                doctor_id=doctor_id,
                patient_id=patient.id,
                appointment_date=appt_date,
                appointment_time=appt_time,
                status=AppointmentStatus.BOOKED.value,
            )

            db.session.add(appt)
            db.session.commit()

        return jsonify({"ok": True, "appointment": _serialize_appointment(appt)})

    @app.get("/api/patient/appointments")
    @role_required(UserRole.PATIENT)
    def patient_list_appointments():
        user = current_user()
        patient = user.patient_profile
        appts = (
            Appointment.query.filter_by(patient_id=patient.id)
            .order_by(Appointment.appointment_date.desc(), Appointment.appointment_time.desc())
            .all()
        )
        return jsonify({"appointments": [_serialize_appointment(a) for a in appts]})

    @app.post("/api/patient/appointments/<int:appointment_id>/cancel")
    @role_required(UserRole.PATIENT)
    def patient_cancel_appointment(appointment_id: int):
        user = current_user()
        patient = user.patient_profile
        appt = Appointment.query.get_or_404(appointment_id)
        if appt.patient_id != patient.id:
            return jsonify({"error": "forbidden"}), 403
        if appt.status == AppointmentStatus.COMPLETED.value:
            return jsonify({"error": "cannot_cancel_completed"}), 400
        appt.status = AppointmentStatus.CANCELLED.value
        db.session.commit()
        return jsonify({"ok": True})

    @app.post("/api/patient/exports/treatments")
    @role_required(UserRole.PATIENT)
    def patient_export_treatments_csv():
        user = current_user()
        celery_client = _celery_client(app)
        task = celery_client.send_task("backend.tasks.export_patient_treatments_csv", args=[user.id])
        return jsonify({"ok": True, "task_id": task.id})

    @app.get("/api/patient/exports/treatments/<task_id>/download")
    @role_required(UserRole.PATIENT)
    def patient_download_treatments_csv(task_id: str):
        user = current_user()
        celery_client = _celery_client(app)
        from celery.result import AsyncResult

        r = AsyncResult(task_id, app=celery_client)
        if r.state != "SUCCESS":
            return jsonify({"error": "not_ready", "state": r.state}), 409
        payload = r.result or {}
        if not payload.get("ok") or payload.get("kind") != "patient_treatments_csv":
            return jsonify({"error": "invalid_result"}), 400
        if int(payload.get("patient_user_id") or 0) != int(user.id):
            return jsonify({"error": "forbidden"}), 403
        csv_content = payload.get("csv") or ""
        filename = f"treatments_{payload.get('patient_username') or user.username}_{date.today().isoformat()}.csv"
        resp = make_response(csv_content)
        resp.headers["Content-Type"] = "text/csv; charset=utf-8"
        resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
        return resp

    @app.get("/api/tasks/<task_id>")
    @login_required
    def task_status(task_id: str):
        celery_client = _celery_client(app)
        from celery.result import AsyncResult

        r = AsyncResult(task_id, app=celery_client)
        out = {"task_id": task_id, "state": r.state}
        if r.state == "SUCCESS":
            payload = r.result or {}
            if isinstance(payload, dict):
                out["result"] = {
                    k: v
                    for k, v in payload.items()
                    if k not in {"csv"}  # keep status light; csv is downloaded separately
                }
        elif r.state == "FAILURE":
            out["error"] = str(r.result)
        return jsonify(out)

    # ---------- Doctor ----------
    @app.get("/api/doctor/appointments")
    @role_required(UserRole.DOCTOR)
    def doctor_appointments():
        user = current_user()
        doc = user.doctor_profile
        start = request.args.get("start")
        end = request.args.get("end")
        q = Appointment.query.filter_by(doctor_id=doc.id)
        if start:
            q = q.filter(Appointment.appointment_date >= date.fromisoformat(start))
        if end:
            q = q.filter(Appointment.appointment_date <= date.fromisoformat(end))
        appts = q.order_by(Appointment.appointment_date.asc(), Appointment.appointment_time.asc()).all()
        return jsonify({"appointments": [_serialize_appointment(a) for a in appts]})

    @app.post("/api/doctor/appointments/<int:appointment_id>/complete")
    @role_required(UserRole.DOCTOR)
    def doctor_complete_appointment(appointment_id: int):
        user = current_user()
        doc = user.doctor_profile
        appt = Appointment.query.get_or_404(appointment_id)
        if appt.doctor_id != doc.id:
            return jsonify({"error": "forbidden"}), 403
        data = request.get_json(force=True)
        appt.status = AppointmentStatus.COMPLETED.value
        if appt.treatment is None:
            appt.treatment = Treatment()
        appt.treatment.diagnosis = (data.get("diagnosis") or "").strip() or None
        appt.treatment.prescription = (data.get("prescription") or "").strip() or None
        appt.treatment.notes = (data.get("notes") or "").strip() or None
        appt.treatment.next_visit_suggested = (data.get("next_visit_suggested") or "").strip() or None
        db.session.commit()
        return jsonify({"ok": True})

    @app.post("/api/doctor/appointments/<int:appointment_id>/cancel")
    @role_required(UserRole.DOCTOR)
    def doctor_cancel_appointment(appointment_id: int):
        user = current_user()
        doc = user.doctor_profile
        appt = Appointment.query.get_or_404(appointment_id)
        if appt.doctor_id != doc.id:
            return jsonify({"error": "forbidden"}), 403
        if appt.status == AppointmentStatus.COMPLETED.value:
            return jsonify({"error": "cannot_cancel_completed"}), 400
        appt.status = AppointmentStatus.CANCELLED.value
        db.session.commit()
        return jsonify({"ok": True})

    @app.post("/api/doctor/availability")
    @role_required(UserRole.DOCTOR)
    def doctor_set_availability():
        user = current_user()
        doc = user.doctor_profile
        data = request.get_json(force=True)
        slots = data.get("slots") or []
        # slots: [{day:"YYYY-MM-DD", start_time:"HH:MM", end_time:"HH:MM", is_available:true}]
        created = 0
        for s in slots:
            day = date.fromisoformat(s["day"])
            st = dtime.fromisoformat(s["start_time"])
            et = dtime.fromisoformat(s["end_time"])
            is_available = bool(s.get("is_available", True))
            existing = DoctorAvailability.query.filter_by(
                doctor_id=doc.id, day=day, start_time=st, end_time=et
            ).first()
            if existing:
                existing.is_available = is_available
            else:
                db.session.add(
                    DoctorAvailability(
                        doctor_id=doc.id, day=day, start_time=st, end_time=et, is_available=is_available
                    )
                )
                created += 1
        db.session.commit()
        _invalidate_catalog_cache(app)
        return jsonify({"ok": True, "created": created})

    @app.get("/api/doctor/patients/<int:patient_profile_id>/history")
    @role_required(UserRole.DOCTOR)
    def doctor_patient_history(patient_profile_id: int):
        user = current_user()
        doc = user.doctor_profile
        appts = (
            Appointment.query.filter_by(doctor_id=doc.id, patient_id=patient_profile_id)
            .order_by(Appointment.appointment_date.desc(), Appointment.appointment_time.desc())
            .all()
        )
        return jsonify({"appointments": [_serialize_appointment(a) for a in appts]})

    return app


def _serialize_appointment(a: Appointment) -> dict:
    doctor = DoctorProfile.query.get(a.doctor_id)
    patient = PatientProfile.query.get(a.patient_id)
    doctor_user = doctor.user if doctor else None
    patient_user = patient.user if patient else None
    return {
        "id": a.id,
        "doctor_id": a.doctor_id,
        "doctor_name": (doctor_user.full_name if doctor_user else None) or (doctor_user.username if doctor_user else None),
        "patient_id": a.patient_id,
        "patient_name": (patient_user.full_name if patient_user else None) or (patient_user.username if patient_user else None),
        "date": a.appointment_date.isoformat(),
        "time": a.appointment_time.strftime("%H:%M"),
        "status": a.status,
        "treatment": None
        if not a.treatment
        else {
            "diagnosis": a.treatment.diagnosis,
            "prescription": a.treatment.prescription,
            "notes": a.treatment.notes,
            "next_visit_suggested": a.treatment.next_visit_suggested,
        },
    }


def _ensure_schema_upgrades() -> None:
    """
    Minimal, in-place schema upgrades for SQLite setups where we rely on create_all().
    Safe to run repeatedly.
    """
    try:
        cols = [r[1] for r in db.session.execute(text("PRAGMA table_info(treatments)")).fetchall()]
        if "next_visit_suggested" not in cols:
            db.session.execute(text("ALTER TABLE treatments ADD COLUMN next_visit_suggested VARCHAR(120)"))
            db.session.commit()
    except Exception:
        db.session.rollback()


def _ensure_admin(app: Flask) -> None:
    username = app.config["ADMIN_USERNAME"]
    password = app.config["ADMIN_PASSWORD"]
    existing = User.query.filter_by(role=UserRole.ADMIN.value).first()
    if existing:
        return
    admin = User(username=username, role=UserRole.ADMIN.value, full_name="Admin", is_active=True)
    admin.set_password(password)
    db.session.add(admin)
    db.session.commit()


def _seed_departments() -> None:
    if Department.query.count() > 0:
        return
    for name, desc in [
        ("General Medicine", "Primary care and common conditions."),
        ("Cardiology", "Heart and blood vessel care."),
        ("Dermatology", "Skin, hair, and nail care."),
        ("Orthopedics", "Bones, joints, and musculoskeletal system."),
        ("Pediatrics", "Child healthcare."),
    ]:
        db.session.add(Department(name=name, description=desc))
    db.session.commit()


def _invalidate_catalog_cache(app: Flask) -> None:
    # Simple approach for now: bump version by deleting known keys.
    cache: RedisCache = app.extensions["cache"]
    cache.delete("catalog:departments:v1")
    # doctor listing cache keys are parameterized; leave to TTL for simplicity.


def _celery_client(app: Flask):
    from celery import Celery

    return Celery("backend-client", broker=app.config["REDIS_URL"], backend=app.config["REDIS_URL"])

