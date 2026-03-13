import { auth, db } from './firebase-config.js';
import {
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

const page = document.body.dataset.page;
const collections = {
  users: 'users',
  rooms: 'rooms',
  tenantAssignments: 'tenantAssignments',
  bills: 'bills',
  payments: 'payments',
  visitorLogs: 'visitorLogs'
};

const defaultRooms = [
  { roomNumber: 'A10', capacity: 4, monthlyRent: 4000, status: 'Available' },
  { roomNumber: 'A11', capacity: 2, monthlyRent: 4000, status: 'Available' },
  { roomNumber: 'B20', capacity: 4, monthlyRent: 4000, status: 'Available' },
  { roomNumber: 'B21', capacity: 2, monthlyRent: 4000, status: 'Available' },
  { roomNumber: 'C30', capacity: 4, monthlyRent: 4000, status: 'Available' }
];

const hiddenRoomNumberKeys = new Set(['A101', 'A102', 'B201', 'B202']);

function roomNumberKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value || 0));
}

function computeUtilities(bill) {
  if (typeof bill.utilities !== 'undefined') return Number(bill.utilities || 0);
  return Number(bill.electricity || 0) + Number(bill.water || 0);
}

function sanitizeMoneyInput(raw) {
  const cleaned = String(raw || '')
    .replace(/[^\d.]/g, '')
    .replace(/(\..*)\./g, '$1');
  const [whole = '', decimal = ''] = cleaned.split('.');
  const wholeNormalized = whole.replace(/^0+(?=\d)/, '') || '0';
  const decimalTrimmed = decimal.slice(0, 2);
  return decimalTrimmed.length ? `${wholeNormalized}.${decimalTrimmed}` : wholeNormalized;
}

function formatMoneyForInput(rawNumberString) {
  if (!rawNumberString) return '';
  const numeric = Number(rawNumberString);
  if (!Number.isFinite(numeric)) return '';
  return `?${numeric.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function computeBillDueDate(month) {
  const [year, mm] = String(month || '').split('-').map(Number);
  if (!year || !mm) return '';
  const due = new Date(Date.UTC(year, mm, 7));
  return due.toISOString().slice(0, 10);
}

function normalizeBillingPeriod(monthValue, yearValue) {
  const monthRaw = String(monthValue || '').trim();
  const yearRaw = String(yearValue || '').trim();
  if (!monthRaw || !yearRaw) return '';
  if (!/^\d{4}$/.test(yearRaw)) return '';

  const monthLookup = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  };

  let monthNumber = Number.NaN;
  if (/^\d{1,2}$/.test(monthRaw)) {
    monthNumber = Number(monthRaw);
  } else {
    const key = monthRaw.slice(0, 3).toLowerCase();
    monthNumber = monthLookup[key];
  }

  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return '';
  return `${yearRaw}-${String(monthNumber).padStart(2, '0')}`;
}

function badge(status) {
  const value = String(status || '').trim().toLowerCase();
  let tone = 'status-default';

  if (value === 'available') tone = 'status-available';
  else if (value === 'occupied') tone = 'status-occupied';
  else if (value === 'pending approval' || value === 'pending') tone = 'status-pending-approval';
  else if (value === 'active') tone = 'status-active';
  else if (value === 'inactive') tone = 'status-inactive';
  else if (value === 'paid' || value === 'confirmed') tone = 'status-paid';
  else if (value === 'unpaid' || value === 'unused') tone = 'status-unpaid';

  return `<span class="badge ${tone}">${status}</span>`;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setMessage(text, isError = false) {
  const node = document.getElementById('auth-message');
  if (!node) return;
  node.textContent = text;
  node.className = `auth-message ${isError ? 'error' : 'success'}`;
}

function setStatus(id, text, isError = false) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  node.className = `status-banner ${isError ? 'error' : 'success'}`;
}

function showToast(text, isError = false) {
  const stack = document.getElementById('toast-stack');
  if (!stack || !text) return;
  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'error' : 'success'}`;
  toast.textContent = text;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 180);
  }, 3000);
}

async function runWithElementLock(button, loadingText, task) {
  if (!button) return task();
  if (button.dataset.loading === 'true') return;

  const originalText = button.textContent;
  const wasDisabled = button.disabled;
  button.dataset.loading = 'true';
  button.disabled = true;
  button.classList.add('is-loading');
  button.textContent = loadingText;

  try {
    return await task();
  } finally {
    button.classList.remove('is-loading');
    button.textContent = originalText;
    button.disabled = wasDisabled;
    delete button.dataset.loading;
  }
}

async function runWithButtonLock(form, buttonText, task) {
  const button = form?.querySelector('button[type="submit"]');
  return runWithElementLock(button, buttonText, task);
}
function tenantName(users, id) {
  const tenant = users.find((entry) => entry.id === id);
  if (!tenant) return 'Unknown tenant';
  return tenant.name || tenant.email || 'Unnamed tenant';
}

function roomLabel(rooms, id) {
  return rooms.find((entry) => entry.id === id)?.roomNumber || 'Not assigned';
}

async function getProfile(uid) {
  const snapshot = await getDoc(doc(db, collections.users, uid));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getProfileWithRetry(uid, options = {}) {
  const attempts = Number(options.attempts || 6);
  const waitMs = Number(options.waitMs || 350);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const profile = await getProfile(uid);
    if (profile) return profile;
    if (attempt < attempts - 1) {
      await delay(waitMs);
    }
  }

  return null;
}

async function ensureDefaultRooms() {
  const roomsSnapshot = await getDocs(collection(db, collections.rooms));
  if (!roomsSnapshot.empty) return;
  await Promise.all(defaultRooms.map((room) => addDoc(collection(db, collections.rooms), room)));
}

function redirectForRole(role) {
  if (role === 'admin') {
    window.location.href = 'admin.html';
    return;
  }
  window.location.href = 'tenant.html';
}

async function requireRole(expectedRole) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = 'index.html';
        return;
      }

      const profile = await getProfileWithRetry(user.uid);
      if (!profile) {
        await signOut(auth);
        window.location.href = 'index.html';
        return;
      }

      if (expectedRole && profile.role !== expectedRole) {
        redirectForRole(profile.role);
        return;
      }

      resolve({ user, profile });
    });
  });
}

