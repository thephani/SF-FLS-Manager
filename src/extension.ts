import * as vscode from 'vscode';
import * as path from 'path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

interface FlsConfigEntry {
  field: string;
  readable: boolean;
  editable: boolean;
  // When true, existing field permissions will be removed
  // instead of added/updated.
  remove?: boolean;
}

interface FlsConfig {
  fields: FlsConfigEntry[];
  profiles?: string[];
  permissionSets?: string[];
}

export function activate(context: vscode.ExtensionContext) {
  const openBuilder = vscode.commands.registerCommand(
    'salesforce.openFlsConfigBuilder',
    async () => {
      const workspaceFolder = getPrimaryWorkspaceFolder();
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('SF-FLS-MANAGER: No workspace folder open.');
        return;
      }

      const profileFiles = await vscode.workspace.findFiles(
        '**/force-app/main/default/profiles/**/*.profile-meta.xml'
      );
      const availableProfiles = profileFiles.map((uri) => profileNameFromUri(uri));

      const permsetFiles = await vscode.workspace.findFiles(
        '**/force-app/main/default/permissionsets/**/*.permissionset-meta.xml'
      );
      const availablePermissionSets = permsetFiles.map((uri) => permissionSetNameFromUri(uri));

      const panel = vscode.window.createWebviewPanel(
        'sfFlsConfigBuilder',
        'Salesforce FLS Commit Manager',
        vscode.ViewColumn.One,
        {
          enableScripts: true
        }
      );

      panel.webview.html = getWebviewContent();

      const configUri = vscode.Uri.joinPath(workspaceFolder.uri, 'fls.config.json');

      // When webview is ready, send existing config if any.
      panel.webview.onDidReceiveMessage(
        async (message) => {
          if (message.type === 'ready') {
            try {
              let fields: FlsConfigEntry[] = [];
              let selectedProfiles: string[] = [];
              let selectedPermissionSets: string[] = [];

              const bytes = await vscode.workspace.fs.readFile(configUri);
              const text = Buffer.from(bytes).toString('utf8');
              const parsed = JSON.parse(text);
              if (Array.isArray(parsed)) {
                fields = parsed as FlsConfigEntry[];
              } else if (parsed && typeof parsed === 'object') {
                const obj = parsed as FlsConfig;
                if (Array.isArray(obj.fields)) {
                  fields = obj.fields;
                }
              }

              panel.webview.postMessage({
                type: 'load',
                data: {
                  fields,
                  selectedProfiles,
                  selectedPermissionSets,
                  availableProfiles,
                  availablePermissionSets
                }
              });
            } catch {
              // Missing or invalid file: start with empty data.
              panel.webview.postMessage({
                type: 'load',
                data: {
                  fields: [],
                  selectedProfiles: [],
                  selectedPermissionSets: [],
                  availableProfiles,
                  availablePermissionSets
                }
              });
            }
          } else if (message.type === 'save') {
            const data = message.data || {};
            const fields: FlsConfigEntry[] = Array.isArray(data.fields) ? data.fields : [];
            const selectedProfiles: string[] = Array.isArray(data.selectedProfiles)
              ? data.selectedProfiles
              : [];
            const selectedPermissionSets: string[] = Array.isArray(data.selectedPermissionSets)
              ? data.selectedPermissionSets
              : [];
            try {
              const toSave: FlsConfig = {
                fields,
                profiles: selectedProfiles,
                permissionSets: selectedPermissionSets
              };
              const json = JSON.stringify(toSave, null, 2);
              await vscode.workspace.fs.writeFile(configUri, Buffer.from(json, 'utf8'));
              vscode.window.showInformationMessage('SF-FLS-MANAGER: fls.config.json saved.');
            } catch (error: any) {
              vscode.window.showErrorMessage(
                `SF-FLS-MANAGER: Failed to save fls.config.json - ${error?.message ?? String(
                  error
                )}`
              );
            }
          } else if (message.type === 'runApply') {
            const data = message.data || {};
            const fields: FlsConfigEntry[] = Array.isArray(data.fields) ? data.fields : [];
            const selectedProfiles: string[] = Array.isArray(data.selectedProfiles)
              ? data.selectedProfiles
              : [];
            const selectedPermissionSets: string[] = Array.isArray(data.selectedPermissionSets)
              ? data.selectedPermissionSets
              : [];

            if (!fields.length) {
              vscode.window.showWarningMessage(
                'SF-FLS-MANAGER: No fields defined. Add at least one field before running.'
              );
              return;
            }

            const effectiveConfig: FlsConfig = {
              fields,
              profiles: selectedProfiles,
              permissionSets: selectedPermissionSets
            };

            // Persist the latest configuration then apply.
            try {
              const json = JSON.stringify(effectiveConfig, null, 2);
              await vscode.workspace.fs.writeFile(configUri, Buffer.from(json, 'utf8'));
            } catch (error: any) {
              vscode.window.showErrorMessage(
                `SF-FLS-MANAGER: Failed to save fls.config.json before apply - ${
                  error?.message ?? String(error)
                }`
              );
              return;
            }

            await applyFlsToProfiles(workspaceFolder, effectiveConfig);
          }
        },
        undefined,
        context.subscriptions
      );
    }
  );

  context.subscriptions.push(openBuilder);
}

