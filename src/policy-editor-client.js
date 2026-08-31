let state = null;
let selected = null;
let selectedRecord = null;
let draft = null;
let entity = "people";
let showAll = false;
let dirty = false;
let csrf = "";
let socket = null;
let searchTimer = null;
let searchSequence = 0;
const addedResources = new Map();

const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
})[character]);

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({ error: "Invalid server response" }));
  if (!response.ok) throw Object.assign(new Error(data.error || "Request failed"), { data });
  return data;
}

async function copy(text, button) {
  await navigator.clipboard.writeText(text).catch(() => prompt("Copy this text", text));
  if (!button) return;
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = label; }, 1_200);
}

function connectionText() {
  if (!socket) return "● connecting";
  if (socket.readyState === WebSocket.OPEN) return "● connected";
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return "● disconnected";
  return "● connecting";
}

function connectionMarkup() {
  return `<span id="connection" class="status">${connectionText()}</span>`;
}

function setConnection(text) {
  const indicator = document.getElementById("connection");
  if (indicator) indicator.textContent = text;
}

function blankPolicy() {
  const identity = state.context.tenantId && state.context.userId
    ? { allowed: [{ tenantId: state.context.tenantId, userId: state.context.userId }] }
    : undefined;
  return {
    version: 1,
    name: "workspace-policy",
    active: false,
    subject: { paths: [state.subjectPath, `${state.subjectPath}/**`] },
    ...(identity ? { identity } : {}),
    allow: { people: {}, chats: {}, channels: {}, rawTokenExport: false },
    deny: { people: {}, chats: {}, channels: {} },
  };
}

function normalizePolicy(policy) {
  const value = structuredClone(policy);
  value.allow ||= {};
  value.allow.people ||= {};
  value.allow.chats ||= {};
  value.allow.channels ||= {};
  value.deny ||= {};
  value.deny.people ||= {};
  value.deny.chats ||= {};
  value.deny.channels ||= {};
  value.identity ||= { allowed: [] };
  value.identity.allowed ||= [];
  return value;
}

function applicablePolicies() {
  return state.policies.filter((record) => record.applies);
}

function shownPolicies() {
  const records = showAll ? [...state.policies] : applicablePolicies();
  if (selectedRecord && !records.includes(selectedRecord)) records.push(selectedRecord);
  return records.sort((a, b) => Number(Boolean(b.applies)) - Number(Boolean(a.applies)) || a.name.localeCompare(b.name));
}

function choose(record, fresh = false) {
  if (!fresh && dirty && !confirm("Discard the unsaved changes on this policy?")) return false;
  selectedRecord = record;
  selected = record ? record.name : "__new__";
  draft = record?.error ? null : normalizePolicy(record?.policy || blankPolicy());
  dirty = !record;
  entity = "people";
  addedResources.clear();
  render();
  return true;
}

function policyStatus(record) {
  if (record.error) return '<span class="badge error">Invalid</span>';
  return record.policy?.active ? '<span class="badge active">Active</span>' : "";
}

function fileCell(record) {
  const file = record.file;
  const name = file.split(/[\\/]/).pop();
  return `<span class="file"><span class="detail" title="${esc(file)}">${esc(name)}</span><button type="button" data-copy-path="${esc(file)}">Copy path</button></span>`;
}

