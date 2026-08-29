let state = null;
let selected = "effective";
let csrf = "";
let socket = null;
let dirty = false;
let initialSignature = "";

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

async function claim() {
  const token = location.pathname.startsWith("/claim/") ? decodeURIComponent(location.pathname.slice(7)) : "";
  if (token) {
    const result = await api("/api/claim", { method: "POST", body: JSON.stringify({ token }) });
    csrf = result.csrf;
    history.replaceState({}, "", "/");
  } else csrf = (await api("/api/session")).csrf;
  await load();
  connect();
  document.getElementById("closeEditor").onclick = closeEditor;
}

async function load() {
  state = await api("/api/state");
  document.getElementById("headerMeta").textContent = `v${state.version} · ${state.context.profileName} · ${state.invocationDirectory} · ${state.binding}`;
  if (selected === "effective" && state.requestedName && state.policies.some((policy) => policy.name === state.requestedName)) selected = state.requestedName;
  dirty = false;
  render();
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws`);
  socket.onopen = () => { document.getElementById("connection").textContent = "● connected"; };
  socket.onclose = () => {
    document.getElementById("connection").textContent = "● disconnected";
    document.getElementById("offline").classList.remove("hidden");
    document.querySelectorAll("button,input,textarea,summary").forEach((element) => { element.disabled = true; });
  };
}

async function closeEditor() {
  if (dirty && !confirm("This policy has changes that have not been saved or exported. Close the editor anyway?")) return;
  document.getElementById("connection").textContent = "Closing…";
  await api("/api/done", { method: "POST", body: "{}" });
  window.close();
}

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

function sortedPolicies() {
  return [...state.policies].sort((a, b) => Number(Boolean(b.applies && b.policy?.active)) - Number(Boolean(a.applies && a.policy?.active)) || Number(b.applies) - Number(a.applies) || a.name.localeCompare(b.name));
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.innerHTML = '<button data-tab="effective">◉ Effective access</button><button data-tab="new">＋ New policy</button>' + sortedPolicies().map((policy) => `<button data-tab="${esc(policy.name)}">${esc(policy.name)}${policy.policy?.active ? '<span class="badge active">active</span>' : policy.error ? '<span class="badge error">invalid</span>' : policy.applies ? '<span class="badge">applies</span>' : ""}</button>`).join("");
  nav.querySelectorAll("button").forEach((button) => {
    button.onclick = () => {
      if (dirty && !confirm("Discard the unsaved changes on this policy?")) return;
      selected = button.dataset.tab;
      dirty = false;
      render();
    };
  });
}

function resourceIcon(category) {
  return category === "person" ? "👤" : category === "group" ? "👥" : "#";
}

function effectiveView() {
  const active = state.policies.filter((policy) => policy.applies && policy.policy?.active);
  const unrestricted = active.length === 0;
  const rows = state.resources.map((resource) => {
    const read = unrestricted || active.every((stored) => policyPermits(stored.policy, resource, "read"));
    const post = unrestricted || active.every((stored) => policyPermits(stored.policy, resource, "post"));
    return `<div class="resource"><div><strong>${resourceIcon(resource.category)} ${esc(resource.label)}</strong><br><small>${esc(resource.detail)} · <code>${esc(resource.id)}</code></small></div><span>${read ? "✓ Read" : "— Read"}</span><span>${post ? "✓ Post" : "— Post"}</span></div>`;
  }).join("");
  return `<h2>Effective access</h2><p class="section-lead">The access that remains after every active policy governing this workspace is intersected.</p>${unrestricted ? '<div class="banner error">No active policy applies. Message access is currently unrestricted.</div>' : `<div class="banner ok">Enforced by ${active.map((policy) => esc(policy.name)).join(", ")}</div>`}${state.issues.map((issue) => `<div class="banner error">${esc(issue)}</div>`).join("")}<div class="card"><h3>Destinations</h3><div class="resources">${rows || '<p class="muted">No Teams resources were returned.</p>'}</div></div>`;
}

function blankPolicy() {
  return { version: 1, name: "workspace-policy", active: false, subject: { paths: [state.subjectPath, `${state.subjectPath}/**`] }, identity: { tenantId: state.context.tenantId, userId: state.context.userId }, allow: { chats: {}, channels: {}, rawTokenExport: false }, deny: { chats: {}, channels: {} } };
}

function resourcesForPolicy(policy) {
  const resources = [...state.resources];
  const known = new Set(resources.map((resource) => `${resource.kind}:${resource.id}`));
  for (const rules of [policy.allow, policy.deny]) {
    for (const [kind, entries] of [["chat", rules?.chats || {}], ["channel", rules?.channels || {}]]) {
      for (const id of Object.keys(entries)) {
        if (id !== "*" && !known.has(`${kind}:${id}`)) resources.push({ kind, category: kind === "chat" ? "group" : "channel", id, label: "Unavailable destination", detail: "Stored ID was not returned by Teams discovery", stale: true });
      }
    }
  }
  return resources;
}

function destinationType(resource) {
  return resource.category === "person" ? "Person chat" : resource.category === "group" ? "Group chat" : "Channel";
}

function normalizedActions(value) {
  return value === "post" ? ["post"] : value === "read-post" ? ["read", "post"] : ["read"];
}

function actionValue(actions) {
  return actions.includes("read") && actions.includes("post") ? "read-post" : actions.includes("post") ? "post" : "read";
}

function permissionOptions(actions) {
  const value = actionValue(actions);
  return `<option value="read" ${value === "read" ? "selected" : ""}>Read</option><option value="post" ${value === "post" ? "selected" : ""}>Post</option><option value="read-post" ${value === "read-post" ? "selected" : ""}>Read and Post</option>`;
}

function bucketRow(resource, actions, mode) {
  const value = actionValue(actions);
  return `<div class="bucket-resource ${mode}" data-mode="${mode}" data-kind="${resource.kind}" data-category="${resource.category}" data-id="${esc(resource.id)}"><div><span class="kind-badge">${esc(destinationType(resource))}</span> <strong>${esc(resource.label)}</strong>${resource.stale ? '<span class="badge error">stale</span>' : ""}<br><small>${esc(resource.detail)} · <code>${esc(resource.id)}</code></small></div><select aria-label="${mode === "allow" ? "Allowed" : "Denied"} access for ${esc(resource.label)}" class="bucket-permission ${value.includes("post") ? "post-access" : "read-access"}">${permissionOptions(actions)}</select><button type="button" class="remove-rule" aria-label="Remove ${mode} rule for ${esc(resource.label)}">Remove</button></div>`;
}

function destinationSections(draft) {
  const resources = resourcesForPolicy(draft);
  const rows = (mode) => resources.flatMap((resource) => {
    const rules = mode === "allow" ? draft.allow : draft.deny;
    const map = resource.kind === "chat" ? rules?.chats : rules?.channels;
    return map?.[resource.id]?.length ? [bucketRow(resource, map[resource.id], mode)] : [];
  }).join("");
  const broad = (kind, label) => {
    const map = kind === "chat" ? draft.allow.chats : draft.allow.channels;
    const actions = map?.["*"] || [];
    return `<div class="broad-rule"><div><strong>${esc(label)}</strong><br><small>Applies to every ${kind === "chat" ? "one-to-one and group chat" : "channel"}, except exact denials below.</small></div><label><input class="global-grant" type="checkbox" data-kind="${kind}" data-action="read" ${actions.includes("read") ? "checked" : ""}> Read all</label><label class="post-label"><input class="global-grant" type="checkbox" data-kind="${kind}" data-action="post" ${actions.includes("post") ? "checked" : ""}> Post to all</label></div>`;
  };
  return `<section class="guardrail-section"><h4>Allowed destinations <span class="help" title="An empty allow list denies every destination. Broad allowances can be narrowed by exact denials.">ⓘ</span></h4><div class="default-deny">Default: deny every unlisted destination.</div><div class="broad-rules">${broad("chat", "All chats")} ${broad("channel", "All channels")}</div><div id="allowedResources" class="bucket">${rows("allow")}</div></section>
  <section class="guardrail-section"><h4>Denied destinations <span class="help" title="Exact denials always override exact or broad allowances in this policy.">ⓘ</span></h4><p class="muted">Use Deny from a search result to add an overriding exception.</p><div id="deniedResources" class="bucket">${rows("deny")}</div></section>`;
}

function policyView(record, isNew = false) {
  if (record?.error) return `<h2>${esc(record.name)}</h2><div class="banner error">${esc(record.error)}</div><div class="card"><p>${esc(record.file)}</p><pre>${esc(record.raw)}</pre><div class="actions"><button id="copyRaw">Copy YAML</button></div></div>`;
  const source = record?.policy || blankPolicy();
  const draft = structuredClone(source);
  draft.allow ||= {};
  draft.allow.chats ||= {};
  draft.allow.channels ||= {};
  draft.deny ||= {};
  draft.deny.chats ||= {};
  draft.deny.channels ||= {};
  const locked = Boolean(record?.locked);
  const identityName = state.context.username || state.context.profileName;
  return `${record?.lockReason ? `<div class="banner">${esc(record.lockReason)}</div>` : ""}<div id="message"></div>
  <section class="card"><h3>Policy name${locked ? '<span class="badge">export only</span>' : ""}</h3><p class="section-lead">A recognizable name for people reviewing the policy. It does not grant access.</p><input aria-label="Policy name" type="text" id="name" value="${esc(source.name)}" ${record && !isNew ? "disabled" : ""}></section>
  <section class="card"><h3>Applicability</h3><p class="section-lead">The absolute paths and globs governed by this policy.</p><label class="field-title" for="subjects">Governed paths <span class="help" title="The policy applies when the CLI starts from a matching path.">ⓘ</span></label><textarea id="subjects" rows="4">${esc(source.subject.paths.join("\n"))}</textarea></section>
  <section class="card"><h3>Guardrails</h3><p class="section-lead">Restrictions enforced whenever this policy applies.</p><section class="guardrail-section"><h4>Identity</h4><div class="identity-card"><span class="icon">🛡️</span><div><strong>${esc(identityName)}</strong><br><span>${esc(source.identity?.tenantId || "any tenant")} / ${esc(source.identity?.userId || "any user")}</span><p class="muted">This is enforced, not selected here. Commands from governed paths must use this tenant and user.</p></div></div></section><section class="guardrail-section"><h4>Find people, group chats, or channels</h4><label class="field-title" for="filter">Destination search <span class="help" title="Searches loaded destinations and the Teams people directory. Only existing chats can receive message permissions.">ⓘ</span></label><input type="text" id="filter" autocomplete="off" placeholder="Type a name such as Michael, a group, channel, or exact ID…"><div id="peopleResults" class="suggestions hidden"></div></section>${destinationSections(draft)}<section class="guardrail-section"><h4>Features</h4><label class="token-row"><input id="rawTokens" type="checkbox" ${source.allow?.rawTokenExport ? "checked" : ""}><span><strong>Allow raw token export <span class="help" title="Permits printing complete bearer tokens. Decoded claims do not require this permission.">ⓘ</span></strong><br><span class="muted">Keep disabled unless an external tool genuinely requires the complete bearer token.</span></span></label></section></section>
  <div class="actions">${locked ? '<button id="copyApply">Copy apply command</button>' : '<details class="save-menu"><summary class="primary">Save ▾</summary><div class="save-options"><button id="save">Save without activating</button><button id="activate">Save and activate…</button></div></details>'}<button id="copy">Copy YAML</button></div>`;
}

function collect(base) {
  const policy = structuredClone(base);
  policy.name = document.getElementById("name").value.trim();
  policy.active = Boolean(base.active);
  policy.subject.paths = document.getElementById("subjects").value.split("\n").map((value) => value.trim()).filter(Boolean);
  policy.allow = { chats: {}, channels: {}, rawTokenExport: Boolean(document.getElementById("rawTokens").checked) };
  policy.deny = { chats: {}, channels: {} };
  for (const kind of ["chat", "channel"]) {
    const actions = [...document.querySelectorAll(`.global-grant[data-kind="${kind}"]:checked`)].map((input) => input.dataset.action);
    if (actions.length) (kind === "chat" ? policy.allow.chats : policy.allow.channels)["*"] = actions;
  }
  document.querySelectorAll(".bucket-resource").forEach((row) => {
    const actions = normalizedActions(row.querySelector(".bucket-permission").value);
    const rules = row.dataset.mode === "deny" ? policy.deny : policy.allow;
    (row.dataset.kind === "chat" ? rules.chats : rules.channels)[row.dataset.id] = actions;
  });
  return policy;
}

function policyPermits(policy, resource, action) {
  const allowed = resource.kind === "chat" ? policy.allow?.chats : policy.allow?.channels;
  const denied = resource.kind === "chat" ? policy.deny?.chats : policy.deny?.channels;
  const isAllowed = allowed?.[resource.id]?.includes(action) || allowed?.["*"]?.includes(action);
  const isDenied = denied?.[resource.id]?.includes(action);
  return Boolean(isAllowed && !isDenied);
}

function signature(policy) { return JSON.stringify(policy); }

function activationPreview(candidate) {
  const policies = [...state.policies.filter((stored) => stored.applies && stored.policy?.active).map((stored) => stored.policy), candidate];
  let readable = 0;
  let postable = 0;
  for (const resource of state.resources) {
    if (policies.every((policy) => policyPermits(policy, resource, "read"))) readable += 1;
    if (policies.every((policy) => policyPermits(policy, resource, "post"))) postable += 1;
  }
  return `${readable} discovered destination${readable === 1 ? "" : "s"} readable; ${postable} postable`;
}

async function copy(text) { await navigator.clipboard.writeText(text).catch(() => prompt("Copy this text", text)); }

function monitorChanges(base) {
  initialSignature = signature(collect(base));
  document.querySelectorAll("input,textarea,select").forEach((element) => {
    const update = () => { dirty = signature(collect(base)) !== initialSignature; };
    element.addEventListener("input", update);
    element.addEventListener("change", update);
  });
}

function wire(record, isNew) {
  if (record?.error) { document.getElementById("copyRaw").onclick = () => copy(record.raw); return; }
  const base = record?.policy || blankPolicy();
  const filter = document.getElementById("filter");
  const peopleResults = document.getElementById("peopleResults");
  let searchSequence = 0;
  let searchTimer = null;
  const updateDirty = () => { dirty = signature(collect(base)) !== initialSignature; };
  const wireBucketRow = (row) => {
    const select = row.querySelector(".bucket-permission");
    select.onchange = () => {
      select.className = `bucket-permission ${select.value.includes("post") ? "post-access" : "read-access"}`;
      updateDirty();
    };
    row.querySelector(".remove-rule").onclick = () => { row.remove(); updateDirty(); };
  };
  document.querySelectorAll(".bucket-resource").forEach(wireBucketRow);
  const destinationSuggestion = (resource) => `<div class="suggestion" data-kind="${resource.kind}" data-id="${esc(resource.id)}"><span><span class="kind-badge">${esc(destinationType(resource))}</span> <strong>${esc(resource.label)}</strong><br><small>${esc(resource.detail)} · <code>${esc(resource.id)}</code>${resource.hidden ? " · hidden" : ""}${resource.disabled ? " · disabled" : ""}</small></span><span class="suggestion-actions"><select aria-label="Access for ${esc(resource.label)}" class="suggestion-permission read-access">${permissionOptions(["read"])}</select><button type="button" class="allow-result" data-mode="allow">Allow</button><button type="button" class="deny-result" data-mode="deny">Deny</button></span></div>`;
  const personSuggestion = (person) => {
    const self = person.id === state.context.userId || person.mri?.includes(state.context.userId);
    const fields = [person.email, person.jobTitle, `User ID: ${person.id}`, person.mri ? `MRI: ${person.mri}` : null].filter(Boolean);
    if (person.chatId) {
      const resource = state.resources.find((candidate) => candidate.kind === "chat" && candidate.id === person.chatId);
      if (resource) return destinationSuggestion({ ...resource, label: person.displayName || resource.label, detail: fields.join(" · ") });
    }
    return `<div class="suggestion directory-only"><span><span class="kind-badge">Directory user</span> <strong>${esc(person.displayName || person.email || person.id)}</strong><br><small>${esc(fields.join(" · "))}</small></span><span class="suggestion-actions"><select disabled><option>Read</option></select><button type="button" disabled title="A policy needs an existing chat ID">Allow</button><span class="muted">${self ? "Current identity—not a message destination" : "Start a one-to-one chat in Teams first"}</span></span></div>`;
  };
  const wireSuggestions = () => {
    peopleResults.querySelectorAll(".suggestion-permission").forEach((select) => {
      select.onchange = () => { select.className = `suggestion-permission ${select.value.includes("post") ? "post-access" : "read-access"}`; };
    });
    peopleResults.querySelectorAll("button[data-mode]").forEach((button) => {
      button.onclick = () => {
        const suggestion = button.closest(".suggestion");
        const mode = button.dataset.mode;
        const resource = state.resources.find((candidate) => candidate.kind === suggestion.dataset.kind && candidate.id === suggestion.dataset.id);
        if (!resource) return;
        document.querySelectorAll(`.bucket-resource[data-kind="${resource.kind}"]`).forEach((row) => { if (row.dataset.id === resource.id) row.remove(); });
        const container = document.getElementById(mode === "allow" ? "allowedResources" : "deniedResources");
        container.insertAdjacentHTML("beforeend", bucketRow(resource, normalizedActions(suggestion.querySelector(".suggestion-permission").value), mode));
        const row = container.lastElementChild;
        wireBucketRow(row);
        updateDirty();
        row.scrollIntoView({ block: "center", behavior: "smooth" });
      };
    });
  };
  const renderResults = (query, people = []) => {
    const local = state.resources.filter((resource) => [resource.label, resource.detail, resource.id, destinationType(resource)].join(" ").toLowerCase().includes(query));
    const matchedChatIds = new Set(people.map((person) => person.chatId).filter(Boolean));
    const html = [...people.map(personSuggestion), ...local.filter((resource) => !matchedChatIds.has(resource.id)).map(destinationSuggestion)].join("");
    if (!html) {
      peopleResults.innerHTML = "";
      peopleResults.classList.add("hidden");
      return;
    }
    peopleResults.classList.remove("hidden");
    peopleResults.innerHTML = html;
    wireSuggestions();
  };
  filter.oninput = () => {
    const query = filter.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    if (query.length < 2) {
      searchSequence += 1;
      peopleResults.innerHTML = "";
      peopleResults.classList.add("hidden");
      return;
    }
    renderResults(query);
    const sequence = ++searchSequence;
    searchTimer = setTimeout(async () => {
      try {
        const result = await api(`/api/people?q=${encodeURIComponent(query)}`);
        if (sequence === searchSequence) renderResults(query, result.people || []);
      } catch (error) {
        if (sequence === searchSequence) {
          peopleResults.classList.remove("hidden");
          peopleResults.innerHTML = `<div class="suggestion muted">Directory lookup unavailable: ${esc(error.message)}</div>`;
        }
      }
    }, 300);
  };
  document.getElementById("copy").onclick = async () => copy((await api("/api/render", { method: "POST", body: JSON.stringify({ policy: collect(base) }) })).yaml);
  if (record?.locked) {
    document.getElementById("copyApply").onclick = async () => copy((await api("/api/export", { method: "POST", body: JSON.stringify({ policy: collect(base), originalName: record.name }) })).command);
    monitorChanges(base);
    return;
  }
  const save = async (mode) => {
    const policy = collect(base);
    if (mode === "activate" && !confirm(`Activate this policy? Effective intersection: ${activationPreview(policy)}. It will immediately enforce and become export-only.`)) return;
    try {
      const result = await api("/api/save", { method: "POST", body: JSON.stringify({ policy, originalName: record && !isNew ? record.name : null, expectedHash: record?.hash || null, mode }) });
      dirty = false;
      if (mode === "activate" && result.protection) document.getElementById("offline").innerHTML = `Policy activated. Editing has ended. Additional protection: <code>${esc(result.protection)}</code>. Restart with: <code>${esc(reconnectCommand)}</code>`;
      if (mode === "draft") { selected = policy.name; await load(); }
    } catch (error) {
      const target = document.getElementById("message");
      target.innerHTML = `<div class="banner error">${esc(error.message)}</div>` + (error.data?.yaml ? `<button id="copyFailed">Copy YAML</button>${error.data.command ? '<button id="copyCommand">Copy replacement command</button>' : ""}` : "");
      if (error.data?.yaml) document.getElementById("copyFailed").onclick = () => copy(error.data.yaml);
      if (error.data?.command) document.getElementById("copyCommand").onclick = () => copy(error.data.command);
    }
  };
  document.getElementById("save").onclick = () => save("draft");
  document.getElementById("activate").onclick = () => save("activate");
  monitorChanges(base);
}

function render() {
  renderTabs();
  const content = document.getElementById("content");
  if (selected === "effective") { content.innerHTML = effectiveView(); return; }
  let record = null;
  let isNew = false;
  if (selected === "new") isNew = true;
  else record = state.policies.find((policy) => policy.name === selected);
  content.innerHTML = policyView(record, isNew);
  wire(record, isNew);
}

claim().catch((error) => {
  document.getElementById("content").innerHTML = `<div class="banner error">${esc(error.message)}</div>`;
  document.getElementById("connection").textContent = "● unavailable";
});