export function deactivate() {
  // No-op
}

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0];
}

function profileNameFromUri(uri: vscode.Uri): string {
  const base = path.basename(uri.fsPath);
  return base.replace(/\.profile-meta\.xml$/i, '');
}

function permissionSetNameFromUri(uri: vscode.Uri): string {
  const base = path.basename(uri.fsPath);
  return base.replace(/\.permissionset-meta\.xml$/i, '');
}

async function applyFlsToProfiles(
  workspaceFolder: vscode.WorkspaceFolder,
  config: FlsConfig
): Promise<void> {
  const fieldsConfig = Array.isArray(config.fields) ? config.fields : [];
  if (fieldsConfig.length === 0) {
    vscode.window.showWarningMessage('SF-FLS-MANAGER: No fields configured. Nothing to apply.');
    return;
  }

  const allProfileFiles = await vscode.workspace.findFiles(
    '**/force-app/main/default/profiles/**/*.profile-meta.xml'
  );
  const allPermsetFiles = await vscode.workspace.findFiles(
    '**/force-app/main/default/permissionsets/**/*.permissionset-meta.xml'
  );

  if (allProfileFiles.length === 0 && allPermsetFiles.length === 0) {
    vscode.window.showWarningMessage(
      'SF-FLS-MANAGER: No profile or permission set XML files found under force-app/main/default.'
    );
    return;
  }

  let targetProfileFiles = allProfileFiles;
  if (config.profiles && config.profiles.length > 0) {
    const wanted = new Set(config.profiles);
    const narrowed = allProfileFiles.filter((uri) => wanted.has(profileNameFromUri(uri)));
    if (narrowed.length > 0) {
      targetProfileFiles = narrowed;
    }
  }

  let targetPermsetFiles = allPermsetFiles;
  if (config.permissionSets && config.permissionSets.length > 0) {
    const wantedPermsets = new Set(config.permissionSets);
    const narrowedPermsets = allPermsetFiles.filter((uri) =>
      wantedPermsets.has(permissionSetNameFromUri(uri))
    );
    if (narrowedPermsets.length > 0) {
      targetPermsetFiles = narrowedPermsets;
    }
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true
  });
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    suppressEmptyNode: false
  });

  let profilesUpdated = 0;
  let permissionSetsUpdated = 0;

  for (const uri of targetProfileFiles) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const xmlText = Buffer.from(bytes).toString('utf8');
      const parsed = parser.parse(xmlText);

      const profileNode: any = parsed.Profile ?? parsed;

      const changed = updateFieldPermissionsObject(profileNode, fieldsConfig);
      if (!changed) {
        // No effective FLS changes for this profile; skip writing to avoid noise.
        continue;
      }

      if (parsed.Profile) {
        parsed.Profile = profileNode;
      }

      const updatedXml = builder.build(parsed);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(updatedXml, 'utf8'));
      profilesUpdated += 1;
    } catch (error: any) {
      vscode.window.showErrorMessage(
        `SF-FLS-MANAGER: Failed to update profile ${vscode.workspace.asRelativePath(
          uri,
          false
        )} - ${error?.message ?? String(error)}`
      );
    }
  }

  for (const uri of targetPermsetFiles) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const xmlText = Buffer.from(bytes).toString('utf8');
      const parsed = parser.parse(xmlText);

      const permsetNode: any = parsed.PermissionSet ?? parsed;

      const changed = updateFieldPermissionsObject(permsetNode, fieldsConfig);
      if (!changed) {
        // No effective FLS changes for this permission set; skip writing.
        continue;
      }

      if (parsed.PermissionSet) {
        parsed.PermissionSet = permsetNode;
      }

      const updatedXml = builder.build(parsed);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(updatedXml, 'utf8'));
      permissionSetsUpdated += 1;
    } catch (error: any) {
      vscode.window.showErrorMessage(
        `SF-FLS-MANAGER: Failed to update permission set ${vscode.workspace.asRelativePath(
          uri,
          false
        )} - ${error?.message ?? String(error)}`
      );
    }
  }

  if (profilesUpdated === 0 && permissionSetsUpdated === 0) {
    vscode.window.showWarningMessage('SF-FLS-MANAGER: No profiles or permission sets were updated.');
    return;
  }

  const fieldsPerTarget = fieldsConfig.length;
  const totalTargets = profilesUpdated + permissionSetsUpdated;
  const totalFieldOps = totalTargets * fieldsPerTarget;
  vscode.window.showInformationMessage(
    `SF-FLS-MANAGER: Updated ${profilesUpdated} profile(s) and ${permissionSetsUpdated} permission set(s), ${fieldsPerTarget} field(s) each (${totalFieldOps} field updates).`
  );
}