function attachLogout() {
  const button = document.getElementById('logout-button');
  if (!button) return;

  let isLoggingOut = false;
  const setIsLoggingOut = (value) => {
    isLoggingOut = Boolean(value);
    button.disabled = isLoggingOut;
    button.textContent = isLoggingOut ? 'LOGGING OUT...' : 'LOG OUT';
  };

  button.addEventListener('click', async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await signOut(auth);
      window.location.href = 'index.html';
    } catch (error) {
      showToast(error?.message || 'Unable to log out right now.', true);
      setIsLoggingOut(false);
    }
  });
}

function renderStats(targetId, items) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.innerHTML = items.map((item) => `
    <article class="stat-card">
      <strong>${item.value}</strong>
      <p>${item.label}</p>
    </article>
  `).join('');
}

async function initHome() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    const profile = await getProfileWithRetry(user.uid, { attempts: 3, waitMs: 250 });
    if (profile) redirectForRole(profile.role);
  });

  const accessSection = document.getElementById('access');
  const modalOverlay = document.getElementById('modal-overlay');
  const loginPanel = document.getElementById('login-panel');
  const signupPanel = document.getElementById('signup-panel');
  const heroSignInToggle = document.getElementById('hero-signin-toggle');
  const heroRegisterToggle = document.getElementById('hero-register-toggle');
  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  const forgotToggleButton = document.getElementById('forgot-password-toggle');
  const resetInlineBox = document.getElementById('reset-inline-box');
  const directResetForm = document.getElementById('direct-reset-form');

  const closeAccessModal = () => {
    if (!modalOverlay) return;
    modalOverlay.hidden = true;
    document.body.classList.remove('modal-active');
  };

  const showAccessPanel = (panel) => {
    if (!accessSection || !modalOverlay || !loginPanel || !signupPanel) return;
    accessSection.hidden = false;
    loginPanel.hidden = panel !== 'signin';
    signupPanel.hidden = panel !== 'register';
    modalOverlay.hidden = false;
    document.body.classList.add('modal-active');
  };

  heroSignInToggle?.addEventListener('click', () => {
    showAccessPanel('signin');
  });

  heroRegisterToggle?.addEventListener('click', () => {
    showAccessPanel('register');
  });

  modalOverlay?.addEventListener('click', (event) => {
    if (event.target !== modalOverlay) return;
    closeAccessModal();
  });

  loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Signing In...', async () => {
      const form = new FormData(event.currentTarget);
      try {
        const credential = await signInWithEmailAndPassword(auth, form.get('email'), form.get('password'));
        const profile = await getProfileWithRetry(credential.user.uid);
        if (!profile) throw new Error('Missing user profile in Firestore.');
        setMessage('Sign-in successful. Redirecting...');
        redirectForRole(profile.role);
      } catch (error) {
        setMessage(error.message, true);
      }
    });
  });
  signupForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Creating Account...', async () => {
      const form = new FormData(event.currentTarget);
      const role = form.get('role');

      try {
        const credential = await createUserWithEmailAndPassword(auth, form.get('email'), form.get('password'));
        await setDoc(doc(db, collections.users, credential.user.uid), {
          name: form.get('name'),
          email: form.get('email'),
          contact: form.get('contact'),
          role,
          status: role === 'admin' ? 'Active' : 'Pending Approval',
          roomId: null,
          createdAt: serverTimestamp()
        });

        const savedProfile = await getProfileWithRetry(credential.user.uid);
        if (!savedProfile) {
          throw new Error('Account was created in Authentication, but the Firestore profile was not available yet. Please try signing in again.');
        }

      if (role === 'admin') {
        await ensureDefaultRooms();
      }

      setMessage(role === 'tenant'
        ? 'Tenant account created successfully. Wait for admin assignment, then you can view room and billing details.'
        : 'Admin account created successfully. Redirecting...');
      redirectForRole(role);
    } catch (error) {
      setMessage(error.message, true);
    }
  });
  });
  forgotToggleButton?.addEventListener('click', () => {
    if (!resetInlineBox) return;
    resetInlineBox.hidden = !resetInlineBox.hidden;
  });

  directResetForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Updating...', async () => {
      const form = new FormData(event.currentTarget);
      const email = String(form.get('email') || '').trim().toLowerCase();
      const newPassword = String(form.get('newPassword') || '');
      const confirmPasswordValue = String(form.get('confirmPassword') || '');

      if (newPassword !== confirmPasswordValue) {
        setMessage('Passwords do not match.', true);
        return;
      }

      if (!auth.currentUser) {
        setMessage('Please sign in first before updating your password.', true);
        return;
      }
      if (email && String(auth.currentUser.email || '').toLowerCase() !== email) {
        setMessage('Entered email does not match the signed-in account.', true);
        return;
      }

      try {
        await updatePassword(auth.currentUser, newPassword);
        setMessage('Password updated successfully.');
        event.currentTarget.reset();
        if (resetInlineBox) resetInlineBox.hidden = true;
      } catch (error) {
        setMessage(error.message, true);
      }
    });
  });
}

function initDashboardResetPassword() {
  const openButton = document.getElementById('open-reset-password-modal');
  const modal = document.getElementById('password-reset-modal');
  const closeButton = document.getElementById('password-reset-close');
  const form = document.getElementById('password-reset-form');
  const message = document.getElementById('password-reset-message');
  if (!openButton || !modal || !closeButton || !form || !message) return;

  const showMessage = (text, isError = false) => {
    message.textContent = text;
    message.className = `auth-message ${isError ? 'error' : 'success'}`;
  };

  const openModal = () => {
    modal.hidden = false;
    showMessage('');
  };
  const closeModal = () => {
    modal.hidden = true;
    form.reset();
    showMessage('');
  };

  openButton.addEventListener('click', openModal);
  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Updating...', async () => {
      const data = new FormData(event.currentTarget);
      const newPassword = String(data.get('newPassword') || '');
      const confirmPasswordValue = String(data.get('confirmPassword') || '');

      if (newPassword !== confirmPasswordValue) {
        showMessage('Passwords do not match.', true);
        return;
      }

      if (!auth.currentUser) {
        showMessage('Please sign in first before updating your password.', true);
        return;
      }

      try {
        await updatePassword(auth.currentUser, newPassword);
        showMessage('Password updated successfully.');
        setTimeout(() => {
          closeModal();
        }, 700);
      } catch (error) {
        showMessage(error.message || 'Unable to update password.', true);
      }
    });
  });
}