function renderPolicyTable() {
  const rows = shownPolicies();
  document.getElementById("showAllLabel").classList.toggle("hidden", state.policies.length <= 1);
  const html = rows.map((record) => {
    const current = selectedRecord === record;
    const match = record.matchingPaths?.[0] || (record.applies ? record.policy?.subject?.paths?.[0] : "Not applicable");
    const star = current && dirty ? " *" : "";
    const lockedDelete = Boolean(record.policy?.active || record.locked);
    return `<tr data-policy="${esc(record.name)}" aria-current="${current}"><td><span class="policy-name">${esc(record.name + star)}</span></td><td>${policyStatus(record)}</td><td title="${esc((record.matchingPaths || []).join("\n"))}">${esc(match)}</td><td>${fileCell(record)}</td><td><button type="button" data-delete="${esc(record.name)}" ${lockedDelete ? 'disabled title="Active or locked policies cannot be deleted"' : ""}>Delete</button></td></tr>`;
  }).join("");
  const newRow = selected === "__new__"
    ? `<tr data-policy="__new__" aria-current="true"><td><span class="file"><input id="newPolicyName" aria-label="Policy name" type="text" value="${esc(draft.name)}"><span>*</span></span></td><td></td><td>${esc(draft.subject.paths[0] || state.subjectPath)}</td><td><span class="detail">Not saved</span></td><td><button type="button" data-cancel-new>Delete</button></td></tr>`
    : "";
  document.getElementById("policyRows").innerHTML = html + newRow;
  const nameInput = document.getElementById("newPolicyName");
  if (nameInput) nameInput.oninput = () => { draft.name = nameInput.value.trim(); markDirty(); };
}

function markDirty() {
  dirty = true;
  document.getElementById("dirtyState").textContent = "Unsaved changes";
  const row = document.querySelector("#policyRows tr[aria-current=true] .policy-name");
  if (row && !row.textContent.endsWith(" *")) row.textContent += " *";
}

function mapName(kind) {
  return kind === "person" ? "people" : kind === "chat" ? "chats" : "channels";
}

function actionDecision(kind, id, action) {
  const name = mapName(kind);
  if (draft.deny[name]?.[id]?.includes(action)) return "deny";
  if (draft.allow[name]?.[id]?.includes(action)) return "allow";
  return "default";
}

function defaultDecision(kind, action) {
  return draft.allow[mapName(kind)]?.["*"]?.includes(action) ? "allow" : "deny";
}

function setMapAction(map, id, action, present) {
  const actions = new Set(map[id] || []);
  if (present) actions.add(action); else actions.delete(action);
  if (actions.size) map[id] = [...actions]; else delete map[id];
}

function setDecision(kind, id, action, value) {
  const name = mapName(kind);
  setMapAction(draft.allow[name], id, action, value === "allow");
  setMapAction(draft.deny[name], id, action, value === "deny");
  markDirty();
}

function setDefault(kind, action, value) {
  setMapAction(draft.allow[mapName(kind)], "*", action, value === "allow");
  markDirty();
}

function decisionSelect(value, scope, action, index = "") {
  const defaultOption = scope === "rule" ? `<option value="default" ${value === "default" ? "selected" : ""}>Default</option>` : "";
  return `<select class="access" data-${scope}="${esc(action)}" ${scope === "rule" ? `data-index="${esc(index)}"` : ""}>${defaultOption}<option value="allow" ${value === "allow" ? "selected" : ""}>Allow</option><option value="deny" ${value === "deny" ? "selected" : ""}>Deny</option></select>`;
}

function entityKind() {
  return entity === "people" ? "person" : entity === "chats" ? "chat" : "channel";
}

function resourceIcon(kind) {
  const paths = kind === "person"
    ? '<circle cx="10" cy="7" r="3"></circle><path d="M4 18c0-3.2 2.4-5 6-5s6 1.8 6 5"></path>'
    : kind === "chat"
      ? '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v4a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3.6A2.5 2.5 0 0 1 4 9.5z"></path><circle cx="8" cy="7.5" r=".6"></circle><circle cx="10" cy="7.5" r=".6"></circle><circle cx="12" cy="7.5" r=".6"></circle>'
      : '<path d="M4 4h12v12H4z"></path><path d="M8 4v12M4 8h12"></path>';
  return `<span class="resource-icon ${esc(kind)}" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false">${paths}</svg></span>`;
}

function resourceLabel(resource) {
  return `<span class="resource-label">${resourceIcon(resource.kind)}<span><strong>${esc(resource.label)}</strong><span class="detail">${esc(resource.detail || resource.id)}</span></span></span>`;
}