function updateFieldPermissionsObject(node: any, fieldsConfig: FlsConfigEntry[]): boolean {
  let fieldPermissions: any[] = node.fieldPermissions ?? [];
  if (!Array.isArray(fieldPermissions)) {
    fieldPermissions = [fieldPermissions];
  }

  let changed = false;

  for (const entry of fieldsConfig) {
    if (!entry.field) {
      continue;
    }
    const existingIndex = fieldPermissions.findIndex((fp) => fp.field === entry.field);

    if (entry.remove) {
      if (existingIndex !== -1) {
        fieldPermissions.splice(existingIndex, 1);
        changed = true;
      }
      continue;
    }

    let perm = existingIndex !== -1 ? fieldPermissions[existingIndex] : {};
    const nextField = entry.field;
    const nextReadable = entry.readable ? 'true' : 'false';
    const nextEditable = entry.editable ? 'true' : 'false';

    const prevField = perm.field;
    const prevReadable = perm.readable;
    const prevEditable = perm.editable;

    if (
      prevField !== nextField ||
      prevReadable !== nextReadable ||
      prevEditable !== nextEditable
    ) {
      perm.field = nextField;
      perm.readable = nextReadable;
      perm.editable = nextEditable;
      changed = true;
    }

    if (existingIndex === -1) {
      fieldPermissions.push(perm);
      changed = true;
    }
  }

  node.fieldPermissions = fieldPermissions;
  return changed;
}