async function initResetPassword() {
  const form = document.getElementById('reset-password-form');
  const message = document.getElementById('reset-message');
  const loginLink = document.getElementById('reset-login-link');
  const oobCode = new URLSearchParams(window.location.search).get('oobCode');

  if (!form || !message) return;

  const showMessage = (text, isError = false) => {
    message.textContent = text;
    message.className = `auth-message ${isError ? 'error' : 'success'}`;
  };

  if (!oobCode) {
    showMessage('Invalid or missing reset code. Please request a new password reset link.', true);
    form.querySelectorAll('input, button').forEach((node) => {
      node.disabled = true;
    });
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Updating...', async () => {
      const data = new FormData(event.currentTarget);
      const newPassword = String(data.get('newPassword') || '');
      const confirmPassword = String(data.get('confirmPassword') || '');

      if (newPassword !== confirmPassword) {
        showMessage('Passwords do not match.', true);
        return;
      }

      if (newPassword.length < 6) {
        showMessage('Password must be at least 6 characters.', true);
        return;
      }

      try {
        await confirmPasswordReset(auth, oobCode, newPassword);
        showMessage('Password updated successfully.');
        loginLink?.removeAttribute('hidden');
        form.setAttribute('hidden', 'hidden');
      } catch (error) {
        showMessage(error.message || 'Unable to update password. Please request a new reset link.', true);
      }
    });
  });
}