function configuredIds(kind) {
  const name = mapName(kind);
  return new Set([...Object.keys(draft.allow[name] || {}), ...Object.keys(draft.deny[name] || {})].filter((id) => id !== "*"));
}

function ruleResources() {
  const kind = entityKind();
  const ids = configuredIds(kind);
  const result = [];
  for (const id of ids) {
    const known = state.resources.find((resource) => resource.kind === kind && resource.id === id) || addedResources.get(`${kind}:${id}`);
    result.push(known || { kind, id, label: id, detail: "Stored identifier was not returned by Teams" });
  }
  for (const resource of addedResources.values()) {
    if (resource.kind === kind && !ids.has(resource.id)) result.push(resource);
  }
  return result;
}

const defaultText = {
  people: "For anyone not in the list, or when set to default.",
  chats: "For chats not in the list, or when set to default.",
  channels: "For channels not in the list, or when set to default.",
};

function renderRuleRows() {
  const kind = entityKind();
  const resources = ruleResources();
  const rows = resources.map((resource, index) => `<tr><td>${resourceLabel(resource)}</td><td>${decisionSelect(actionDecision(kind, resource.id, "read"), "rule", "read", index)}</td><td>${decisionSelect(actionDecision(kind, resource.id, "post"), "rule", "post", index)}</td><td><button type="button" data-remove-rule="${index}">Remove</button></td></tr>`).join("");
  const fallback = `<tr class="default-row"><td>Default<span class="detail">${esc(defaultText[entity])}</span></td><td>${decisionSelect(defaultDecision(kind, "read"), "fallback", "read")}</td><td>${decisionSelect(defaultDecision(kind, "post"), "fallback", "post")}</td><td></td></tr>`;
  document.getElementById("resourceRows").innerHTML = rows + fallback;
  document.querySelectorAll("[data-rule]").forEach((control) => {
    control.onchange = () => {
      const resource = ruleResources()[Number(control.dataset.index)];
      if (resource) setDecision(kind, resource.id, control.dataset.rule, control.value);
    };
  });
  document.querySelectorAll("[data-fallback]").forEach((control) => {
    control.onchange = () => setDefault(kind, control.dataset.fallback, control.value);
  });
  document.querySelectorAll("[data-remove-rule]").forEach((button) => {
    button.onclick = () => {
      const resource = ruleResources()[Number(button.dataset.removeRule)];
      if (!resource) return;
      for (const action of ["read", "post"]) setDecision(kind, resource.id, action, "default");
      addedResources.delete(`${kind}:${resource.id}`);
      renderRuleRows();
    };
  });
}

function addResource(resource) {
  addedResources.set(`${resource.kind}:${resource.id}`, resource);
  setDecision(resource.kind, resource.id, "read", "allow");
  setDecision(resource.kind, resource.id, "post", "default");
  document.getElementById("searchResults").classList.add("hidden");
  document.getElementById("resourceSearch").value = "";
  renderRuleRows();
}

function renderSuggestions(resources) {
  const unique = [...new Map(resources.map((resource) => [`${resource.kind}:${resource.id}`, resource])).values()];
  const configured = (resource) => {
    const candidates = new Set([resource.id, ...(resource.participantIds || [])]);
    return [...configuredIds(resource.kind)].find((id) => candidates.has(id));
  };
  let hydrated = false;
  for (const resource of unique) {
    const configuredId = configured(resource);
    if (!configuredId) continue;
    addedResources.set(`${resource.kind}:${configuredId}`, { ...resource, id: configuredId });
    hydrated = true;
  }
  if (hydrated) renderRuleRows();
  const target = document.getElementById("searchResults");
  target.innerHTML = unique.map((resource, index) => {
    const alreadyAdded = Boolean(configured(resource));
    return `<div class="suggestion">${resourceLabel(resource)}<button type="button" data-add-result="${index}" class="primary" ${alreadyAdded ? "disabled" : ""}>${alreadyAdded ? "Added" : "Add"}</button></div>`;
  }).join("");
  target.classList.toggle("hidden", unique.length === 0);
  target.querySelectorAll("[data-add-result]").forEach((button) => { button.onclick = () => addResource(unique[Number(button.dataset.addResult)]); });
}