function getWebviewContent(): string {
  const nonce = Date.now().toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Salesforce FLS Commit Manager</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --bg-elevated: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --bg-elevated-soft: var(--vscode-editor-background);
    --border-subtle: var(--vscode-panel-border, #3c3c3c);
    --text: var(--vscode-foreground);
    --text-muted: var(--vscode-descriptionForeground, #808080);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-soft: var(--vscode-button-secondaryBackground, rgba(14, 99, 156, 0.18));
    --accent-strong: var(--vscode-button-hoverBackground, #007acc);
    --danger: var(--vscode-inputValidation-errorBorder, #c74e39);
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background-color: var(--bg);
    color: var(--text);
    margin: 16px;
  }

  h1 {
    margin-bottom: 4px;
  }

  p.description {
    color: var(--text-muted);
    margin-top: 0;
    margin-bottom: 16px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 4px;
  }

  th, td {
    border: 1px solid var(--border-subtle);
    padding: 4px 6px;
    font-size: 12px;
  }

  th {
    background: linear-gradient(
      to bottom,
      var(--bg-elevated-soft),
      var(--bg-elevated)
    );
  }

  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    background-color: var(--bg-elevated);
    border: 1px solid #3f3f46;
    color: var(--text);
    padding: 2px 4px;
  }

  button {
    margin-right: 6px;
    padding: 4px 12px;
    font-size: 12px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background-color: var(--vscode-button-secondaryBackground, var(--bg-elevated));
    color: var(--text);
    cursor: pointer;
    transition: background-color 0.12s ease-out, border-color 0.12s ease-out,
      transform 0.06s ease-out;
  }

  button:hover {
    background-color: var(--vscode-button-secondaryHoverBackground, var(--bg-elevated-soft));
    border-color: var(--border-subtle);
  }

  button:active {
    transform: translateY(1px);
  }

  .accordion-section {
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  }

  .accordion-header {
    width: 100%;
    text-align: left;
    background: linear-gradient(
      to right,
      var(--bg-elevated),
      var(--bg-elevated-soft)
    );
    color: var(--text);
    border: none;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .accordion-panel {
    padding: 8px 10px;
    display: block;
    background-color: var(--bg-elevated-soft);
  }

  .section-title {
    font-weight: 600;
    margin-bottom: 4px;
  }

  .hint {
    font-size: 11px;
    color: var(--text-muted);
  }

  .search-input {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 8px;
    padding: 6px 8px;
    background-color: var(--vscode-input-background, var(--bg-elevated));
    border: 1px solid var(--vscode-input-border, var(--border-subtle));
    color: var(--text);
    font-size: 13px;
    border-radius: 4px;
  }

  .tables-row {
    display: flex;
    gap: 12px;
  }

  .table-column {
    flex: 1;
  }

  .checkbox-col {
    width: 64px;
    text-align: center;
  }

  .name-col {
    width: 60%;
  }

  .icon-button {
    cursor: pointer;
  }

  .table-wrapper {
    max-height: 360px; /* ~15 rows */
    overflow-y: auto;
  }

  .table-wrapper thead th {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .table-wrapper tbody tr:nth-child(even) {
    background-color: rgba(255, 255, 255, 0.01);
  }

  .table-wrapper tbody tr:hover {
    background-color: rgba(255, 255, 255, 0.03);
  }

  .primary-button {
    background-color: var(--accent);
    border-color: var(--accent-strong);
    color: #ffffff;
    font-weight: 600;
  }

  .primary-button:hover {
    background-color: var(--accent-strong);
    border-color: var(--accent-strong);
  }

  .pill-label {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    background-color: var(--accent-soft);
    color: var(--accent-strong);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
</head>
<body>
<h1>Salesforce FLS Commit Manager</h1>
<p class="description">Prepare and commit field-level security changes to your Salesforce metadata.</p>

<div class="accordion-section">
  <button class="accordion-header" data-target="fields-panel">
    <span class="pill-label">Step 1</span>
    &nbsp;Add / Remove Fields
  </button>
  <div class="accordion-panel" id="fields-panel">
    <div class="tables-row">
      <div class="table-column">
        <p class="hint">Define which fields and access levels you want to apply.</p>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th class="checkbox-col">Row</th>
                <th class="checkbox-col">Delete</th>
                <th class="name-col">Field API Name</th>
                <th class="checkbox-col">Readable</th>
                <th class="checkbox-col">Editable</th>
              </tr>
            </thead>
            <tbody id="field-rows"></tbody>
          </table>
        </div>
        <p>
          <button id="addRow">Add Field</button>
        </p>
      </div>
      <div class="table-column">
        <p class="section-title">Preview of Selections</p>
        <p class="hint">Shows currently selected profiles and permission sets from Step 2.</p>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Profiles</th>
                <th>Permission Sets</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td id="preview-profiles"></td>
                <td id="preview-permsets"></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="accordion-section">
  <button class="accordion-header" data-target="profiles-panel">
    <span class="pill-label">Step 2</span>
    &nbsp;Select Profiles & Permission Sets
  </button>
  <div class="accordion-panel" id="profiles-panel">
    <p class="hint">Select which profiles and permission sets should receive the configured field permissions.</p>
    <input id="searchInput" class="search-input" type="text" placeholder="Search profiles and permission sets..." />
    <p class="hint">Start typing to filter both lists by name.</p>
    <p>
      <button id="runApply" class="primary-button">Run FLS Commit</button>
    </p>
    <div class="tables-row">
      <div class="table-column">
        <div class="section-title">Profiles</div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th class="checkbox-col"><input id="profilesCheckAll" type="checkbox" /></th>
                <th class="name-col">Name</th>
              </tr>
            </thead>
            <tbody id="profile-rows"></tbody>
          </table>
        </div>
      </div>
      <div class="table-column">
        <div class="section-title">Permission Sets</div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th class="checkbox-col"><input id="permsetsCheckAll" type="checkbox" /></th>
                <th class="name-col">Name</th>
              </tr>
            </thead>
            <tbody id="permset-rows"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  const fieldRowsEl = document.getElementById('field-rows');
  const profileRowsEl = document.getElementById('profile-rows');
  const permsetRowsEl = document.getElementById('permset-rows');
  const previewProfilesEl = document.getElementById('preview-profiles');
  const previewPermsetsEl = document.getElementById('preview-permsets');
  const searchInput = document.getElementById('searchInput');
  const profilesCheckAll = document.getElementById('profilesCheckAll');
  const permsetsCheckAll = document.getElementById('permsetsCheckAll');
  const runApplyBtn = document.getElementById('runApply');
  const addRowBtn = document.getElementById('addRow');

  let availableProfiles = [];
  let availablePermissionSets = [];

  function createFieldRow(entry) {
    const tr = document.createElement('tr');

    const delTd = document.createElement('td');
    delTd.className = 'checkbox-col';
    const delButton = document.createElement('button');
    delButton.type = 'button';
    delButton.textContent = '🗑';
    delButton.title = 'Delete row';
    delButton.className = 'icon-button';
    delButton.style.padding = '2px 6px';
    delButton.addEventListener('click', () => {
      fieldRowsEl.removeChild(tr);
      if (!fieldRowsEl.children.length) {
        createFieldRow({ field: '', readable: false, editable: false });
      }
    });
    delTd.appendChild(delButton);
    tr.appendChild(delTd);

    const deleteFlagTd = document.createElement('td');
    deleteFlagTd.className = 'checkbox-col';
    const deleteFlagCheckbox = document.createElement('input');
    deleteFlagCheckbox.type = 'checkbox';
    deleteFlagCheckbox.checked = !!entry.remove;
    deleteFlagTd.appendChild(deleteFlagCheckbox);
    tr.appendChild(deleteFlagTd);

    const fieldTd = document.createElement('td');
    fieldTd.className = 'name-col';
    const fieldInput = document.createElement('input');
    fieldInput.type = 'text';
    fieldInput.value = entry.field || '';
    fieldInput.placeholder = 'e.g. Account.Name__c';
    fieldTd.appendChild(fieldInput);
    tr.appendChild(fieldTd);

    const readableTd = document.createElement('td');
    readableTd.className = 'checkbox-col';
    const readableInput = document.createElement('input');
    readableInput.type = 'checkbox';
    readableInput.checked = !!entry.readable;
    readableTd.appendChild(readableInput);
    tr.appendChild(readableTd);

    const editableTd = document.createElement('td');
    editableTd.className = 'checkbox-col';
    const editableInput = document.createElement('input');
    editableInput.type = 'checkbox';
    editableInput.checked = !!entry.editable;
    editableTd.appendChild(editableInput);
    tr.appendChild(editableTd);

    editableInput.addEventListener('change', () => {
      if (editableInput.checked) {
        readableInput.checked = true;
      }
    });

    fieldRowsEl.appendChild(tr);
  }

  function renderFieldRows(fields) {
    fieldRowsEl.innerHTML = '';
    if (Array.isArray(fields) && fields.length) {
      for (const entry of fields) {
        createFieldRow(entry);
      }
    }
    if (!fieldRowsEl.children.length) {
      createFieldRow({ field: '', readable: false, editable: false });
    }
  }

  function renderProfileRows(available, selected) {
    profileRowsEl.innerHTML = '';
    availableProfiles = Array.isArray(available) ? available : [];
    const selectedSet = new Set(Array.isArray(selected) ? selected : []);

    if (!availableProfiles.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2;
      td.textContent = 'No profiles found.';
      profileRowsEl.appendChild(tr);
      tr.appendChild(td);
      return;
    }

    for (const profilePath of availableProfiles) {
      const tr = document.createElement('tr');
      tr.dataset.profileName = profilePath;

      const includeTd = document.createElement('td');
      includeTd.className = 'checkbox-col';
      const includeCheckbox = document.createElement('input');
      includeCheckbox.type = 'checkbox';
      includeCheckbox.checked = selectedSet.has(profilePath);
      includeTd.appendChild(includeCheckbox);
      tr.appendChild(includeTd);

      const nameTd = document.createElement('td');
      nameTd.className = 'name-col';
      const span = document.createElement('span');
      span.textContent = profilePath;
      nameTd.appendChild(span);
      tr.appendChild(nameTd);

      profileRowsEl.appendChild(tr);
    }
  }

  function renderPermissionSetRows(available, selected) {
    permsetRowsEl.innerHTML = '';
    availablePermissionSets = Array.isArray(available) ? available : [];
    const selectedSet = new Set(Array.isArray(selected) ? selected : []);

    if (!availablePermissionSets.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2;
      td.textContent = 'No permission sets found.';
      permsetRowsEl.appendChild(tr);
      tr.appendChild(td);
      return;
    }

    for (const permsetName of availablePermissionSets) {
      const tr = document.createElement('tr');
      tr.dataset.permsetName = permsetName;

      const includeTd = document.createElement('td');
      includeTd.className = 'checkbox-col';
      const includeCheckbox = document.createElement('input');
      includeCheckbox.type = 'checkbox';
      includeCheckbox.checked = selectedSet.has(permsetName);
      includeTd.appendChild(includeCheckbox);
      tr.appendChild(includeTd);

      const nameTd = document.createElement('td');
      nameTd.className = 'name-col';
      const span = document.createElement('span');
      span.textContent = permsetName;
      nameTd.appendChild(span);
      tr.appendChild(nameTd);

      permsetRowsEl.appendChild(tr);
    }
  }

  function collectFieldData() {
    const entries = [];
    for (const tr of Array.from(fieldRowsEl.children)) {
      const deleteFlag = tr.querySelector('td:nth-child(2) input[type="checkbox"]');
      const field = tr.querySelector('td:nth-child(3) input[type="text"]');
      const readable = tr.querySelector('td:nth-child(4) input[type="checkbox"]');
      const editable = tr.querySelector('td:nth-child(5) input[type="checkbox"]');
      if (!field.value.trim()) {
        continue;
      }
      entries.push({
        field: field.value.trim(),
        readable: !!(readable && readable.checked),
        editable: !!(editable && editable.checked),
        remove: !!(deleteFlag && deleteFlag.checked)
      });
    }
    return entries;
  }

  function collectSelectedProfiles() {
    const selected = [];
    for (const tr of Array.from(profileRowsEl.children)) {
      const checkbox = tr.querySelector('input[type="checkbox"]');
      const profileName = tr.dataset.profileName;
      if (checkbox && checkbox.checked && profileName) {
        selected.push(profileName);
      }
    }
    return selected;
  }

  function collectSelectedPermissionSets() {
    const selected = [];
    for (const tr of Array.from(permsetRowsEl.children)) {
      const checkbox = tr.querySelector('input[type="checkbox"]');
      const permsetName = tr.dataset.permsetName;
      if (checkbox && checkbox.checked && permsetName) {
        selected.push(permsetName);
      }
    }
    return selected;
  }

  function renderPreviewLists(profiles, permsets) {
    if (previewProfilesEl) {
      previewProfilesEl.innerHTML = '';
      if (profiles.length) {
        for (const name of profiles) {
          const div = document.createElement('div');
          div.textContent = name;
          previewProfilesEl.appendChild(div);
        }
      }
    }

    if (previewPermsetsEl) {
      previewPermsetsEl.innerHTML = '';
      if (permsets.length) {
        for (const name of permsets) {
          const div = document.createElement('div');
          div.textContent = name;
          previewPermsetsEl.appendChild(div);
        }
      }
    }
  }

  function refreshPreview() {
    const profiles = collectSelectedProfiles();
    const permsets = collectSelectedPermissionSets();
    renderPreviewLists(profiles, permsets);
  }

  addRowBtn.addEventListener('click', () => {
    createFieldRow({ field: '', readable: false, editable: false });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'load') {
      const data = message.data || {};
      renderFieldRows(data.fields || []);
      renderProfileRows(data.availableProfiles || [], data.selectedProfiles || []);
      renderPermissionSetRows(
        data.availablePermissionSets || [],
        data.selectedPermissionSets || []
      );
      applySearchFilter(searchInput ? searchInput.value || '' : '');
    }
  });

  function applySearchFilter(term) {
    const value = (term || '').toLowerCase();

    function filterRows(tbody, dataKey) {
      for (const tr of Array.from(tbody.children)) {
        const name = (tr.dataset[dataKey] || '').toLowerCase();
        if (!name) {
          tr.style.display = value ? 'none' : '';
          continue;
        }
        tr.style.display = !value || name.includes(value) ? '' : 'none';
      }
    }

    filterRows(profileRowsEl, 'profileName');
    filterRows(permsetRowsEl, 'permsetName');
  }

  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      applySearchFilter(event.target.value);
    });
  }

  function setAllInTbody(tbody, dataKey, checked) {
    for (const tr of Array.from(tbody.children)) {
      const name = tr.dataset[dataKey];
      if (!name) {
        continue;
      }
      const checkbox = tr.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = checked;
      }
    }
  }

  if (profilesCheckAll) {
    profilesCheckAll.addEventListener('change', (event) => {
      setAllInTbody(profileRowsEl, 'profileName', event.target.checked);
      refreshPreview();
    });
  }

  if (permsetsCheckAll) {
    permsetsCheckAll.addEventListener('change', (event) => {
      setAllInTbody(permsetRowsEl, 'permsetName', event.target.checked);
      refreshPreview();
    });
  }

  if (runApplyBtn) {
    runApplyBtn.addEventListener('click', () => {
      const fields = collectFieldData();
      const selectedProfiles = collectSelectedProfiles();
      const selectedPermissionSets = collectSelectedPermissionSets();
      vscode.postMessage({
        type: 'runApply',
        data: { fields, selectedProfiles, selectedPermissionSets }
      });
    });
  }

  profileRowsEl.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.type === 'checkbox') {
      refreshPreview();
    }
  });

  permsetRowsEl.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.type === 'checkbox') {
      refreshPreview();
    }
  });

  document.querySelectorAll('.accordion-header').forEach((button) => {
    button.addEventListener('click', () => {
      const targetId = button.getAttribute('data-target');
      if (!targetId) {
        return;
      }
      const panel = document.getElementById(targetId);
      if (!panel) {
        return;
      }
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'block' : 'none';
    });
  });

  // Notify extension that webview is ready
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