async function loadCollection(name, conditions = []) {
  const source = conditions.length
    ? query(collection(db, name), ...conditions)
    : collection(db, name);
  const snapshot = await getDocs(source);
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
}

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function initAdmin() {
  const { profile } = await requireRole('admin');
  attachLogout();
  initDashboardResetPassword();
  setText('admin-user-name', profile.name || profile.email || 'Administrator');
  setText('admin-user-role', `Role: ${profile.role}`);
  setStatus('admin-status', 'Connected to Firebase Auth and Cloud Firestore. Tenants must self-register from the landing page.');
  const tenantSearch = document.getElementById('tenant-search');
  const tenantPagination = document.getElementById('tenant-pagination');
  const roomPlacementModal = document.getElementById('room-placement-modal');
  const roomModalClose = document.getElementById('room-modal-close');
  const roomModalForm = document.getElementById('room-modal-form');
  const rowsPerPage = 5;
  let currentTenantPage = 1;
  let inlineEditingTenantId = '';
  let tenantSortKey = '';
  let tenantSortDirection = 'none';

  function openRoomPlacementModal(roomId, roomLabel, defaultTenantId = '') {
    if (!roomPlacementModal || !roomModalForm) return;
    roomModalForm.elements.roomId.value = roomId;
    roomModalForm.elements.roomLabel.value = `Room: ${roomLabel}`;
    if (defaultTenantId) {
      roomModalForm.elements.tenant.value = defaultTenantId;
    } else {
      roomModalForm.elements.tenant.value = '';
    }
    if (!roomModalForm.elements.startDate.value) {
      roomModalForm.elements.startDate.value = new Date().toISOString().slice(0, 10);
    }
    roomPlacementModal.hidden = false;
  }

  function closeRoomPlacementModal() {
    if (!roomPlacementModal || !roomModalForm) return;
    roomPlacementModal.hidden = true;
    roomModalForm.reset();
  }

  async function ensureRoomHasCapacity(roomId, tenantIdToIgnore = '') {
    if (!roomId) return { ok: true, room: null, occupants: [] };

    const [roomSnapshot, usersSnapshot] = await Promise.all([
      getDoc(doc(db, collections.rooms, roomId)),
      getDocs(collection(db, collections.users))
    ]);

    if (!roomSnapshot.exists()) {
      return { ok: false, message: 'Selected room was not found.' };
    }

    const room = { id: roomSnapshot.id, ...roomSnapshot.data() };
    const occupants = usersSnapshot.docs
      .map((entry) => ({ id: entry.id, ...entry.data() }))
      .filter((entry) =>
        normalizeRole(entry.role) === 'tenant' &&
        entry.isArchived !== true &&
        entry.roomId === roomId &&
        entry.id !== tenantIdToIgnore
      );

    if (occupants.length >= Number(room.capacity || 0)) {
      return {
        ok: false,
        message: `Room ${room.roomNumber} is already full (${occupants.length}/${room.capacity}).`
      };
    }

    return { ok: true, room, occupants };
  }

  async function assignTenantToRoom(tenantId, roomId, startDate) {
    if (!tenantId || !roomId || !startDate) {
      setStatus('admin-status', 'Tenant, room, and start date are required.', true);
      return false;
    }

    const tenantSnapshot = await getDoc(doc(db, collections.users, tenantId));
    const tenant = tenantSnapshot.exists() ? tenantSnapshot.data() : null;
    if (!tenant) {
      setStatus('admin-status', 'Selected tenant was not found.', true);
      return false;
    }

    if (tenant.roomId !== roomId) {
      const capacityCheck = await ensureRoomHasCapacity(roomId, tenantId);
      if (!capacityCheck.ok) {
        setStatus('admin-status', capacityCheck.message, true);
        return false;
      }
    }

    if (tenant.roomId && tenant.roomId !== roomId) {
      await updateDoc(doc(db, collections.rooms, tenant.roomId), { status: 'Available' });
    }

    await updateDoc(doc(db, collections.users, tenantId), {
      roomId,
      status: 'Active'
    });
    await updateDoc(doc(db, collections.rooms, roomId), { status: 'Occupied' });
    await addDoc(collection(db, collections.tenantAssignments), {
      userId: tenantId,
      roomId,
      startDate,
      createdAt: serverTimestamp()
    });
    return true;
  }

  await ensureDefaultRooms();

  async function refresh() {
    const [users, rooms, bills, payments, visitorLogs] = await Promise.all([
      loadCollection(collections.users),
      loadCollection(collections.rooms),
      loadCollection(collections.bills),
      loadCollection(collections.payments),
      loadCollection(collections.visitorLogs)
    ]);
    const tenants = users
      .filter((entry) => normalizeRole(entry.role) === 'tenant')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const allTenantProfiles = users
      .filter((entry) => normalizeRole(entry.role) === 'tenant')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const roomsWithOccupants = rooms.map((room) => {
      const occupants = tenants.filter((tenant) => tenant.roomId === room.id);
      const derivedStatus = occupants.length ? 'Occupied' : 'Available';
      return { ...room, occupants, derivedStatus };
    });
    const roomStatusSyncWrites = roomsWithOccupants
      .filter((room) => String(room.status || '') !== room.derivedStatus)
      .map((room) => updateDoc(doc(db, collections.rooms, room.id), { status: room.derivedStatus }));
    if (roomStatusSyncWrites.length) {
      await Promise.all(roomStatusSyncWrites);
    }
    const managedRooms = roomsWithOccupants.filter((room) => !hiddenRoomNumberKeys.has(roomNumberKey(room.roomNumber)));
    const searchTerm = String(tenantSearch?.value || '').trim().toLowerCase();
    const nonArchivedTenants = tenants.filter((tenant) => tenant.isArchived !== true);
    const activeTenants = nonArchivedTenants.filter((tenant) => String(tenant.status || '') === 'Active');
    const searchedTenants = searchTerm
      ? nonArchivedTenants.filter((tenant) =>
          String(tenant.name || '').toLowerCase().includes(searchTerm) ||
          String(tenant.email || '').toLowerCase().includes(searchTerm))
      : nonArchivedTenants;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const visibleTenants = tenantSortKey && tenantSortDirection !== 'none'
      ? [...searchedTenants].sort((a, b) => {
          const roomA = roomLabel(roomsWithOccupants, a.roomId);
          const roomB = roomLabel(roomsWithOccupants, b.roomId);
          let left = '';
          let right = '';
          if (tenantSortKey === 'name') {
            left = String(a.name || '');
            right = String(b.name || '');
          } else if (tenantSortKey === 'email') {
            left = String(a.email || '');
            right = String(b.email || '');
          } else if (tenantSortKey === 'contact') {
            left = String(a.contact || '');
            right = String(b.contact || '');
          } else if (tenantSortKey === 'room') {
            left = String(roomA || '');
            right = String(roomB || '');
          } else if (tenantSortKey === 'status') {
            left = String(a.status || '');
            right = String(b.status || '');
          }
          const result = collator.compare(left, right);
          return tenantSortDirection === 'asc' ? result : -result;
        })
      : [...searchedTenants];

    const totalTenantPages = Math.max(1, Math.ceil(visibleTenants.length / rowsPerPage));
    if (currentTenantPage > totalTenantPages) currentTenantPage = totalTenantPages;
    const startIndex = (currentTenantPage - 1) * rowsPerPage;
    const pagedTenants = visibleTenants.slice(startIndex, startIndex + rowsPerPage);

    renderStats('admin-stats', [
      { value: tenants.filter((tenant) => tenant.status === 'Active' && tenant.isArchived !== true).length, label: 'Tenants in records' },
      { value: managedRooms.filter((room) => room.derivedStatus === 'Occupied').length, label: 'Occupied rooms' },
      { value: bills.filter((bill) => bill.status === 'Unpaid').length, label: 'Unpaid bills' },
      { value: visitorLogs.length, label: 'Visitor log entries' }
    ]);
    setText('tenant-search-count', `Showing ${pagedTenants.length} of ${visibleTenants.length} tenant${visibleTenants.length === 1 ? '' : 's'}`);

    const tenantTable = document.getElementById('tenant-table');
    tenantTable.innerHTML = pagedTenants.map((tenant) => `
      <tr>
        ${inlineEditingTenantId === tenant.id
          ? `
            <td><input class="table-inline-input" data-inline-name value="${escapeHtml(tenant.name || '')}" placeholder="Name"></td>
            <td><input class="table-inline-input" data-inline-email value="${escapeHtml(tenant.email || '')}" placeholder="Email"></td>
            <td><input class="table-inline-input" data-inline-contact value="${escapeHtml(tenant.contact || '')}" placeholder="Contact"></td>
            <td>
              <select class="table-inline-select" data-inline-room>
                <option value="">Not assigned</option>
                ${managedRooms.map((room) => `<option value="${room.id}" ${tenant.roomId === room.id ? 'selected' : ''}>${room.roomNumber}</option>`).join('')}
              </select>
            </td>
            <td>
              <select class="table-inline-select" data-inline-status>
                <option value="Pending Approval" ${(tenant.status || '') === 'Pending Approval' ? 'selected' : ''}>Pending Approval</option>
                <option value="Active" ${(tenant.status || '') === 'Active' ? 'selected' : ''}>Active</option>
                <option value="Inactive" ${(tenant.status || '') === 'Inactive' ? 'selected' : ''}>Inactive</option>
              </select>
            </td>
          `
          : `
            <td>${tenant.name || 'No name'}</td>
            <td>${tenant.email || '-'}</td>
            <td>${tenant.contact || '-'}</td>
            <td>${roomLabel(roomsWithOccupants, tenant.roomId)}</td>
            <td>${badge(tenant.status || 'Pending')}</td>
          `}
        <td>
          <div class="table-actions">
            ${inlineEditingTenantId === tenant.id
              ? `
                <button class="button primary" data-save-inline-tenant="${tenant.id}" type="button">Save Tenant Changes</button>
                <button class="button muted-action" data-delete-inline-tenant="${tenant.id}" data-tenant-name="${escapeHtml(tenant.name || 'this tenant')}" type="button">Delete Tenant</button>
                <button class="button secondary" data-cancel-inline-tenant="${tenant.id}" type="button">Cancel</button>
              `
              : `
                <button class="button secondary" data-start-inline-tenant="${tenant.id}" type="button">Edit</button>
              `}
          </div>
        </td>
      </tr>
    `).join('');

    if (!visibleTenants.length) {
      tenantTable.innerHTML = `<tr><td colspan="6">${searchTerm ? 'No tenants match that search.' : 'No tenant records found.'}</td></tr>`;
    }

    if (tenantPagination) {
      if (!visibleTenants.length) {
        tenantPagination.innerHTML = '';
      } else {
        const pageButtons = Array.from({ length: totalTenantPages }, (_, index) => {
          const pageNumber = index + 1;
          return `<button class="tenant-page-button ${pageNumber === currentTenantPage ? 'is-active' : ''}" data-tenant-page="${pageNumber}" type="button">${pageNumber}</button>`;
        }).join('');

        tenantPagination.innerHTML = `
          <button class="tenant-page-button" data-tenant-page-prev type="button" ${currentTenantPage <= 1 ? 'disabled' : ''}>Prev</button>
          ${pageButtons}
          <button class="tenant-page-button" data-tenant-page-next type="button" ${currentTenantPage >= totalTenantPages ? 'disabled' : ''}>Next</button>
        `;

        tenantPagination.querySelector('[data-tenant-page-prev]')?.addEventListener('click', async () => {
          if (currentTenantPage <= 1) return;
          currentTenantPage -= 1;
          await refresh();
        });

        tenantPagination.querySelector('[data-tenant-page-next]')?.addEventListener('click', async () => {
          if (currentTenantPage >= totalTenantPages) return;
          currentTenantPage += 1;
          await refresh();
        });

        tenantPagination.querySelectorAll('[data-tenant-page]').forEach((button) => {
          button.addEventListener('click', async () => {
            const target = Number(button.dataset.tenantPage || '1');
            if (!Number.isFinite(target) || target < 1 || target > totalTenantPages || target === currentTenantPage) return;
            currentTenantPage = target;
            await refresh();
          });
        });
      }
    }

    document.querySelectorAll('[data-tenant-sort]').forEach((header) => {
      const key = header.dataset.tenantSort;
      const icon = header.querySelector('.sort-icon');
      header.classList.remove('is-active', 'is-asc', 'is-desc');
      if (icon) icon.className = 'sort-icon fi fi-sr-sort-alt';

      if (key === tenantSortKey && tenantSortDirection !== 'none') {
        header.classList.add('is-active', tenantSortDirection === 'asc' ? 'is-asc' : 'is-desc');
        if (icon) icon.className = tenantSortDirection === 'asc' ? 'sort-icon fi fi-sr-sort-amount-up-alt' : 'sort-icon fi fi-sr-sort-amount-down-alt';
      }
    });

    const roomCards = document.getElementById('room-cards');
    roomCards.innerHTML = managedRooms.map((room) => {
      const occupants = room.occupants;
      const primaryOccupant = occupants[0];
      const isAvailable = String(room.derivedStatus).toLowerCase() === 'available';
      return `
        <article class="room-card ${isAvailable ? 'room-card-available' : 'room-card-occupied'}">
          <h3>${room.roomNumber}</h3>
          <p>Capacity: ${room.capacity}</p>
          <p>Rent: ${formatCurrency(room.monthlyRent)}</p>
          <p>Status: ${badge(room.derivedStatus)}</p>
          <p>Occupants: ${occupants.length ? occupants.map((tenant) => tenant.name).join(', ') : 'None'}</p>
          <button class="room-hover-action" data-open-room-modal="${room.id}" data-room-label="${escapeHtml(room.roomNumber)}" data-tenant-id="${primaryOccupant?.id || ''}" type="button">Edit</button>
        </article>
      `;
    }).join('');

    if (!tenants.length) {
      setStatus('admin-status', 'No tenant profiles were found in Firestore. If you just created one, sign out and back into the admin account, then refresh this page.', true);
    }

    const setInlineRowProcessing = (row, isProcessing) => {
      const rowButtons = row?.querySelectorAll('[data-save-inline-tenant], [data-delete-inline-tenant], [data-cancel-inline-tenant]');
      if (!rowButtons || !rowButtons.length) return () => {};
      const snapshots = [...rowButtons].map((entry) => ({
        node: entry,
        text: entry.textContent,
        disabled: entry.disabled,
        loading: entry.classList.contains('is-loading')
      }));
      if (isProcessing) {
        rowButtons.forEach((entry) => {
          entry.disabled = true;
          entry.classList.add('is-loading');
          entry.textContent = 'Processing...';
        });
      }
      return () => {
        snapshots.forEach((snapshot) => {
          snapshot.node.disabled = snapshot.disabled;
          snapshot.node.textContent = snapshot.text;
          snapshot.node.classList.toggle('is-loading', snapshot.loading);
        });
      };
    };

    tenantTable.querySelectorAll('[data-start-inline-tenant]').forEach((button) => {
      button.addEventListener('click', async () => {
        inlineEditingTenantId = button.dataset.startInlineTenant || '';
        await refresh();
      });
    });

    tenantTable.querySelectorAll('[data-cancel-inline-tenant]').forEach((button) => {
      button.addEventListener('click', async () => {
        inlineEditingTenantId = '';
        await refresh();
      });
    });

    tenantTable.querySelectorAll('[data-save-inline-tenant]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('tr');
        const release = setInlineRowProcessing(row, true);
        try {
          const tenantId = button.dataset.saveInlineTenant;
          if (!tenantId || !row) return;
          const name = row.querySelector('[data-inline-name]')?.value?.trim();
          const email = row.querySelector('[data-inline-email]')?.value?.trim();
          const contact = row.querySelector('[data-inline-contact]')?.value?.trim();
          const roomIdInput = row.querySelector('[data-inline-room]')?.value || '';
          const statusInput = row.querySelector('[data-inline-status]')?.value || 'Pending Approval';
          if (!name || !email || !contact) {
            const msg = 'Name, email, and contact are required for inline editing.';
            setStatus('admin-status', msg, true);
            showToast(msg, true);
            return;
          }
          const existingTenant = tenants.find((entry) => entry.id === tenantId);
          if (!existingTenant) {
            const msg = 'Tenant record not found for update.';
            setStatus('admin-status', msg, true);
            showToast(msg, true);
            return;
          }

          const nextRoomId = statusInput === 'Inactive' ? null : (roomIdInput || null);
          if (nextRoomId && nextRoomId !== existingTenant.roomId) {
            const capacityCheck = await ensureRoomHasCapacity(nextRoomId, tenantId);
            if (!capacityCheck.ok) {
              setStatus('admin-status', capacityCheck.message, true);
              showToast(capacityCheck.message, true);
              return;
            }
          }

          if (existingTenant.roomId && existingTenant.roomId !== nextRoomId) {
            await updateDoc(doc(db, collections.rooms, existingTenant.roomId), { status: 'Available' });
          }
          if (nextRoomId) {
            await updateDoc(doc(db, collections.rooms, nextRoomId), { status: 'Occupied' });
          }

          await updateDoc(doc(db, collections.users, tenantId), {
            name,
            email,
            contact,
            status: statusInput,
            roomId: nextRoomId
          });
          inlineEditingTenantId = '';
          setStatus('admin-status', 'Tenant row updated successfully.');
          showToast('Changes saved successfully.');
          await refresh();
        } catch (error) {
          const msg = error?.message || 'Unable to save tenant changes.';
          setStatus('admin-status', msg, true);
          showToast(msg, true);
        } finally {
          release();
        }
      });
    });

    tenantTable.querySelectorAll('[data-delete-inline-tenant]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('tr');
        const tenantId = button.dataset.deleteInlineTenant;
        if (!tenantId || !row) return;
        const tenantDisplayName = button.dataset.tenantName || 'this tenant';
        const confirmed = window.confirm(`Archive ${tenantDisplayName}? The account will be set to Inactive and hidden from active tenant records.`);
        if (!confirmed) return;

        const release = setInlineRowProcessing(row, true);
        try {
          const tenant = tenants.find((entry) => entry.id === tenantId);
          if (tenant?.roomId) {
            await updateDoc(doc(db, collections.rooms, tenant.roomId), { status: 'Available' });
          }
          await updateDoc(doc(db, collections.users, tenantId), {
            status: 'Inactive',
            isArchived: true,
            roomId: null
          });
          inlineEditingTenantId = '';
          setStatus('admin-status', 'Tenant account archived (inactive). Historical logs and payments were retained.');
          showToast('Tenant archived successfully.');
          await refresh();
        } catch (error) {
          const msg = error?.message || 'Unable to delete tenant.';
          setStatus('admin-status', msg, true);
          showToast(msg, true);
        } finally {
          release();
        }
      });
    });

    const assignableTenants = tenants.filter((tenant) => tenant.status !== 'Inactive');
    const modalTenantSelect = roomModalForm?.querySelector('select[name="tenant"]');
    if (modalTenantSelect) {
      modalTenantSelect.innerHTML = `<option value="" disabled selected>Tenant Name</option>` +
        assignableTenants.map((tenant) => `<option value="${tenant.id}">${tenant.name || tenant.email}</option>`).join('');
    }
    const billTenantSelect = document.querySelector('#bill-form select[name="tenant"]');
    if (billTenantSelect) {
      const selectedTenant = billTenantSelect.value;
      billTenantSelect.innerHTML = `<option value="" disabled ${selectedTenant ? '' : 'selected'}>Tenant Name</option>` +
        activeTenants.map((tenant) => `<option value="${tenant.id}" ${selectedTenant === tenant.id ? 'selected' : ''}>${tenant.name || tenant.email}</option>`).join('');
    }

    const billTable = document.getElementById('bill-table');
    billTable.innerHTML = [...bills].reverse().map((bill) => `
      <tr>
        <td>${tenantName(allTenantProfiles, bill.tenantId)}</td>
        <td>${bill.month}</td>
        <td>${formatCurrency(bill.total)}</td>
        <td>${badge(bill.status)}</td>
      </tr>
    `).join('');
    if (!bills.length) {
      billTable.innerHTML = '<tr><td colspan="4">No billing records found.</td></tr>';
    }

    const paymentTable = document.getElementById('payment-table');
    const paymentsByBill = new Map(payments.map((payment) => [payment.billId, payment]));
    const billRows = bills.map((bill) => ({ kind: 'bill', bill, payment: paymentsByBill.get(bill.id) || null }));
    const orphanPaymentRows = payments
      .filter((payment) => !bills.some((bill) => bill.id === payment.billId))
      .map((payment) => ({ kind: 'orphanPayment', bill: null, payment }));
    const paymentRows = [...billRows, ...orphanPaymentRows];

    paymentTable.innerHTML = paymentRows.map((row) => {
      const bill = row.bill;
      const payment = row.payment;
      const billCell = bill ? `#BILL-${bill.id.slice(0, 6)}` : '#BILL-DELETED';
      const tenantId = bill?.tenantId || payment?.tenantId;
      return `
        <tr>
          <td>${billCell}</td>
          <td>${tenantName(allTenantProfiles, tenantId)}</td>
          <td>${formatCurrency(payment ? payment.amount : bill?.total)}</td>
          <td>${payment ? payment.date : (bill?.dueDate || '-')}</td>
          <td>${payment ? payment.method : 'Pending'}</td>
          <td>${badge(payment ? payment.status : (bill?.status || 'Unknown'))}</td>
          <td>${payment ? '<span>Recorded</span>' : (bill ? `<button class="button secondary" data-mark-paid="${bill.id}" type="button">Mark as Paid</button>` : '<span>-</span>')}</td>
        </tr>
      `;
    }).join('');

    const visitorTable = document.getElementById('visitor-table');
    visitorTable.innerHTML = [...visitorLogs].reverse().map((entry) => `
      <tr>
        <td>${tenantName(allTenantProfiles, entry.tenantId)}</td>
        <td>${entry.visitorName}</td>
        <td>${entry.visitDate}</td>
        <td>${entry.timeIn}</td>
        <td>${entry.timeOut || 'Open'}</td>
        <td>${entry.purpose}</td>
      </tr>
    `).join('');

    const occupiedRooms = managedRooms.filter((room) => room.derivedStatus === 'Occupied').length;
    const revenue = payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    setText('occupancy-rate', managedRooms.length ? `${Math.round((occupiedRooms / managedRooms.length) * 100)}% of rooms occupied` : 'No rooms yet');
    setText('revenue-total', formatCurrency(revenue));

    roomCards.querySelectorAll('[data-open-room-modal]').forEach((button) => {
      button.addEventListener('click', () => {
        openRoomPlacementModal(
          button.dataset.openRoomModal,
          button.dataset.roomLabel || 'Selected room',
          button.dataset.tenantId || ''
        );
      });
    });

    paymentTable.querySelectorAll('[data-mark-paid]').forEach((button) => {
      button.addEventListener('click', async () => {
        await runWithElementLock(button, 'Processing...', async () => {
          try {
            const bill = bills.find((entry) => entry.id === button.dataset.markPaid);
            if (!bill) return;
            await updateDoc(doc(db, collections.bills, bill.id), { status: 'Paid' });
            await addDoc(collection(db, collections.payments), {
              billId: bill.id,
              tenantId: bill.tenantId,
              amount: bill.total,
              date: new Date().toISOString().slice(0, 10),
              method: 'Cash',
              status: 'Confirmed',
              createdAt: serverTimestamp()
            });
            setStatus('admin-status', 'Payment recorded successfully.');
            showToast('Payment marked as paid.');
            await refresh();
          } catch (error) {
            const msg = error?.message || 'Unable to mark bill as paid.';
            setStatus('admin-status', msg, true);
            showToast(msg, true);
          }
        });
      });
    });

    const billForm = document.getElementById('bill-form');
    if (billForm) {
      const tenantSelect = billForm.querySelector('select[name="tenant"]');
      const rentDisplay = billForm.querySelector('input[name="rentDisplay"]');
      const utilitiesDisplay = billForm.querySelector('input[name="utilitiesDisplay"]');
      const utilitiesRaw = billForm.querySelector('input[name="utilitiesRaw"]');

      const syncRentFromTenant = () => {
        const selected = activeTenants.find((tenant) => tenant.id === tenantSelect?.value);
        const assignedRoom = roomsWithOccupants.find((room) => room.id === selected?.roomId);
        if (!selected) {
          rentDisplay.value = '';
          rentDisplay.placeholder = 'Rent';
          return;
        }
        if (!assignedRoom) {
          rentDisplay.value = '';
          rentDisplay.placeholder = 'No room assigned';
          return;
        }
        rentDisplay.value = formatCurrency(assignedRoom.monthlyRent);
      };

      if (!billForm.dataset.listenersAttached) {
        tenantSelect?.addEventListener('change', syncRentFromTenant);
        utilitiesDisplay?.addEventListener('input', () => {
          const sanitized = sanitizeMoneyInput(utilitiesDisplay.value);
          utilitiesRaw.value = sanitized;
          utilitiesDisplay.value = sanitized ? formatMoneyForInput(sanitized) : '';
        });
        billForm.dataset.listenersAttached = 'true';
      }

      syncRentFromTenant();
    }
  }

  tenantSearch?.addEventListener('input', () => {
    currentTenantPage = 1;
    refresh();
  });

  document.querySelectorAll('[data-tenant-sort]').forEach((header) => {
    const cycleSortState = async () => {
      const key = header.dataset.tenantSort;
      if (!key) return;

      if (tenantSortKey !== key) {
        tenantSortKey = key;
        tenantSortDirection = 'asc';
      } else if (tenantSortDirection === 'asc') {
        tenantSortDirection = 'desc';
      } else if (tenantSortDirection === 'desc') {
        tenantSortKey = '';
        tenantSortDirection = 'none';
      } else {
        tenantSortDirection = 'asc';
      }

      currentTenantPage = 1;
      await refresh();
    };

    header.addEventListener('click', cycleSortState);
    header.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      cycleSortState();
    });
  });

  roomModalForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Processing...', async () => {
      try {
        const form = new FormData(event.currentTarget);
        const ok = await assignTenantToRoom(
          form.get('tenant'),
          form.get('roomId'),
          form.get('startDate')
        );
        if (!ok) {
          showToast('Unable to assign room. Please check the form.', true);
          return;
        }
        closeRoomPlacementModal();
        setStatus('admin-status', 'Room placement updated successfully.');
        showToast('Room assigned successfully.');
        await refresh();
      } catch (error) {
        const msg = error?.message || 'Unable to assign room.';
        setStatus('admin-status', msg, true);
        showToast(msg, true);
      }
    });
  });

  roomModalClose?.addEventListener('click', () => {
    closeRoomPlacementModal();
  });

  roomPlacementModal?.addEventListener('click', (event) => {
    if (event.target === roomPlacementModal) {
      closeRoomPlacementModal();
    }
  });
  document.getElementById('bill-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Processing...', async () => {
      try {
        const form = new FormData(event.currentTarget);
        const tenantId = form.get('tenant');
        const tenantSnapshot = await getDoc(doc(db, collections.users, tenantId));
        const tenant = tenantSnapshot.data();
        if (!tenant?.roomId) {
          const msg = 'Assign the tenant to a room before generating a bill.';
          setStatus('admin-status', msg, true);
          showToast(msg, true);
          return;
        }
        const roomSnapshot = await getDoc(doc(db, collections.rooms, tenant.roomId));
        const room = roomSnapshot.data();
        const rent = Number(room.monthlyRent || 0);
        const utilities = Number(form.get('utilitiesRaw'));
        if (!Number.isFinite(utilities) || utilities < 0) {
          const msg = 'Please enter a valid utilities amount.';
          setStatus('admin-status', msg, true);
          showToast(msg, true);
          return;
        }
        const month = normalizeBillingPeriod(form.get('billingMonth'), form.get('billingYear'));
        const dueDate = computeBillDueDate(month);
        if (!dueDate) {
          const msg = 'Please enter a valid billing month and year.';
          setStatus('admin-status', msg, true);
          showToast(msg, true);
          return;
        }

        await addDoc(collection(db, collections.bills), {
          tenantId,
          month,
          rent,
          utilities,
          total: rent + utilities,
          dueDate,
          status: 'Unpaid',
          createdAt: serverTimestamp()
        });

        event.currentTarget.reset();
        setStatus('admin-status', 'Bill generated successfully.');
        showToast('Bill generated successfully.');
        await refresh();
      } catch (error) {
        const msg = error?.message || 'Unable to generate bill.';
        setStatus('admin-status', msg, true);
        showToast(msg, true);
      }
    });
  });
  await refresh();
}