function setSearching(searching) {
  const spinner = document.getElementById("searchSpinner");
  const input = document.getElementById("resourceSearch");
  if (!spinner || !input) return;
  spinner.classList.toggle("hidden", !searching);
  input.setAttribute("aria-busy", String(searching));
}

function searchResources(query) {
  const kind = entityKind();
  const local = state.resources.filter((resource) => resource.kind === kind && `${resource.label} ${resource.detail} ${resource.id}`.toLowerCase().includes(query));
  renderSuggestions(local);
  if (entity !== "people") { setSearching(false); return; }
  const sequence = ++searchSequence;
  clearTimeout(searchTimer);
  setSearching(true);
  searchTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/people?q=${encodeURIComponent(query)}`);
      if (sequence !== searchSequence) return;
      renderSuggestions(result.people.map((person) => ({ kind: "person", id: person.id, participantIds: [person.mri, ...(person.aliases || [])].filter(Boolean), label: person.displayName || person.email || person.id, detail: person.email || person.mri || person.id })));
    } catch (error) {
      if (sequence === searchSequence) document.getElementById("message").innerHTML = `<div class="banner error">${esc(error.message)}</div>`;
    } finally {
      if (sequence === searchSequence) setSearching(false);
    }
  }, 250);
}

function knownIdentities() {
  const values = [...state.identities];
  if (state.context.tenantId && state.context.userId && !values.some((identity) => identity.tenantId === state.context.tenantId && identity.userId === state.context.userId)) {
    values.push({ tenantId: state.context.tenantId, userId: state.context.userId, label: state.context.username || state.context.profileName });
  }
  return values;
}

function identityLabel(identity) {
  return knownIdentities().find((candidate) => candidate.tenantId === identity.tenantId && candidate.userId === identity.userId)?.label || identity.userId;
}

function renderIdentities() {
  const allowed = draft.identity?.allowed || [];
  const rows = allowed.map((identity, index) => `<tr><td>${esc(identityLabel(identity))}<span class="detail">${esc(identity.tenantId)} / ${esc(identity.userId)}</span></td><td><button type="button" data-remove-identity="${index}">Remove</button></td></tr>`).join("");
  const available = knownIdentities().filter((candidate) => !allowed.some((identity) => identity.tenantId === candidate.tenantId && identity.userId === candidate.userId));
  const picker = `<tr><td colspan="2"><select id="identityPicker" class="identity-picker"><option value="">Select another identity</option>${available.map((identity, index) => `<option value="${index}">${esc(identity.label)} · ${esc(identity.userId)}</option>`).join("")}</select></td></tr>`;
  document.getElementById("identityRows").innerHTML = rows + picker;
  document.querySelectorAll("[data-remove-identity]").forEach((button) => {
    button.onclick = () => { draft.identity.allowed.splice(Number(button.dataset.removeIdentity), 1); markDirty(); renderIdentities(); };
  });
  document.getElementById("identityPicker").onchange = (event) => {
    if (event.target.value === "") return;
    const identity = available[Number(event.target.value)];
    if (identity) draft.identity.allowed.push({ tenantId: identity.tenantId, userId: identity.userId });
    markDirty();
    renderIdentities();
  };
}

function renderEditor() {
  if (selectedRecord?.error) {
    document.getElementById("content").innerHTML = `<div class="section"><h3>${esc(selectedRecord.name)}</h3><div class="banner error">${esc(selectedRecord.error)}</div><pre>${esc(selectedRecord.raw)}</pre><div class="footer"><span class="dirty"></span>${connectionMarkup()}<button id="copyRaw">Copy YAML</button></div></div>`;
    document.getElementById("copyRaw").onclick = (event) => copy(selectedRecord.raw, event.currentTarget);
    return;
  }
  const locked = Boolean(selectedRecord?.locked);
  document.getElementById("content").innerHTML = `${selectedRecord?.lockReason ? `<div class="banner">${esc(selectedRecord.lockReason)}</div>` : ""}
    <section class="section"><h3>Message destinations</h3><p class="section-lead">Choose the people, group chats, and channels this policy may read from or post to.</p><div class="tabs"><button type="button" data-entity="people" aria-selected="true">People</button><button type="button" data-entity="chats" aria-selected="false">Group chats</button><button type="button" data-entity="channels" aria-selected="false">Channels</button></div><div class="search"><div class="search-control"><input id="resourceSearch" type="text" autocomplete="off" placeholder="Search people by name or email" aria-describedby="searchStatus"><span id="searchSpinner" class="spinner hidden" aria-hidden="true"></span><span id="searchStatus" class="visually-hidden" role="status">Searching the directory</span></div><div id="searchResults" class="suggestions hidden"></div></div><div class="table-wrap"><table><thead><tr><th>Destination</th><th>Read</th><th>Post</th><th></th></tr></thead><tbody id="resourceRows"></tbody></table></div></section>
    <section class="section"><h3>Allowed identities</h3><p class="section-lead">After this policy applies, only identities on this whitelist may be used in the workspace.</p><div class="table-wrap"><table><thead><tr><th>Allowed identity</th><th></th></tr></thead><tbody id="identityRows"></tbody></table></div></section>
    <section class="section"><h3>Features</h3><label class="token"><input id="rawTokens" type="checkbox" ${draft.allow.rawTokenExport ? "checked" : ""}><span><strong>Allow raw token export</strong><span class="detail">Keep disabled unless an external tool genuinely requires a complete bearer token.</span></span></label></section>
    <section class="section"><h3>Applicability</h3><p class="section-lead">The matching paths determine whether this policy applies to the current workspace.</p><textarea id="subjects" class="paths" rows="3">${esc(draft.subject.paths.join("\n"))}</textarea></section>
    <div class="footer"><span id="dirtyState" class="dirty">${dirty ? "Unsaved changes" : "No unsaved changes"}</span>${connectionMarkup()}<button id="copyYaml">Copy YAML</button>${locked ? '<button id="copyApply">Copy apply command</button>' : '<button id="savePolicy">Save</button><button id="activatePolicy" class="primary">Save and activate</button>'}</div>`;
  renderRuleRows();
  renderIdentities();
  document.querySelectorAll("[data-entity]").forEach((button) => {
    button.onclick = () => {
      entity = button.dataset.entity;
      document.querySelectorAll("[data-entity]").forEach((peer) => peer.setAttribute("aria-selected", String(peer === button)));
      document.getElementById("resourceSearch").value = "";
      document.getElementById("resourceSearch").placeholder = entity === "people" ? "Search people by name or email" : entity === "chats" ? "Search group chats or participants" : "Search channels or teams";
      document.getElementById("searchResults").classList.add("hidden");
      searchSequence += 1;
      clearTimeout(searchTimer);
      setSearching(false);
      renderRuleRows();
    };
  });
  document.getElementById("resourceSearch").oninput = (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (query.length < 2) {
      searchSequence += 1;
      clearTimeout(searchTimer);
      setSearching(false);
      document.getElementById("searchResults").classList.add("hidden");
      return;
    }
    searchResources(query);
  };
  document.getElementById("rawTokens").onchange = (event) => { draft.allow.rawTokenExport = event.target.checked; markDirty(); };
  document.getElementById("subjects").oninput = (event) => { draft.subject.paths = event.target.value.split("\n").map((value) => value.trim()).filter(Boolean); markDirty(); };
  document.getElementById("copyYaml").onclick = async (event) => copy((await api("/api/render", { method: "POST", body: JSON.stringify({ policy: draft }) })).yaml, event.currentTarget);
  if (locked) {
    document.getElementById("copyApply").onclick = async (event) => copy((await api("/api/export", { method: "POST", body: JSON.stringify({ policy: draft, originalName: selectedRecord.name }) })).command, event.currentTarget);
  } else {
    document.getElementById("savePolicy").onclick = () => save("draft");
    document.getElementById("activatePolicy").onclick = () => save("activate");
  }
}

async function save(mode) {
  if (mode === "activate" && !confirm("Save and activate this policy? Active policies cannot be edited or deleted in place.")) return;
  try {
    const result = await api("/api/save", { method: "POST", body: JSON.stringify({ policy: draft, originalName: selectedRecord?.name || null, expectedHash: selectedRecord?.hash || null, mode }) });
    dirty = false;
    if (mode === "draft") { selected = result.policy.name; await load(); }
  } catch (error) {
    document.getElementById("message").innerHTML = `<div class="banner error">${esc(error.message)}</div>${error.data?.yaml ? '<button id="copyFailed">Copy YAML</button>' : ""}${error.data?.command ? '<button id="copyCommand">Copy replacement command</button>' : ""}`;
    if (error.data?.yaml) document.getElementById("copyFailed").onclick = (event) => copy(error.data.yaml, event.currentTarget);
    if (error.data?.command) document.getElementById("copyCommand").onclick = (event) => copy(error.data.command, event.currentTarget);
  }
}

function render() {
  document.getElementById("editorTitle").textContent = `Policy Editor for workspace ${state.subjectPath}`;
  renderPolicyTable();
  renderEditor();
}

async function load() {
  state = await api("/api/state");
  const requested = selected && selected !== "__new__" ? state.policies.find((record) => record.name === selected) : state.policies.find((record) => record.name === state.requestedName);
  const initial = requested || applicablePolicies()[0];
  if (initial) { selectedRecord = initial; selected = initial.name; draft = initial.error ? null : normalizePolicy(initial.policy); dirty = false; }
  else { selectedRecord = null; selected = "__new__"; draft = normalizePolicy(blankPolicy()); dirty = true; }
  render();
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws`);
  socket.onopen = () => { setConnection("● connected"); };
  socket.onclose = () => {
    setConnection("● disconnected");
    document.getElementById("offline").classList.remove("hidden");
    document.querySelectorAll("button,input,textarea,select").forEach((element) => { element.disabled = true; });
  };
}

