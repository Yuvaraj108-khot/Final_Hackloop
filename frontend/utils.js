// Shared user auth utilities
// Users are stored as a JSON object in localStorage under the key 'fa_users'

function loadUsers() {
  try {
    const raw = localStorage.getItem('fa_users') || '{}';
    // Support legacy CSV format: if it doesn't start with '{', migrate to JSON
    if (raw.trim().startsWith('{')) {
      return JSON.parse(raw);
    }
    // Legacy CSV: wipe and return empty so they re-register
    localStorage.removeItem('fa_users');
    return {};
  } catch (_) {
    return {};
  }
}

function saveUsers(users) {
  try {
    localStorage.setItem('fa_users', JSON.stringify(users));
  } catch (_) {
    alert('Failed to save account. Storage may be full.');
  }
}
