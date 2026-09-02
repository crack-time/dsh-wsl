/**
 * Small JSON client for the WSL workspace host API.
 */
const API = '/plugins/@crack/dsh-wsl/api';
async function parseError(status, body) {
    try {
        const j = JSON.parse(body);
        if (j.error)
            return j.error;
    }
    catch { /* not JSON */ }
    return `HTTP ${status}`;
}
async function api(path, init) {
    const res = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(await parseError(res.status, text));
    return (text ? JSON.parse(text) : {});
}
export const client = {
    listDistros() {
        return api('/distros');
    },
    home(data) {
        return api('/home', { method: 'POST', body: JSON.stringify(data) });
    },
    list(data) {
        return api('/list', { method: 'POST', body: JSON.stringify(data) });
    },
    create(data) {
        return api('/create', { method: 'POST', body: JSON.stringify(data) });
    },
    register(data) {
        return api('/register', { method: 'POST', body: JSON.stringify(data) });
    },
};