async function closeEditor() {
  if (dirty && !confirm("This policy has unsaved changes. Close without saving?")) return;
  await api("/api/done", { method: "POST", body: "{}" });
  window.close();
}

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

document.getElementById("policyRows").onclick = async (event) => {
  const copyButton = event.target.closest("[data-copy-path]");
  if (copyButton) { await copy(copyButton.dataset.copyPath, copyButton); return; }
  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) {
    const record = state.policies.find((candidate) => candidate.name === deleteButton.dataset.delete);
    if (!record || !confirm(`Delete policy ${record.name}?`)) return;
    await api("/api/delete", { method: "POST", body: JSON.stringify({ name: record.name, expectedHash: record.hash }) });
    selected = null;
    await load();
    return;
  }
  if (event.target.closest("[data-cancel-new]")) { selected = null; dirty = false; await load(); return; }
  const row = event.target.closest("[data-policy]");
  if (!row || row.dataset.policy === "__new__") return;
  const record = state.policies.find((candidate) => candidate.name === row.dataset.policy);
  if (record) choose(record);
};

document.getElementById("showAll").onchange = (event) => { showAll = event.target.checked; renderPolicyTable(); };
document.getElementById("newPolicy").onclick = () => choose(null);
document.getElementById("closeEditor").onclick = closeEditor;

async function claim() {
  const token = location.pathname.startsWith("/claim/") ? decodeURIComponent(location.pathname.slice(7)) : "";
  if (token) {
    const result = await api("/api/claim", { method: "POST", body: JSON.stringify({ token }) });
    csrf = result.csrf;
    history.replaceState({}, "", "/");
  } else csrf = (await api("/api/session")).csrf;
  await load();
  connect();
}

claim().catch((error) => {
  document.getElementById("content").innerHTML = `<div class="banner error">${esc(error.message)}</div>`;
  setConnection("● unavailable");
});
