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

      const profileFiles = await findWorkspaceFiles(
        workspaceFolder,
        '**/force-app/main/default/profiles/**/*.profile-meta.xml'
      );
      const availableProfiles = uniqueSortedNames(
        profileFiles.map((uri) => profileNameFromUri(uri))
      );

      const permsetFiles = await findWorkspaceFiles(
        workspaceFolder,
        '**/force-app/main/default/permissionsets/**/*.permissionset-meta.xml'
      );
      const availablePermissionSets = uniqueSortedNames(
        permsetFiles.map((uri) => permissionSetNameFromUri(uri))
      );

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
                if (Array.isArray(obj.profiles)) {
                  selectedProfiles = obj.profiles;
                }
                if (Array.isArray(obj.permissionSets)) {
                  selectedPermissionSets = obj.permissionSets;
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

function findWorkspaceFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  pattern: string
): Thenable<vscode.Uri[]> {
  return vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, pattern));
}

function uniqueSortedNames(names: string[]): string[] {
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
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

  const allProfileFiles = await findWorkspaceFiles(
    workspaceFolder,
    '**/force-app/main/default/profiles/**/*.profile-meta.xml'
  );
  const allPermsetFiles = await findWorkspaceFiles(
    workspaceFolder,
    '**/force-app/main/default/permissionsets/**/*.permissionset-meta.xml'
  );

  if (allProfileFiles.length === 0 && allPermsetFiles.length === 0) {
    vscode.window.showWarningMessage(
      'SF-FLS-MANAGER: No profile or permission set XML files found under force-app/main/default.'
    );
    return;
  }

  const selectedProfiles = Array.isArray(config.profiles) ? config.profiles : [];
  const selectedPermissionSets = Array.isArray(config.permissionSets) ? config.permissionSets : [];

  const wantedProfiles = new Set(selectedProfiles);
  const targetProfileFiles = allProfileFiles.filter((uri) =>
    wantedProfiles.has(profileNameFromUri(uri))
  );

  const wantedPermsets = new Set(selectedPermissionSets);
  const targetPermsetFiles = allPermsetFiles.filter((uri) =>
    wantedPermsets.has(permissionSetNameFromUri(uri))
  );

  if (targetProfileFiles.length === 0 && targetPermsetFiles.length === 0) {
    vscode.window.showWarningMessage(
      'SF-FLS-MANAGER: No profiles or permission sets selected. Check at least one target before running.'
    );
    return;
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
    --bg-elevated-soft: var(--vscode-input-background, var(--vscode-editor-background));
    --bg-hover: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.08));
    --bg-active: var(--vscode-list-activeSelectionBackground, rgba(14, 99, 156, 0.22));
    --border-subtle: var(--vscode-panel-border, #3c3c3c);
    --border-strong: var(--vscode-focusBorder, #007fd4);
    --text: var(--vscode-foreground);
    --text-muted: var(--vscode-descriptionForeground, #808080);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-soft: var(--vscode-badge-background, rgba(14, 99, 156, 0.18));
    --accent-strong: var(--vscode-button-hoverBackground, #007acc);
    --danger: var(--vscode-inputValidation-errorBorder, #c74e39);
    --danger-bg: var(--vscode-inputValidation-errorBackground, rgba(199, 78, 57, 0.12));
    --warning: var(--vscode-editorWarning-foreground, #cca700);
  }

  * {
    box-sizing: border-box;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background-color: var(--bg);
    color: var(--text);
    margin: 0;
    font-size: 13px;
  }

  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .top-bar,
  .command-bar {
    position: sticky;
    z-index: 5;
    background-color: var(--bg);
    border-bottom: 1px solid var(--border-subtle);
  }

  .top-bar {
    top: 0;
    padding: 14px 18px 12px;
  }

  .command-bar {
    top: 67px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 18px;
  }

  h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: 0;
  }

  .description {
    color: var(--text-muted);
    margin: 0;
  }

  .workspace {
    display: grid;
    grid-template-columns: minmax(360px, 2fr) minmax(520px, 3fr);
    gap: 14px;
    padding: 14px 18px 18px;
  }

  .panel {
    min-width: 0;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background-color: var(--bg-elevated);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    border-bottom: 1px solid var(--border-subtle);
    background-color: var(--bg-elevated-soft);
  }

  .panel-title {
    margin: 0 0 3px;
    font-size: 13px;
    font-weight: 650;
  }

  .panel-body {
    padding: 12px;
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .row-actions,
  .summary-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .summary-strip {
    min-width: 0;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th, td {
    border-bottom: 1px solid var(--border-subtle);
    padding: 6px 8px;
    font-size: 12px;
    vertical-align: middle;
  }

  th {
    background-color: var(--bg-elevated-soft);
    color: var(--text-muted);
    font-weight: 600;
    text-align: left;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  input[type="text"],
  input[type="search"] {
    width: 100%;
    background-color: var(--vscode-input-background, var(--bg-elevated));
    border: 1px solid var(--vscode-input-border, var(--border-subtle));
    color: var(--text);
    padding: 5px 7px;
    border-radius: 3px;
    font: inherit;
  }

  input[type="text"]:focus,
  input[type="search"]:focus {
    outline: 1px solid var(--border-strong);
    outline-offset: -1px;
  }

  input.invalid {
    border-color: var(--danger);
    background-color: var(--danger-bg);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 28px;
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 3px;
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

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
    transform: none;
  }

  .search-input {
    margin-bottom: 10px;
  }

  .checkbox-col {
    width: 72px;
    text-align: center;
  }

  .name-col {
    min-width: 220px;
  }

  .row-col {
    width: 44px;
    text-align: center;
  }

  .icon-button {
    min-width: 26px;
    width: 26px;
    height: 26px;
    padding: 0;
    font-size: 14px;
  }

  .icon-heading {
    display: inline-block;
    font-size: 15px;
    line-height: 1;
  }

  .table-wrapper {
    max-height: 430px;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background-color: var(--bg);
  }

  .table-wrapper thead th {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .table-wrapper tbody tr:hover {
    background-color: var(--bg-hover);
  }

  .table-wrapper tbody tr.selected-row {
    background-color: var(--bg-active);
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

  .badge,
  .pill-label {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    background-color: var(--accent-soft);
    color: var(--vscode-badge-foreground, var(--text));
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  .pill-label {
    background-color: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    text-transform: none;
  }

  .target-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .target-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .target-title {
    font-weight: 650;
  }

  .selected-strip {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .selected-strip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 72px;
    overflow-y: auto;
  }

  .selected-group {
    min-width: 0;
  }

  .selected-chip {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty-state {
    color: var(--text-muted);
    font-style: italic;
  }

  .validation-message {
    min-height: 18px;
    color: var(--warning);
    font-size: 12px;
  }

  .validation-message.error {
    color: var(--danger);
  }

  @media (max-width: 920px) {
    .workspace,
    .target-grid {
      grid-template-columns: 1fr;
    }

    .command-bar {
      top: 86px;
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
</head>
<body>
<div class="app-shell">
  <header class="top-bar">
    <h1>Salesforce FLS Commit Manager</h1>
    <p class="description">Prepare field-level security changes for selected profiles and permission sets.</p>
  </header>

  <div class="command-bar">
    <div class="summary-strip" aria-live="polite">
      <span id="fieldCountBadge" class="badge">0 fields</span>
      <span id="targetCountBadge" class="badge">0 targets</span>
      <span id="operationCountBadge" class="pill-label">0 operations</span>
    </div>
    <div class="row-actions">
      <div id="validationMessage" class="validation-message"></div>
      <button id="runApply" class="primary-button" disabled>Apply FLS Changes</button>
    </div>
  </div>

  <main class="workspace">
    <div class="stack">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Selected Targets</h2>
            <p class="hint">Review target selections while editing field rules.</p>
          </div>
        </div>
        <div class="panel-body selected-strip">
          <div class="selected-group">
            <div class="target-header">
              <span class="target-title">Selected Profiles</span>
              <span id="fieldPanelSelectedProfilesBadge" class="pill-label">0 selected</span>
            </div>
            <div id="fieldPanelSelectedProfiles" class="selected-strip-list"></div>
          </div>
          <div class="selected-group">
            <div class="target-header">
              <span class="target-title">Selected Permission Sets</span>
              <span id="fieldPanelSelectedPermsetsBadge" class="pill-label">0 selected</span>
            </div>
            <div id="fieldPanelSelectedPermsets" class="selected-strip-list"></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Fields</h2>
            <p class="hint">Define each field permission rule. EDIT automatically enables READ.</p>
          </div>
          <button id="addRow" type="button">Add Field</button>
        </div>
        <div class="panel-body">
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th class="row-col"></th>
                  <th class="checkbox-col">
                    <span class="icon-heading" title="Remove field permission from selected targets" aria-label="Remove field permission from selected targets">&#128465;</span>
                  </th>
                  <th class="name-col">Field API Name</th>
                  <th class="checkbox-col">READ</th>
                  <th class="checkbox-col">EDIT</th>
                </tr>
              </thead>
              <tbody id="field-rows"></tbody>
            </table>
          </div>
        </div>
      </section>
    </div>

    <aside class="stack">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Targets</h2>
            <p class="hint">Choose exactly where the configured rules should be applied.</p>
          </div>
        </div>
        <div class="panel-body">
          <input id="searchInput" class="search-input" type="search" placeholder="Search profiles and permission sets" />
          <div class="target-grid">
            <div>
              <div class="target-header">
                <span class="target-title">Profiles</span>
                <span id="profileVisibleBadge" class="pill-label">0 found</span>
              </div>
              <div class="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th class="checkbox-col"><input id="profilesCheckAll" type="checkbox" title="Select all visible profiles" /></th>
                      <th class="name-col">Name</th>
                    </tr>
                  </thead>
                  <tbody id="profile-rows"></tbody>
                </table>
              </div>
            </div>
            <div>
              <div class="target-header">
                <span class="target-title">Permission Sets</span>
                <span id="permsetVisibleBadge" class="pill-label">0 found</span>
              </div>
              <div class="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th class="checkbox-col"><input id="permsetsCheckAll" type="checkbox" title="Select all visible permission sets" /></th>
                      <th class="name-col">Name</th>
                    </tr>
                  </thead>
                  <tbody id="permset-rows"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </section>
    </aside>
  </main>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  const fieldRowsEl = document.getElementById('field-rows');
  const profileRowsEl = document.getElementById('profile-rows');
  const permsetRowsEl = document.getElementById('permset-rows');
  const fieldPanelSelectedProfilesEl = document.getElementById('fieldPanelSelectedProfiles');
  const fieldPanelSelectedPermsetsEl = document.getElementById('fieldPanelSelectedPermsets');
  const searchInput = document.getElementById('searchInput');
  const profilesCheckAll = document.getElementById('profilesCheckAll');
  const permsetsCheckAll = document.getElementById('permsetsCheckAll');
  const runApplyBtn = document.getElementById('runApply');
  const addRowBtn = document.getElementById('addRow');
  const fieldCountBadge = document.getElementById('fieldCountBadge');
  const targetCountBadge = document.getElementById('targetCountBadge');
  const operationCountBadge = document.getElementById('operationCountBadge');
  const fieldPanelSelectedProfilesBadge = document.getElementById('fieldPanelSelectedProfilesBadge');
  const fieldPanelSelectedPermsetsBadge = document.getElementById('fieldPanelSelectedPermsetsBadge');
  const profileVisibleBadge = document.getElementById('profileVisibleBadge');
  const permsetVisibleBadge = document.getElementById('permsetVisibleBadge');
  const validationMessage = document.getElementById('validationMessage');

  let availableProfiles = [];
  let availablePermissionSets = [];

  function createFieldRow(entry) {
    const tr = document.createElement('tr');

    const delTd = document.createElement('td');
    delTd.className = 'row-col';
    const delButton = document.createElement('button');
    delButton.type = 'button';
    delButton.textContent = '×';
    delButton.title = 'Delete row';
    delButton.setAttribute('aria-label', 'Delete row');
    delButton.className = 'icon-button';
    delButton.addEventListener('click', () => {
      fieldRowsEl.removeChild(tr);
      if (!fieldRowsEl.children.length) {
        createFieldRow({ field: '', readable: false, editable: false });
      }
      renumberFieldRows();
      refreshState();
    });
    delTd.appendChild(delButton);
    tr.appendChild(delTd);

    const deleteFlagTd = document.createElement('td');
    deleteFlagTd.className = 'checkbox-col';
    const deleteFlagCheckbox = document.createElement('input');
    deleteFlagCheckbox.type = 'checkbox';
    deleteFlagCheckbox.checked = !!entry.remove;
    deleteFlagCheckbox.title = 'Remove this field permission from selected targets';
    deleteFlagTd.appendChild(deleteFlagCheckbox);
    tr.appendChild(deleteFlagTd);

    const fieldTd = document.createElement('td');
    fieldTd.className = 'name-col';
    const fieldInput = document.createElement('input');
    fieldInput.type = 'text';
    fieldInput.value = entry.field || '';
    fieldInput.placeholder = 'e.g. Account.Name__c';
    fieldInput.spellcheck = false;
    fieldTd.appendChild(fieldInput);
    tr.appendChild(fieldTd);

    const readableTd = document.createElement('td');
    readableTd.className = 'checkbox-col';
    const readableInput = document.createElement('input');
    readableInput.type = 'checkbox';
    readableInput.checked = !!entry.readable;
    readableInput.title = 'Grant read access';
    readableTd.appendChild(readableInput);
    tr.appendChild(readableTd);

    const editableTd = document.createElement('td');
    editableTd.className = 'checkbox-col';
    const editableInput = document.createElement('input');
    editableInput.type = 'checkbox';
    editableInput.checked = !!entry.editable;
    editableInput.title = 'Grant edit access';
    editableTd.appendChild(editableInput);
    tr.appendChild(editableTd);

    editableInput.addEventListener('change', () => {
      if (editableInput.checked) {
        readableInput.checked = true;
      }
      refreshState();
    });

    readableInput.addEventListener('change', () => {
      if (!readableInput.checked && editableInput.checked) {
        editableInput.checked = false;
      }
      refreshState();
    });
    deleteFlagCheckbox.addEventListener('change', refreshState);
    fieldInput.addEventListener('input', refreshState);

    fieldRowsEl.appendChild(tr);
    renumberFieldRows();
    refreshState();
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
      tr.classList.toggle('selected-row', includeCheckbox.checked);
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
      tr.classList.toggle('selected-row', includeCheckbox.checked);
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

  function renumberFieldRows() {
    Array.from(fieldRowsEl.children).forEach((tr, index) => {
      const button = tr.querySelector('button');
      if (button) {
        button.title = 'Delete row ' + (index + 1);
        button.setAttribute('aria-label', 'Delete row ' + (index + 1));
      }
    });
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
    if (fieldPanelSelectedProfilesEl) {
      fieldPanelSelectedProfilesEl.innerHTML = '';
      if (profiles.length) {
        for (const name of profiles) {
          const span = document.createElement('span');
          span.className = 'badge selected-chip';
          span.title = name;
          span.textContent = name;
          fieldPanelSelectedProfilesEl.appendChild(span);
        }
      } else {
        const span = document.createElement('span');
        span.className = 'empty-state';
        span.textContent = 'No profiles selected.';
        fieldPanelSelectedProfilesEl.appendChild(span);
      }
    }

    if (fieldPanelSelectedPermsetsEl) {
      fieldPanelSelectedPermsetsEl.innerHTML = '';
      if (permsets.length) {
        for (const name of permsets) {
          const span = document.createElement('span');
          span.className = 'badge selected-chip';
          span.title = name;
          span.textContent = name;
          fieldPanelSelectedPermsetsEl.appendChild(span);
        }
      } else {
        const span = document.createElement('span');
        span.className = 'empty-state';
        span.textContent = 'No permission sets selected.';
        fieldPanelSelectedPermsetsEl.appendChild(span);
      }
    }
  }

  function analyzeFields() {
    const names = new Map();
    let duplicateCount = 0;

    for (const input of Array.from(fieldRowsEl.querySelectorAll('td:nth-child(3) input[type="text"]'))) {
      const value = input.value.trim();
      input.classList.remove('invalid');
      if (!value) {
        continue;
      }

      const key = value.toLowerCase();
      const existing = names.get(key);
      if (existing) {
        input.classList.add('invalid');
        existing.classList.add('invalid');
        duplicateCount += 1;
      } else {
        names.set(key, input);
      }
    }

    return {
      fieldCount: collectFieldData().length,
      duplicateCount
    };
  }

  function visibleNamedRowCount(tbody, dataKey) {
    return Array.from(tbody.children).filter((tr) => {
      return !!tr.dataset[dataKey] && tr.style.display !== 'none';
    }).length;
  }

  function syncCheckAllState(tbody, dataKey, checkbox) {
    if (!checkbox) {
      return;
    }
    const visibleRows = Array.from(tbody.children).filter((tr) => {
      return !!tr.dataset[dataKey] && tr.style.display !== 'none';
    });
    const checkedRows = visibleRows.filter((tr) => {
      const rowCheckbox = tr.querySelector('input[type="checkbox"]');
      return rowCheckbox && rowCheckbox.checked;
    });
    checkbox.checked = visibleRows.length > 0 && checkedRows.length === visibleRows.length;
    checkbox.indeterminate = checkedRows.length > 0 && checkedRows.length < visibleRows.length;
  }

  function refreshState() {
    const profiles = collectSelectedProfiles();
    const permsets = collectSelectedPermissionSets();
    const fieldState = analyzeFields();
    const targetCount = profiles.length + permsets.length;
    const operationCount = fieldState.fieldCount * targetCount;

    renderPreviewLists(profiles, permsets);

    if (fieldCountBadge) {
      fieldCountBadge.textContent = fieldState.fieldCount + (fieldState.fieldCount === 1 ? ' field' : ' fields');
    }
    if (targetCountBadge) {
      targetCountBadge.textContent = targetCount + (targetCount === 1 ? ' target' : ' targets');
    }
    if (operationCountBadge) {
      operationCountBadge.textContent = operationCount + (operationCount === 1 ? ' operation' : ' operations');
    }
    if (fieldPanelSelectedProfilesBadge) {
      fieldPanelSelectedProfilesBadge.textContent = profiles.length + ' selected';
    }
    if (fieldPanelSelectedPermsetsBadge) {
      fieldPanelSelectedPermsetsBadge.textContent = permsets.length + ' selected';
    }
    if (profileVisibleBadge) {
      const count = visibleNamedRowCount(profileRowsEl, 'profileName');
      profileVisibleBadge.textContent = count + ' found';
    }
    if (permsetVisibleBadge) {
      const count = visibleNamedRowCount(permsetRowsEl, 'permsetName');
      permsetVisibleBadge.textContent = count + ' found';
    }

    syncCheckAllState(profileRowsEl, 'profileName', profilesCheckAll);
    syncCheckAllState(permsetRowsEl, 'permsetName', permsetsCheckAll);

    let message = '';
    let isError = false;
    if (fieldState.duplicateCount > 0) {
      message = 'Duplicate field API names need to be removed.';
      isError = true;
    } else if (fieldState.fieldCount === 0) {
      message = 'Add at least one field rule.';
    } else if (targetCount === 0) {
      message = 'Select at least one profile or permission set.';
    }

    if (validationMessage) {
      validationMessage.textContent = message;
      validationMessage.classList.toggle('error', isError);
    }
    if (runApplyBtn) {
      runApplyBtn.disabled = fieldState.fieldCount === 0 || targetCount === 0 || fieldState.duplicateCount > 0;
    }
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
      refreshState();
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
    refreshState();
  }

  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      applySearchFilter(event.target.value);
    });
  }

  function setAllInTbody(tbody, dataKey, checked) {
    for (const tr of Array.from(tbody.children)) {
      const name = tr.dataset[dataKey];
      if (!name || tr.style.display === 'none') {
        continue;
      }
      const checkbox = tr.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = checked;
        tr.classList.toggle('selected-row', checked);
      }
    }
  }

  if (profilesCheckAll) {
    profilesCheckAll.addEventListener('change', (event) => {
      setAllInTbody(profileRowsEl, 'profileName', event.target.checked);
      refreshState();
    });
  }

  if (permsetsCheckAll) {
    permsetsCheckAll.addEventListener('change', (event) => {
      setAllInTbody(permsetRowsEl, 'permsetName', event.target.checked);
      refreshState();
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
      const row = target.closest('tr');
      if (row) {
        row.classList.toggle('selected-row', target.checked);
      }
      refreshState();
    }
  });

  permsetRowsEl.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.type === 'checkbox') {
      const row = target.closest('tr');
      if (row) {
        row.classList.toggle('selected-row', target.checked);
      }
      refreshState();
    }
  });

  // Notify extension that webview is ready
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