async function initTenant() {
  const { user, profile } = await requireRole('tenant');
  attachLogout();
  initDashboardResetPassword();
  setText('tenant-user-name', profile.name || profile.email || 'Tenant');
  setText('tenant-user-role', `Role: ${profile.role}`);
  setStatus('tenant-status', 'Your profile, billing records, and visitor entries are loaded from Firestore.');

  async function refresh() {
    const bills = await loadCollection(collections.bills, [where('tenantId', '==', user.uid)]);
    const payments = await loadCollection(collections.payments, [where('tenantId', '==', user.uid)]);
    const visitors = await loadCollection(collections.visitorLogs, [where('tenantId', '==', user.uid)]);
    const latestProfile = await getProfile(user.uid);
    const room = latestProfile?.roomId ? (await getDoc(doc(db, collections.rooms, latestProfile.roomId))).data() : null;
    const profileForm = document.getElementById('tenant-profile-form');
    const tenantStatusTone = normalizeRole(String(latestProfile?.status || '').replace(/\s+/g, '-'));

    renderStats('tenant-stats', [
      { value: room?.roomNumber || 'Pending', label: 'Assigned room' },
      { value: bills.length, label: 'Bills on record' },
      { value: payments.length, label: 'Confirmed payments' },
      { value: visitors.length, label: 'Visitor entries' }
    ]);
    const firstTenantCard = document.querySelector('#tenant-stats .stat-card');
    if (firstTenantCard) {
      firstTenantCard.classList.remove('status-pending-approval', 'status-active', 'status-inactive');
      if (tenantStatusTone === 'pending-approval') firstTenantCard.classList.add('status-pending-approval');
      if (tenantStatusTone === 'active') firstTenantCard.classList.add('status-active');
      if (tenantStatusTone === 'inactive') firstTenantCard.classList.add('status-inactive');
    }

    if (latestProfile?.status === 'Pending Approval') {
      setStatus('tenant-status', 'Your account is pending admin approval. You can update your contact number while waiting.', true);
    } else if (latestProfile?.status === 'Active') {
      setStatus('tenant-status', 'Your account is active. Room assignments, bills, and visitor entries are loaded from Firestore.');
    }

    const roomPanel = document.getElementById('tenant-room-panel');
    roomPanel.innerHTML = room ? `
      <h3>${room.roomNumber}</h3>
      <p>Monthly rent: ${formatCurrency(room.monthlyRent)}</p>
      <p>Capacity: ${room.capacity}</p>
      <p>Status: ${badge(room.status)}</p>
    ` : '<p>No room assigned yet. Ask the administrator to assign your room.</p>';

    document.getElementById('tenant-bill-table').innerHTML = bills.length ? bills.map((bill) => `
      <tr>
        <td>${bill.month}</td>
        <td>${formatCurrency(bill.rent)}</td>
        <td>${formatCurrency(computeUtilities(bill))}</td>
        <td>${formatCurrency(typeof bill.total !== 'undefined' ? bill.total : Number(bill.rent || 0) + computeUtilities(bill))}</td>
        <td>${badge(bill.status)}</td>
      </tr>
    `).join('') : '<tr><td colspan="5">No bills recorded yet.</td></tr>';

    document.getElementById('tenant-payment-table').innerHTML = payments.length ? payments.map((payment) => `
      <tr>
        <td>${payment.date}</td>
        <td>${formatCurrency(payment.amount)}</td>
        <td>${payment.method}</td>
        <td>${badge(payment.status)}</td>
      </tr>
    `).join('') : '<tr><td colspan="4">No payments recorded yet.</td></tr>';

    document.getElementById('tenant-visitor-table').innerHTML = visitors.length ? visitors.map((entry) => `
      <tr>
        <td>${entry.visitorName}</td>
        <td>${entry.visitDate}</td>
        <td>${entry.timeIn}</td>
        <td>${entry.timeOut || 'Open'}</td>
        <td>${entry.purpose}</td>
      </tr>
    `).join('') : '<tr><td colspan="5">No visitor entries yet.</td></tr>';

    document.getElementById('reset-card').innerHTML = `
      <p>Account email: <strong>${user.email}</strong></p>
      <p>Password recovery is handled through Firebase Authentication.</p>
      <button class="button secondary" id="request-reset" type="button">Send Reset Email</button>
    `;

    document.getElementById('request-reset')?.addEventListener('click', async () => {
      await sendPasswordResetEmail(auth, user.email);
      setStatus('tenant-status', `Password reset email sent to ${user.email}.`);
    });

    if (profileForm) {
      profileForm.elements.name.value = latestProfile?.name || '';
      profileForm.elements.email.value = user.email || latestProfile?.email || '';
      profileForm.elements.contact.value = latestProfile?.contact || '';
    }
  }

  document.getElementById('tenant-profile-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runWithButtonLock(event.currentTarget, 'Saving...', async () => {
      const form = new FormData(event.currentTarget);
      await updateDoc(doc(db, collections.users, user.uid), {
        contact: form.get('contact')
      });
      setStatus('tenant-status', 'Contact number updated successfully.');
      await refresh();
    });
  });

  document.getElementById('visitor-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await addDoc(collection(db, collections.visitorLogs), {
      tenantId: user.uid,
      visitorName: form.get('visitorName'),
      visitDate: form.get('visitDate'),
      timeIn: form.get('timeIn'),
      timeOut: form.get('timeOut'),
      purpose: form.get('purpose'),
      createdAt: serverTimestamp()
    });
    event.currentTarget.reset();
    await refresh();
  });

  await refresh();
}

async function init() {
  if (page === 'home') await initHome();
  if (page === 'admin') await initAdmin();
  if (page === 'tenant') await initTenant();
  if (page === 'reset-password') await initResetPassword();
}

init().catch((error) => {
  console.error(error);
  setMessage(error.message || 'An unexpected error occurred.', true);
  setText('admin-status', error.message || 'Unable to load admin data.');
  setText('tenant-status', error.message || 'Unable to load tenant data.');
});













