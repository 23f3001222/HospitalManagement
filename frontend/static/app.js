const { createApp, ref, computed, onMounted, onBeforeUnmount } = Vue;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function formatRole(role) {
  if (!role) return "";
  return role[0].toUpperCase() + role.slice(1);
}

createApp({
  setup() {
    const me = ref(null);
    const view = ref("login"); // login | admin | doctor | patient
    const error = ref("");

    const loginForm = ref({ username: "", password: "" });
    const registerForm = ref({ username: "", password: "", full_name: "", email: "" });

    const adminStats = ref(null);
    const adminDoctors = ref([]);
    const adminDoctorQ = ref("");
    const adminNewDoctor = ref({
      username: "",
      password: "doctor123",
      full_name: "",
      email: "",
      specialization: "",
      department_id: "",
    });
    const adminPatients = ref([]);
    const adminPatientQ = ref("");
    const adminAppointments = ref([]);
    const adminEditDoctor = ref({
      id: null,
      user_id: null,
      full_name: "",
      specialization: "",
      department_id: "",
      phone: "",
      email: "",
    });
    const adminEditPatient = ref({
      id: null,
      user_id: null,
      full_name: "",
      phone: "",
      email: "",
    });

    const departments = ref([]);
    const catalogDoctors = ref([]);
    const catalogDeptId = ref("");
    const catalogQ = ref("");

    const patientAppointments = ref([]);
    const bookForm = ref({ doctor_id: "", date: "", time: "" });
    const exportTaskId = ref("");
    const exportState = ref("");
    const exportReady = ref(false);
    let exportPollTimer = null;

    const doctorAppointments = ref([]);
    const doctorFilterRange = ref("today"); // today | week | all
    const completeForm = ref({
      appointment_id: null,
      diagnosis: "",
      prescription: "",
      next_visit_suggested: "",
      notes: "",
    });
    const availForm = ref({ day: "", start_time: "", end_time: "" });
    const doctorSelectedPatient = ref(null);
    const doctorPatientHistory = ref([]);

    async function refreshMe() {
      const r = await api("/api/auth/me");
      me.value = r.user;
      if (!me.value) view.value = "login";
      else if (me.value.role === "admin") view.value = "admin";
      else if (me.value.role === "doctor") view.value = "doctor";
      else view.value = "patient";
    }

    async function doLogin() {
      error.value = "";
      await api("/api/auth/login", { method: "POST", body: loginForm.value });
      await refreshMe();
      await loadRoleData();
    }

    async function doRegister() {
      error.value = "";
      await api("/api/auth/register", { method: "POST", body: registerForm.value });
      loginForm.value.username = registerForm.value.username;
      loginForm.value.password = registerForm.value.password;
      await doLogin();
    }

    async function doLogout() {
      await api("/api/auth/logout", { method: "POST" });
      me.value = null;
      view.value = "login";
    }

    async function loadAdmin() {
      adminStats.value = await api("/api/admin/stats");
      await Promise.all([loadAdminDoctors(), loadAdminPatients(), loadAdminAppointments()]);
      departments.value = (await api("/api/catalog/departments")).departments;
    }

    async function loadAdminDoctors() {
      const r = await api(`/api/admin/doctors?q=${encodeURIComponent(adminDoctorQ.value)}`);
      adminDoctors.value = r.doctors;
    }

    async function loadAdminPatients() {
      const r = await api(`/api/admin/patients?q=${encodeURIComponent(adminPatientQ.value)}`);
      adminPatients.value = r.patients;
    }

    async function loadAdminAppointments() {
      const r = await api("/api/admin/appointments");
      adminAppointments.value = r.appointments;
    }

    async function adminCreateDoctor() {
      error.value = "";
      await api("/api/admin/doctors", { method: "POST", body: adminNewDoctor.value });
      adminNewDoctor.value.username = "";
      adminNewDoctor.value.full_name = "";
      adminNewDoctor.value.email = "";
      adminNewDoctor.value.specialization = "";
      await loadAdminDoctors();
    }

    function startEditDoctor(d) {
      adminEditDoctor.value = {
        id: d.id,
        user_id: d.user_id,
        full_name: d.name || "",
        specialization: d.specialization || "",
        department_id: d.department_id ? String(d.department_id) : "",
        phone: d.phone || "",
        email: d.email || "",
      };
    }

    async function saveEditDoctor() {
      error.value = "";
      const d = adminEditDoctor.value;
      if (!d.id) return;
      await api(`/api/admin/doctors/${d.id}`, {
        method: "PATCH",
        body: {
          full_name: d.full_name,
          specialization: d.specialization,
          department_id: d.department_id ? Number(d.department_id) : null,
          phone: d.phone,
          email: d.email,
        },
      });
      adminEditDoctor.value = { id: null, user_id: null, full_name: "", specialization: "", department_id: "", phone: "", email: "" };
      await loadAdminDoctors();
    }

    function startEditPatient(p) {
      adminEditPatient.value = {
        id: p.id,
        user_id: p.user_id,
        full_name: p.name || "",
        phone: p.phone || "",
        email: p.email || "",
      };
    }

    async function saveEditPatient() {
      error.value = "";
      const p = adminEditPatient.value;
      if (!p.id) return;
      await api(`/api/admin/patients/${p.id}`, {
        method: "PATCH",
        body: {
          full_name: p.full_name,
          phone: p.phone,
          email: p.email,
        },
      });
      adminEditPatient.value = { id: null, user_id: null, full_name: "", phone: "", email: "" };
      await loadAdminPatients();
    }

    async function setUserStatus(userId, isActive) {
      await api(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        body: { is_active: isActive },
      });
      await Promise.all([loadAdminDoctors(), loadAdminPatients()]);
    }

    async function resetUserPassword(userId) {
      const newPassword = prompt("Enter new password (leave blank for welcome123):") || "welcome123";
      await api(`/api/admin/users/${userId}/reset_password`, {
        method: "POST",
        body: { new_password: newPassword },
      });
      alert("Password reset successfully.");
    }

    async function loadPatient() {
      departments.value = (await api("/api/catalog/departments")).departments;
      await searchDoctors();
      patientAppointments.value = (await api("/api/patient/appointments")).appointments;
    }

    async function searchDoctors() {
      const qs = new URLSearchParams();
      if (catalogDeptId.value) qs.set("department_id", catalogDeptId.value);
      if (catalogQ.value) qs.set("q", catalogQ.value);
      catalogDoctors.value = (await api(`/api/catalog/doctors?${qs.toString()}`)).doctors;
    }

    async function book() {
      error.value = "";
      const payload = {
        doctor_id: Number(bookForm.value.doctor_id),
        date: bookForm.value.date,
        time: bookForm.value.time,
      };
      await api("/api/patient/appointments", { method: "POST", body: payload });
      bookForm.value = { doctor_id: "", date: "", time: "" };
      await loadPatient();
    }

    async function cancelAppt(id) {
      await api(`/api/patient/appointments/${id}/cancel`, { method: "POST" });
      await loadPatient();
    }

    async function exportTreatmentsCsv() {
      error.value = "";
      const r = await api("/api/patient/exports/treatments", { method: "POST" });
      exportTaskId.value = r.task_id;
      exportReady.value = false;
      exportState.value = "PENDING";

      if (exportPollTimer) clearInterval(exportPollTimer);
      exportPollTimer = setInterval(async () => {
        try {
          const s = await api(`/api/tasks/${encodeURIComponent(exportTaskId.value)}`);
          exportState.value = s.state;
          if (s.state === "SUCCESS") {
            exportReady.value = true;
            clearInterval(exportPollTimer);
            exportPollTimer = null;
            alert("Your CSV export is ready to download.");
          } else if (s.state === "FAILURE") {
            clearInterval(exportPollTimer);
            exportPollTimer = null;
            error.value = s.error || "Export failed.";
          }
        } catch (e) {
          // keep polling; transient issues are ok
        }
      }, 1200);
    }

    function downloadTreatmentsCsv() {
      if (!exportTaskId.value) return;
      window.location.href = `/api/patient/exports/treatments/${encodeURIComponent(exportTaskId.value)}/download`;
    }

    async function loadPatientHistoryForDoctor(p) {
      error.value = "";
      doctorSelectedPatient.value = p;
      const r = await api(`/api/doctor/patients/${p.id}/history`);
      doctorPatientHistory.value = r.appointments || [];
    }

    async function loadDoctor() {
      await loadDoctorWithRange(doctorFilterRange.value);
    }

    async function loadDoctorWithRange(range) {
      doctorFilterRange.value = range;
      const today = new Date().toISOString().slice(0, 10);
      let qs = new URLSearchParams();
      if (range === "today") {
        qs.set("start", today);
        qs.set("end", today);
      } else if (range === "week") {
        const dt = new Date();
        const end = new Date(dt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        qs.set("start", today);
        qs.set("end", end);
      } else {
        qs.set("start", today);
      }
      doctorAppointments.value = (await api(`/api/doctor/appointments?${qs.toString()}`)).appointments;
    }

    async function completeAppt(appt) {
      error.value = "";
      await api(`/api/doctor/appointments/${appt.id}/complete`, {
        method: "POST",
        body: {
          diagnosis: completeForm.value.diagnosis,
          prescription: completeForm.value.prescription,
          next_visit_suggested: completeForm.value.next_visit_suggested,
          notes: completeForm.value.notes,
        },
      });
      completeForm.value = {
        appointment_id: null,
        diagnosis: "",
        prescription: "",
        next_visit_suggested: "",
        notes: "",
      };
      await loadDoctor();
    }

    async function cancelDoctorAppt(appt) {
      error.value = "";
      await api(`/api/doctor/appointments/${appt.id}/cancel`, { method: "POST" });
      await loadDoctor();
    }

    async function saveAvailability() {
      error.value = "";
      const slot = {
        day: availForm.value.day,
        start_time: availForm.value.start_time,
        end_time: availForm.value.end_time,
        is_available: true,
      };
      if (!slot.day || !slot.start_time || !slot.end_time) {
        error.value = "Please enter day, start time, and end time for availability.";
        return;
      }
      await api("/api/doctor/availability", {
        method: "POST",
        body: { slots: [slot] },
      });
      availForm.value = { day: "", start_time: "", end_time: "" };
      alert("Availability saved for this slot.");
    }

    const doctorPatients = computed(() => {
      const map = new Map();
      for (const a of doctorAppointments.value) {
        if (!a.patient_id) continue;
        if (!map.has(a.patient_id)) {
          map.set(a.patient_id, { id: a.patient_id, name: a.patient_name });
        }
      }
      return Array.from(map.values());
    });

    const patientTreatmentHistory = computed(() => {
      return (patientAppointments.value || [])
        .filter((a) => a.status === "Completed")
        .map((a) => ({
          id: a.id,
          date: a.date,
          time: a.time,
          doctor_name: a.doctor_name,
          diagnosis: a.treatment?.diagnosis || "",
          treatment_given: a.treatment?.prescription || "",
          next_visit_suggested: a.treatment?.next_visit_suggested || "",
          notes: a.treatment?.notes || "",
        }));
    });

    async function loadRoleData() {
      if (!me.value) return;
      if (me.value.role === "admin") await loadAdmin();
      else if (me.value.role === "patient") await loadPatient();
      else if (me.value.role === "doctor") await loadDoctor();
    }

    onMounted(async () => {
      try {
        await refreshMe();
        await loadRoleData();
      } catch (e) {
        error.value = e.message || String(e);
      }
    });

    onBeforeUnmount(() => {
      if (exportPollTimer) clearInterval(exportPollTimer);
    });

    return {
      me,
      view,
      error,
      loginForm,
      registerForm,
      adminStats,
      adminDoctors,
      adminDoctorQ,
      adminNewDoctor,
      departments,
      catalogDoctors,
      catalogDeptId,
      catalogQ,
      patientAppointments,
      bookForm,
      doctorAppointments,
      completeForm,
      doLogin,
      doRegister,
      doLogout,
      loadAdmin,
      adminCreateDoctor,
      loadPatient,
      searchDoctors,
      book,
      cancelAppt,
      exportTreatmentsCsv,
      exportTaskId,
      exportState,
      exportReady,
      downloadTreatmentsCsv,
      loadDoctor,
      completeAppt,
      formatRole,
      doctorFilterRange,
      availForm,
      saveAvailability,
      doctorPatients,
      cancelDoctorAppt,
      loadDoctorWithRange,
      adminPatients,
      adminPatientQ,
      adminAppointments,
      adminEditDoctor,
      adminEditPatient,
      loadAdminDoctors,
      loadAdminPatients,
      loadAdminAppointments,
      startEditDoctor,
      saveEditDoctor,
      startEditPatient,
      saveEditPatient,
      setUserStatus,
      resetUserPassword,
      patientTreatmentHistory,
      doctorSelectedPatient,
      doctorPatientHistory,
      loadPatientHistoryForDoctor,
    };
  },
  template: `
  <div class="container py-4">
    <div class="d-flex justify-content-between align-items-center mb-3">
      <div>
        <div class="h4 mb-0">Hospital Management System</div>
        <div class="text-muted small" v-if="me">Logged in as <strong>{{me.username}}</strong> ({{formatRole(me.role)}})</div>
        <div class="text-muted small" v-else>Login or register to continue</div>
      </div>
      <button v-if="me" class="btn btn-outline-secondary" @click="doLogout">Logout</button>
    </div>

    <div v-if="error" class="alert alert-danger">{{error}}</div>

    <div v-if="view==='login'" class="row g-3">
      <div class="col-12 col-lg-6">
        <div class="card shadow-sm">
          <div class="card-body">
            <div class="h5">Login</div>
            <div class="mb-2">
              <label class="form-label">Username</label>
              <input class="form-control" v-model="loginForm.username" />
            </div>
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" class="form-control" v-model="loginForm.password" />
            </div>
            <button class="btn btn-primary" @click="doLogin">Login</button>
            <div class="small text-muted mt-2">Admin default: admin / admin123</div>
          </div>
        </div>
      </div>
      <div class="col-12 col-lg-6">
        <div class="card shadow-sm">
          <div class="card-body">
            <div class="h5">Patient Registration</div>
            <div class="mb-2">
              <label class="form-label">Full name</label>
              <input class="form-control" v-model="registerForm.full_name" />
            </div>
            <div class="mb-2">
              <label class="form-label">Email</label>
              <input type="email" class="form-control" v-model="registerForm.email" />
            </div>
            <div class="mb-2">
              <label class="form-label">Username</label>
              <input class="form-control" v-model="registerForm.username" />
            </div>
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" class="form-control" v-model="registerForm.password" />
            </div>
            <button class="btn btn-success" @click="doRegister">Register & Login</button>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="view==='admin'">
      <div class="row g-3">
        <div class="col-12 col-lg-4">
          <div class="card shadow-sm">
            <div class="card-body">
              <div class="h5">Admin Dashboard</div>
              <div v-if="adminStats">
                <div>Total Doctors: <strong>{{adminStats.doctors}}</strong></div>
                <div>Total Patients: <strong>{{adminStats.patients}}</strong></div>
                <div>Total Appointments: <strong>{{adminStats.appointments}}</strong></div>
              </div>
              <button class="btn btn-outline-primary mt-3" @click="loadAdmin">Refresh</button>
            </div>
          </div>
        </div>

        <div class="col-12 col-lg-8">
          <div class="card shadow-sm">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center">
                <div class="h5 mb-0">Doctors</div>
                <div class="d-flex gap-2">
                  <input class="form-control" style="max-width: 240px" placeholder="Search..." v-model="adminDoctorQ" />
                  <button class="btn btn-outline-secondary" @click="loadAdminDoctors">Search</button>
                </div>
              </div>
              <div class="table-responsive mt-3">
                <table class="table table-sm align-middle">
                  <thead><tr><th>Name</th><th>Username</th><th>Department</th><th>Specialization</th><th>Phone</th><th>Email</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="d in adminDoctors" :key="d.id">
                      <td>{{d.name}}</td>
                      <td>{{d.username}}</td>
                      <td>{{d.department}}</td>
                      <td>{{d.specialization}}</td>
                      <td class="small">{{d.phone || '-'}}</td>
                      <td class="small">{{d.email || '-'}}</td>
                      <td><span class="badge" :class="d.is_active?'text-bg-success':'text-bg-secondary'">{{d.is_active?'Active':'Blacklisted'}}</span></td>
                      <td class="text-nowrap">
                        <button class="btn btn-sm btn-outline-primary me-1" @click="startEditDoctor(d)">Edit</button>
                        <button class="btn btn-sm" :class="d.is_active ? 'btn-outline-danger' : 'btn-outline-success'" @click="setUserStatus(d.user_id, !d.is_active)">
                          {{ d.is_active ? 'Blacklist' : 'Activate' }}
                        </button>
                        <button class="btn btn-sm btn-outline-warning ms-1" @click="resetUserPassword(d.user_id)">Reset PW</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <hr />
              <div class="h6">Add Doctor</div>
              <div class="row g-2">
                <div class="col-12 col-md-4"><input class="form-control" placeholder="Full name" v-model="adminNewDoctor.full_name" /></div>
                <div class="col-12 col-md-4"><input class="form-control" placeholder="Username" v-model="adminNewDoctor.username" /></div>
                <div class="col-12 col-md-4"><input class="form-control" placeholder="Password" v-model="adminNewDoctor.password" /></div>
                <div class="col-12 col-md-6"><input type="email" class="form-control" placeholder="Email" v-model="adminNewDoctor.email" /></div>
                <div class="col-12 col-md-6"><input class="form-control" placeholder="Specialization" v-model="adminNewDoctor.specialization" /></div>
                <div class="col-12 col-md-6">
                  <select class="form-select" v-model="adminNewDoctor.department_id">
                    <option value="">Select department</option>
                    <option v-for="d in departments" :key="d.id" :value="String(d.id)">{{d.name}}</option>
                  </select>
                </div>
                <div class="col-12">
                  <button class="btn btn-primary" @click="adminCreateDoctor">Create Doctor</button>
                </div>
              </div>

              <hr />
              <div v-if="adminEditDoctor.id" class="mt-3">
                <div class="h6">Edit Doctor #{{adminEditDoctor.id}}</div>
                <div class="row g-2">
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Full name" v-model="adminEditDoctor.full_name" /></div>
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Specialization" v-model="adminEditDoctor.specialization" /></div>
                  <div class="col-12 col-md-4">
                    <select class="form-select" v-model="adminEditDoctor.department_id">
                      <option value="">Department</option>
                      <option v-for="d in departments" :key="d.id" :value="String(d.id)">{{d.name}}</option>
                    </select>
                  </div>
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Phone" v-model="adminEditDoctor.phone" /></div>
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Email" v-model="adminEditDoctor.email" /></div>
                  <div class="col-12">
                    <button class="btn btn-success" @click="saveEditDoctor">Save</button>
                    <button class="btn btn-outline-secondary ms-2" @click="adminEditDoctor={id:null,user_id:null,full_name:'',specialization:'',department_id:'',phone:'',email:''}">Cancel</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="col-12">
          <div class="card shadow-sm">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <div class="h5 mb-0">Patients</div>
                <div class="d-flex gap-2">
                  <input class="form-control" style="max-width: 240px" placeholder="Search name/phone/email" v-model="adminPatientQ" />
                  <button class="btn btn-outline-secondary" @click="loadAdminPatients">Search</button>
                </div>
              </div>
              <div class="table-responsive">
                <table class="table table-sm align-middle">
                  <thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Email</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="p in adminPatients" :key="p.id">
                      <td>{{p.name}}</td>
                      <td>{{p.username}}</td>
                      <td class="small">{{p.phone || '-'}}</td>
                      <td class="small">{{p.email || '-'}}</td>
                      <td><span class="badge" :class="p.is_active?'text-bg-success':'text-bg-secondary'">{{p.is_active?'Active':'Blacklisted'}}</span></td>
                      <td class="text-nowrap">
                        <button class="btn btn-sm btn-outline-primary me-1" @click="startEditPatient(p)">Edit</button>
                        <button class="btn btn-sm" :class="p.is_active ? 'btn-outline-danger' : 'btn-outline-success'" @click="setUserStatus(p.user_id, !p.is_active)">
                          {{ p.is_active ? 'Blacklist' : 'Activate' }}
                        </button>
                        <button class="btn btn-sm btn-outline-warning ms-1" @click="resetUserPassword(p.user_id)">Reset PW</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div v-if="adminEditPatient.id" class="mt-3 border-top pt-3">
                <div class="h6">Edit Patient #{{adminEditPatient.id}}</div>
                <div class="row g-2">
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Full name" v-model="adminEditPatient.full_name" /></div>
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Phone" v-model="adminEditPatient.phone" /></div>
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Email" v-model="adminEditPatient.email" /></div>
                  <div class="col-12">
                    <button class="btn btn-success" @click="saveEditPatient">Save</button>
                    <button class="btn btn-outline-secondary ms-2" @click="adminEditPatient={id:null,user_id:null,full_name:'',phone:'',email:''}">Cancel</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="col-12">
          <div class="card shadow-sm">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <div class="h5 mb-0">All Appointments</div>
                <button class="btn btn-outline-secondary" @click="loadAdminAppointments">Refresh</button>
              </div>
              <div class="table-responsive">
                <table class="table table-sm align-middle">
                  <thead><tr><th>Date</th><th>Time</th><th>Doctor</th><th>Patient</th><th>Status</th></tr></thead>
                  <tbody>
                    <tr v-for="a in adminAppointments" :key="a.id">
                      <td>{{a.date}}</td>
                      <td>{{a.time}}</td>
                      <td>{{a.doctor_name}}</td>
                      <td>{{a.patient_name}}</td>
                      <td><span class="badge" :class="a.status==='Booked'?'text-bg-primary':(a.status==='Completed'?'text-bg-success':'text-bg-secondary')">{{a.status}}</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="small text-muted">Shows recent appointments (upcoming and past).</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="view==='patient'">
      <div class="row g-3">
        <div class="col-12 col-lg-5">
          <div class="card shadow-sm">
            <div class="card-body">
              <div class="h5">Find Doctors</div>
              <div class="row g-2 mb-2">
                <div class="col-12 col-md-6">
                  <select class="form-select" v-model="catalogDeptId">
                    <option value="">All departments</option>
                    <option v-for="d in departments" :key="d.id" :value="String(d.id)">{{d.name}}</option>
                  </select>
                </div>
                <div class="col-12 col-md-6">
                  <input class="form-control" placeholder="Search name/specialization" v-model="catalogQ" />
                </div>
              </div>
              <button class="btn btn-outline-primary" @click="searchDoctors">Search</button>

              <div class="mt-3" v-if="catalogDoctors.length===0" class="text-muted">No doctors found.</div>
              <div class="list-group mt-3">
                <div v-for="d in catalogDoctors" :key="d.id" class="list-group-item">
                  <div class="d-flex justify-content-between">
                    <div>
                      <div class="fw-semibold">{{d.name}}</div>
                      <div class="small text-muted">{{d.department}} • {{d.specialization}}</div>
                    </div>
                  </div>
                  <div class="small mt-2">
                    <div class="text-muted">Availability (next 7 days):</div>
                    <div v-if="d.availabilities.length===0" class="text-muted">No slots set</div>
                    <div v-else class="d-flex flex-wrap gap-2">
                      <span v-for="a in d.availabilities" :key="a.day+a.start_time" class="badge text-bg-light border">
                        {{a.day}} {{a.start_time}}-{{a.end_time}}
                      </span>
                    </div>
                  </div>
                  <button class="btn btn-sm btn-outline-success mt-2" @click="bookForm.doctor_id=String(d.id)">Select</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="col-12 col-lg-7">
          <div class="card shadow-sm mb-3">
            <div class="card-body">
              <div class="h5">Book Appointment</div>
              <div class="row g-2">
                <div class="col-12 col-md-4">
                  <label class="form-label">Doctor ID</label>
                  <input class="form-control" v-model="bookForm.doctor_id" />
                </div>
                <div class="col-12 col-md-4">
                  <label class="form-label">Date</label>
                  <input type="date" class="form-control" v-model="bookForm.date" />
                </div>
                <div class="col-12 col-md-4">
                  <label class="form-label">Time</label>
                  <input type="time" class="form-control" v-model="bookForm.time" />
                </div>
                <div class="col-12">
                  <button class="btn btn-primary" @click="book">Book</button>
                </div>
              </div>
              <div class="small text-muted mt-2">Conflicts are prevented per doctor per date/time.</div>
            </div>
          </div>

          <div class="card shadow-sm">
            <div class="card-body">
              <div class="h5">My Appointments</div>
              <div class="table-responsive">
                <table class="table table-sm align-middle">
                  <thead><tr><th>Date</th><th>Time</th><th>Doctor</th><th>Status</th><th>Diagnosis</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="a in patientAppointments" :key="a.id">
                      <td>{{a.date}}</td>
                      <td>{{a.time}}</td>
                      <td>{{a.doctor_name}}</td>
                      <td><span class="badge" :class="a.status==='Booked'?'text-bg-primary':(a.status==='Completed'?'text-bg-success':'text-bg-secondary')">{{a.status}}</span></td>
                      <td class="small">{{a.treatment?.diagnosis || ''}}</td>
                      <td>
                        <button v-if="a.status==='Booked'" class="btn btn-sm btn-outline-danger" @click="cancelAppt(a.id)">Cancel</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <button class="btn btn-outline-secondary" @click="loadPatient">Refresh</button>
              <button class="btn btn-outline-primary ms-2" @click="exportTreatmentsCsv">Export treatments (CSV)</button>
              <div v-if="exportTaskId" class="small text-muted mt-2">
                Export job started. Task ID: <code>{{exportTaskId}}</code>
                <span class="ms-2">Status: <strong>{{exportState}}</strong></span>
                <button v-if="exportReady" class="btn btn-sm btn-success ms-2" @click="downloadTreatmentsCsv">Download CSV</button>
              </div>
            </div>
          </div>

          <div class="card shadow-sm mt-3">
            <div class="card-body">
              <div class="h5">My Treatment History</div>
              <div class="small text-muted mb-2">Shows completed appointments with diagnosis and treatment.</div>
              <div class="table-responsive">
                <table class="table table-sm align-middle">
                  <thead><tr><th>Date</th><th>Time</th><th>Doctor</th><th>Diagnosis</th><th>Treatment</th><th>Next visit</th><th>Notes</th></tr></thead>
                  <tbody>
                    <tr v-for="t in patientTreatmentHistory" :key="t.id">
                      <td>{{t.date}}</td>
                      <td>{{t.time}}</td>
                      <td>{{t.doctor_name}}</td>
                      <td class="small">{{t.diagnosis}}</td>
                      <td class="small">{{t.treatment_given}}</td>
                      <td class="small">{{t.next_visit_suggested}}</td>
                      <td class="small">{{t.notes}}</td>
                    </tr>
                    <tr v-if="patientTreatmentHistory.length===0">
                      <td colspan="7" class="text-muted small">No completed treatments yet.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="view==='doctor'">
      <div class="row g-3">
        <div class="col-12 col-lg-8">
          <div class="card shadow-sm">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center">
                <div>
                  <div class="h5 mb-0">Doctor Dashboard</div>
                  <div class="small text-muted">Upcoming appointments ({{doctorFilterRange==='today'?'today':(doctorFilterRange==='week'?'next 7 days':'all future')}})</div>
                </div>
                <div class="d-flex gap-2">
                  <div class="btn-group btn-group-sm" role="group">
                    <button type="button" class="btn" :class="doctorFilterRange==='today'?'btn-primary':'btn-outline-primary'" @click="loadDoctorWithRange('today')">Today</button>
                    <button type="button" class="btn" :class="doctorFilterRange==='week'?'btn-primary':'btn-outline-primary'" @click="loadDoctorWithRange('week')">Week</button>
                    <button type="button" class="btn" :class="doctorFilterRange==='all'?'btn-primary':'btn-outline-primary'" @click="loadDoctorWithRange('all')">All</button>
                  </div>
                  <button class="btn btn-outline-secondary btn-sm" @click="loadDoctor">Refresh</button>
                </div>
              </div>

              <div class="table-responsive mt-3">
                <table class="table table-sm align-middle">
                  <thead><tr><th>Date</th><th>Time</th><th>Patient</th><th>Status</th><th>Treatment</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="a in doctorAppointments" :key="a.id">
                      <td>{{a.date}}</td>
                      <td>{{a.time}}</td>
                      <td>{{a.patient_name}}</td>
                      <td><span class="badge" :class="a.status==='Booked'?'text-bg-primary':(a.status==='Completed'?'text-bg-success':'text-bg-secondary')">{{a.status}}</span></td>
                      <td class="small">{{a.treatment?.diagnosis || ''}}</td>
                      <td class="text-nowrap">
                        <button v-if="a.status==='Booked'" class="btn btn-sm btn-outline-success me-1" @click="completeForm.appointment_id=a.id">Complete</button>
                        <button v-if="a.status==='Booked'" class="btn btn-sm btn-outline-danger" @click="cancelDoctorAppt(a)">Cancel</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div v-if="completeForm.appointment_id" class="mt-3 border-top pt-3">
                <div class="h6">Complete Appointment #{{completeForm.appointment_id}}</div>
                <div class="row g-2">
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Diagnosis" v-model="completeForm.diagnosis" /></div>
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Prescription" v-model="completeForm.prescription" /></div>
                  <div class="col-12 col-md-4"><input class="form-control" placeholder="Next visit suggested (e.g. 2 weeks / 2026-04-01)" v-model="completeForm.next_visit_suggested" /></div>
                  <div class="col-12"><input class="form-control" placeholder="Notes" v-model="completeForm.notes" /></div>
                  <div class="col-12">
                    <button class="btn btn-success" @click="completeAppt({id: completeForm.appointment_id})">Save</button>
                    <button class="btn btn-outline-secondary ms-2" @click="completeForm={appointment_id:null,diagnosis:'',prescription:'',next_visit_suggested:'',notes:''}">Cancel</button>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>

        <div class="col-12 col-lg-4">
          <div class="card shadow-sm mb-3">
            <div class="card-body">
              <div class="h6">My Patients</div>
              <div v-if="doctorPatients.length===0" class="small text-muted">No patients assigned yet.</div>
              <ul class="list-group list-group-flush" v-else>
                <li v-for="p in doctorPatients" :key="p.id" class="list-group-item py-1 small">
                  <div class="d-flex justify-content-between align-items-center">
                    <div>{{p.name}} (ID: {{p.id}})</div>
                    <button class="btn btn-sm btn-outline-primary" @click="loadPatientHistoryForDoctor(p)">History</button>
                  </div>
                </li>
              </ul>
            </div>
          </div>

          <div class="card shadow-sm mb-3" v-if="doctorSelectedPatient">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center">
                <div class="h6 mb-0">Full History: {{doctorSelectedPatient.name}}</div>
                <button class="btn btn-sm btn-outline-secondary" @click="doctorSelectedPatient=null; doctorPatientHistory=[]">Close</button>
              </div>
              <div class="table-responsive mt-2">
                <table class="table table-sm align-middle">
                  <thead><tr><th>Date</th><th>Time</th><th>Status</th><th>Diagnosis</th><th>Treatment</th><th>Next visit</th><th>Notes</th></tr></thead>
                  <tbody>
                    <tr v-for="a in doctorPatientHistory" :key="a.id">
                      <td>{{a.date}}</td>
                      <td>{{a.time}}</td>
                      <td>{{a.status}}</td>
                      <td class="small">{{a.treatment?.diagnosis || ''}}</td>
                      <td class="small">{{a.treatment?.prescription || ''}}</td>
                      <td class="small">{{a.treatment?.next_visit_suggested || ''}}</td>
                      <td class="small">{{a.treatment?.notes || ''}}</td>
                    </tr>
                    <tr v-if="doctorPatientHistory.length===0">
                      <td colspan="7" class="text-muted small">No history found.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="card shadow-sm">
            <div class="card-body">
              <div class="h6">Set Availability (next 7 days)</div>
              <div class="small text-muted mb-2">Choose a date and time window when you are available. You can add multiple slots.</div>
              <div class="mb-2">
                <label class="form-label mb-1">Day</label>
                <input type="date" class="form-control form-control-sm" v-model="availForm.day" />
              </div>
              <div class="row g-2 mb-2">
                <div class="col-6">
                  <label class="form-label mb-1">Start</label>
                  <input type="time" class="form-control form-control-sm" v-model="availForm.start_time" />
                </div>
                <div class="col-6">
                  <label class="form-label mb-1">End</label>
                  <input type="time" class="form-control form-control-sm" v-model="availForm.end_time" />
                </div>
              </div>
              <button class="btn btn-sm btn-primary" @click="saveAvailability">Add Slot</button>
              <div class="small text-muted mt-2">Patients will see these slots in the next 7 days view.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

  </div>
  `,
}).mount("#app");

