import * as vscode from 'vscode';
import * as path from 'path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

type SupportedFieldType =
  | 'Text'
  | 'TextArea'
  | 'LongTextArea'
  | 'Html'
  | 'Number'
  | 'Url'
  | 'Currency'
  | 'Checkbox'
  | 'Email'
  | 'Date'
  | 'DateTime'
  | 'Percent'
  | 'Phone';

interface FlsConfigEntry {
  field: string;
  readable: boolean;
  editable: boolean;
  // When true, existing field permissions will be removed
  // instead of added/updated.
  remove?: boolean;
  // When true, create the field metadata before applying FLS.
  create?: boolean;
  label?: string;
  type?: SupportedFieldType;
  length?: number;
  precision?: number;
  scale?: number;
  visibleLines?: number;
}

interface FlsConfig {
  fields: FlsConfigEntry[];
  profiles?: string[];
  permissionSets?: string[];
}

interface ObjectFieldIndex {
  objects: string[];
  fields: string[];
}

interface ParsedFieldName {
  objectApiName: string;
  fieldApiName: string;
}

interface FieldCreationResult {
  created: number;
  skipped: number;
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
      const objectFieldIndex = await buildObjectFieldIndex(workspaceFolder);

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
                  availablePermissionSets,
                  availableObjects: objectFieldIndex.objects,
                  availableFields: objectFieldIndex.fields
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
                  availablePermissionSets,
                  availableObjects: objectFieldIndex.objects,
                  availableFields: objectFieldIndex.fields
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

async function buildObjectFieldIndex(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<ObjectFieldIndex> {
  const objectFiles = await findWorkspaceFiles(
    workspaceFolder,
    '**/force-app/main/default/objects/**/*.object-meta.xml'
  );
  const fieldFiles = await findWorkspaceFiles(
    workspaceFolder,
    '**/force-app/main/default/objects/**/fields/**/*.field-meta.xml'
  );

  const objects = new Set<string>();
  const fields = new Set<string>();

  for (const uri of objectFiles) {
    const objectName = objectNameFromObjectFileUri(uri);
    if (objectName) {
      objects.add(objectName);
    }
  }

  for (const uri of fieldFiles) {
    const parsed = fieldNameFromFieldFileUri(uri);
    if (parsed) {
      objects.add(parsed.objectApiName);
      fields.add(`${parsed.objectApiName}.${parsed.fieldApiName}`);
    }
  }

  return {
    objects: uniqueSortedNames(Array.from(objects)),
    fields: uniqueSortedNames(Array.from(fields))
  };
}

function objectNameFromObjectFileUri(uri: vscode.Uri): string | undefined {
  const base = path.basename(uri.fsPath);
  const objectFromFile = base.replace(/\.object-meta\.xml$/i, '');
  const objectFromFolder = path.basename(path.dirname(uri.fsPath));
  return objectFromFile || objectFromFolder || undefined;
}

function fieldNameFromFieldFileUri(uri: vscode.Uri): ParsedFieldName | undefined {
  const parts = uri.fsPath.split(path.sep);
  const fieldsIndex = parts.lastIndexOf('fields');
  if (fieldsIndex <= 0 || fieldsIndex >= parts.length - 1) {
    return undefined;
  }

  const objectApiName = parts[fieldsIndex - 1];
  const fieldApiName = path.basename(uri.fsPath).replace(/\.field-meta\.xml$/i, '');
  if (!objectApiName || !fieldApiName) {
    return undefined;
  }

  return { objectApiName, fieldApiName };
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

  const invalidField = fieldsConfig.find(
    (entry) => entry.field && !parseQualifiedFieldName(entry.field)
  );
  if (invalidField) {
    vscode.window.showWarningMessage(
      `SF-FLS-MANAGER: Field "${invalidField.field}" must use Object.Field format.`
    );
    return;
  }

  let fieldCreationResult: FieldCreationResult = { created: 0, skipped: 0 };
  try {
    fieldCreationResult = await createConfiguredFields(workspaceFolder, fieldsConfig);
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `SF-FLS-MANAGER: Failed to create field metadata - ${error?.message ?? String(error)}`
    );
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
    if (fieldCreationResult.created > 0) {
      vscode.window.showInformationMessage(
        `SF-FLS-MANAGER: Created ${fieldCreationResult.created} field(s). No profiles or permission sets were selected for FLS updates.`
      );
    } else {
      vscode.window.showWarningMessage(
        'SF-FLS-MANAGER: No profiles or permission sets selected. Check at least one target before running.'
      );
    }
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
    if (fieldCreationResult.created > 0) {
      vscode.window.showInformationMessage(
        `SF-FLS-MANAGER: Created ${fieldCreationResult.created} field(s). No profiles or permission sets needed FLS updates.`
      );
    } else {
      vscode.window.showWarningMessage(
        'SF-FLS-MANAGER: No profiles or permission sets were updated.'
      );
    }
    return;
  }

  const fieldsPerTarget = fieldsConfig.length;
  const totalTargets = profilesUpdated + permissionSetsUpdated;
  const totalFieldOps = totalTargets * fieldsPerTarget;
  const createdSummary =
    fieldCreationResult.created > 0 ? `Created ${fieldCreationResult.created} field(s). ` : '';
  vscode.window.showInformationMessage(
    `SF-FLS-MANAGER: ${createdSummary}Updated ${profilesUpdated} profile(s) and ${permissionSetsUpdated} permission set(s), ${fieldsPerTarget} field(s) each (${totalFieldOps} field updates).`
  );
}

async function createConfiguredFields(
  workspaceFolder: vscode.WorkspaceFolder,
  fieldsConfig: FlsConfigEntry[]
): Promise<FieldCreationResult> {
  const objectIndex = await buildObjectFieldIndex(workspaceFolder);
  const availableObjects = new Set(objectIndex.objects.map((name) => name.toLowerCase()));
  const availableFields = new Set(objectIndex.fields.map((name) => name.toLowerCase()));
  let created = 0;
  let skipped = 0;

  for (const entry of fieldsConfig) {
    if (!entry.create || entry.remove) {
      continue;
    }

    const parsed = parseQualifiedFieldName(entry.field);
    if (!parsed) {
      throw new Error(`Field "${entry.field}" must use Object.Field format.`);
    }
    if (!parsed.fieldApiName.endsWith('__c')) {
      throw new Error(`Field "${entry.field}" must use a custom field API name ending in __c.`);
    }
    if (!availableObjects.has(parsed.objectApiName.toLowerCase())) {
      throw new Error(`Object "${parsed.objectApiName}" was not found in force-app metadata.`);
    }
    if (availableFields.has(entry.field.toLowerCase())) {
      skipped += 1;
      continue;
    }

    const fieldType = normalizeFieldType(entry.type);
    if (!fieldType) {
      throw new Error(`Field "${entry.field}" has an unsupported field type.`);
    }

    const label = (entry.label || labelFromApiName(parsed.fieldApiName)).trim();
    const fieldFolderUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      'force-app',
      'main',
      'default',
      'objects',
      parsed.objectApiName,
      'fields'
    );
    const fieldUri = vscode.Uri.joinPath(fieldFolderUri, `${parsed.fieldApiName}.field-meta.xml`);
    await vscode.workspace.fs.createDirectory(fieldFolderUri);
    const metadata = buildCustomFieldMetadata(parsed.fieldApiName, label, fieldType, entry);
    await vscode.workspace.fs.writeFile(fieldUri, Buffer.from(metadata, 'utf8'));

    availableFields.add(entry.field.toLowerCase());
    created += 1;
  }

  return { created, skipped };
}

function parseQualifiedFieldName(value: string): ParsedFieldName | undefined {
  const parts = (value || '').trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  return {
    objectApiName: parts[0],
    fieldApiName: parts[1]
  };
}

function normalizeFieldType(value: unknown): SupportedFieldType | undefined {
  const allowed: SupportedFieldType[] = [
    'Text',
    'TextArea',
    'LongTextArea',
    'Html',
    'Number',
    'Url',
    'Currency',
    'Checkbox',
    'Email',
    'Date',
    'DateTime',
    'Percent',
    'Phone'
  ];
  return allowed.find((type) => type === value);
}

function labelFromApiName(fieldApiName: string): string {
  return fieldApiName
    .replace(/__c$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function buildCustomFieldMetadata(
  fullName: string,
  label: string,
  type: SupportedFieldType,
  entry: FlsConfigEntry
): string {
  const elements: Array<[string, string | number | boolean]> = [
    ['fullName', fullName],
    ['label', label]
  ];

  switch (type) {
    case 'Text':
      elements.push(['length', clampInteger(entry.length, 1, 255, 255)]);
      elements.push(['required', false]);
      elements.push(['type', 'Text']);
      elements.push(['unique', false]);
      break;
    case 'TextArea':
      elements.push(['length', clampInteger(entry.length, 1, 255, 255)]);
      elements.push(['type', 'TextArea']);
      break;
    case 'LongTextArea':
      elements.push(['length', clampInteger(entry.length, 256, 131072, 32768)]);
      elements.push(['type', 'LongTextArea']);
      elements.push(['visibleLines', clampInteger(entry.visibleLines, 2, 50, 3)]);
      break;
    case 'Html':
      elements.push(['length', clampInteger(entry.length, 256, 131072, 32768)]);
      elements.push(['type', 'Html']);
      elements.push(['visibleLines', clampInteger(entry.visibleLines, 2, 50, 3)]);
      break;
    case 'Number':
      {
        const precision = clampInteger(entry.precision, 1, 18, 18);
        const scale = clampInteger(entry.scale, 0, precision - 1, 0);
        elements.push(['precision', precision]);
        elements.push(['required', false]);
        elements.push(['scale', scale]);
      }
      elements.push(['type', 'Number']);
      elements.push(['unique', false]);
      break;
    case 'Currency':
      {
        const precision = clampInteger(entry.precision, 1, 18, 18);
        const scale = clampInteger(entry.scale, 0, precision - 1, 2);
        elements.push(['precision', precision]);
        elements.push(['required', false]);
        elements.push(['scale', scale]);
      }
      elements.push(['type', 'Currency']);
      break;
    case 'Percent':
      {
        const precision = clampInteger(entry.precision, 1, 18, 18);
        const scale = clampInteger(entry.scale, 0, precision - 1, 2);
        elements.push(['precision', precision]);
        elements.push(['required', false]);
        elements.push(['scale', scale]);
      }
      elements.push(['type', 'Percent']);
      break;
    case 'Checkbox':
      elements.push(['defaultValue', false]);
      elements.push(['type', 'Checkbox']);
      break;
    case 'Url':
    case 'Email':
    case 'Date':
    case 'DateTime':
    case 'Phone':
      elements.push(['required', false]);
      elements.push(['type', type]);
      break;
  }

  const body = elements
    .map(([name, value]) => `    <${name}>${escapeXml(String(value))}</${name}>`)
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">',
    body,
    '</CustomField>',
    ''
  ].join('\n');
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const raw = numberOrDefault(value, fallback);
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 14px 18px 18px;
  }

  .lower-workspace {
    display: grid;
    grid-template-columns: minmax(320px, 2fr) minmax(520px, 3fr);
    gap: 14px;
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
  input[type="number"],
  input[type="search"],
  select {
    width: 100%;
    background-color: var(--vscode-input-background, var(--bg-elevated));
    border: 1px solid var(--vscode-input-border, var(--border-subtle));
    color: var(--text);
    padding: 5px 7px;
    border-radius: 3px;
    font: inherit;
  }

  input[type="text"]:focus,
  input[type="number"]:focus,
  input[type="search"]:focus,
  select:focus {
    outline: 1px solid var(--border-strong);
    outline-offset: -1px;
  }

  input:disabled,
  select:disabled {
    background-color: var(--vscode-disabledForeground, rgba(127, 127, 127, 0.12));
    border-color: var(--border-subtle);
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.45;
  }

  input[type="number"]:disabled {
    text-align: center;
  }

  input.invalid {
    border-color: var(--danger);
    background-color: var(--danger-bg);
  }

  select.invalid {
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

  .type-col {
    min-width: 138px;
  }

  .short-col {
    min-width: 96px;
    width: 96px;
  }

  .two-digit-col {
    min-width: 64px;
    width: 64px;
  }

  .short-col input[type="number"] {
    min-width: 72px;
    padding-left: 8px;
    padding-right: 8px;
    text-align: right;
  }

  .two-digit-col input[type="number"] {
    min-width: 40px;
    padding-left: 6px;
    padding-right: 6px;
    text-align: right;
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
    .lower-workspace,
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
                <th class="checkbox-col">CREATE</th>
                <th class="name-col">Field API Name</th>
                <th class="name-col">Label</th>
                <th class="type-col">Type</th>
                <th class="short-col">Len</th>
                <th class="two-digit-col">Prec</th>
                <th class="two-digit-col">Scale</th>
                <th class="checkbox-col">READ</th>
                <th class="checkbox-col">EDIT</th>
              </tr>
            </thead>
            <tbody id="field-rows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <div class="lower-workspace">
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
    </div>
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

  const fieldTypes = [
    { value: 'Text', label: 'Text' },
    { value: 'TextArea', label: 'Text Area' },
    { value: 'LongTextArea', label: 'Text Area Long' },
    { value: 'Html', label: 'Text Area (Rich)' },
    { value: 'Number', label: 'Number' },
    { value: 'Url', label: 'URL' },
    { value: 'Currency', label: 'Currency' },
    { value: 'Checkbox', label: 'Checkbox' },
    { value: 'Email', label: 'Email' },
    { value: 'Date', label: 'Date' },
    { value: 'DateTime', label: 'DateTime' },
    { value: 'Percent', label: 'Percent' },
    { value: 'Phone', label: 'Phone' }
  ];

  let availableProfiles = [];
  let availablePermissionSets = [];
  let availableObjects = [];
  let availableFieldSet = new Set();

  function inferLabelFromField(value) {
    const parts = (value || '').split('.');
    const fieldName = parts.length === 2 ? parts[1] : value;
    return fieldName
      .replace(/__c$/i, '')
      .replace(/_/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim()
      .replace(/\\b\\w/g, (char) => char.toUpperCase());
  }

  function setNumberInput(input, value, fallback) {
    input.value = String(Number.isFinite(Number(value)) ? Number(value) : fallback);
  }

  function defaultLengthForType(type) {
    if (type === 'Text' || type === 'TextArea') {
      return 255;
    }
    if (type === 'LongTextArea' || type === 'Html') {
      return 32768;
    }
    return 255;
  }

  function usesLength(type) {
    return type === 'Text' || type === 'TextArea' || type === 'LongTextArea' || type === 'Html';
  }

  function usesPrecisionScale(type) {
    return type === 'Number' || type === 'Currency' || type === 'Percent';
  }

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
    deleteFlagCheckbox.dataset.fieldControl = 'remove';
    deleteFlagTd.appendChild(deleteFlagCheckbox);
    tr.appendChild(deleteFlagTd);

    const createTd = document.createElement('td');
    createTd.className = 'checkbox-col';
    const createCheckbox = document.createElement('input');
    createCheckbox.type = 'checkbox';
    createCheckbox.checked = !!entry.create;
    createCheckbox.title = 'Create this field metadata before applying FLS';
    createCheckbox.dataset.fieldControl = 'create';
    createTd.appendChild(createCheckbox);
    tr.appendChild(createTd);

    const fieldTd = document.createElement('td');
    fieldTd.className = 'name-col';
    const fieldInput = document.createElement('input');
    fieldInput.type = 'text';
    fieldInput.value = entry.field || '';
    fieldInput.placeholder = 'e.g. Account.My_Field__c';
    fieldInput.spellcheck = false;
    fieldInput.dataset.fieldControl = 'field';
    fieldTd.appendChild(fieldInput);
    tr.appendChild(fieldTd);

    const labelTd = document.createElement('td');
    labelTd.className = 'name-col';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = entry.label || '';
    labelInput.placeholder = 'Field label';
    labelInput.spellcheck = false;
    labelInput.dataset.fieldControl = 'label';
    labelTd.appendChild(labelInput);
    tr.appendChild(labelTd);

    const typeTd = document.createElement('td');
    typeTd.className = 'type-col';
    const typeSelect = document.createElement('select');
    typeSelect.dataset.fieldControl = 'type';
    for (const fieldType of fieldTypes) {
      const option = document.createElement('option');
      option.value = fieldType.value;
      option.textContent = fieldType.label;
      typeSelect.appendChild(option);
    }
    typeSelect.value = entry.type || 'Text';
    typeTd.appendChild(typeSelect);
    tr.appendChild(typeTd);

    const lengthTd = document.createElement('td');
    lengthTd.className = 'short-col';
    const lengthInput = document.createElement('input');
    lengthInput.type = 'number';
    lengthInput.min = '1';
    lengthInput.max = '131072';
    lengthInput.step = '1';
    setNumberInput(lengthInput, entry.length, defaultLengthForType(typeSelect.value));
    lengthInput.dataset.fieldControl = 'length';
    lengthTd.appendChild(lengthInput);
    tr.appendChild(lengthTd);

    const precisionTd = document.createElement('td');
    precisionTd.className = 'two-digit-col';
    const precisionInput = document.createElement('input');
    precisionInput.type = 'number';
    precisionInput.min = '1';
    precisionInput.max = '18';
    precisionInput.step = '1';
    setNumberInput(precisionInput, entry.precision, 18);
    precisionInput.dataset.fieldControl = 'precision';
    precisionTd.appendChild(precisionInput);
    tr.appendChild(precisionTd);

    const scaleTd = document.createElement('td');
    scaleTd.className = 'two-digit-col';
    const scaleInput = document.createElement('input');
    scaleInput.type = 'number';
    scaleInput.min = '0';
    scaleInput.max = '17';
    scaleInput.step = '1';
    setNumberInput(scaleInput, entry.scale, typeSelect.value === 'Number' ? 0 : 2);
    scaleInput.dataset.fieldControl = 'scale';
    scaleTd.appendChild(scaleInput);
    tr.appendChild(scaleTd);

    const readableTd = document.createElement('td');
    readableTd.className = 'checkbox-col';
    const readableInput = document.createElement('input');
    readableInput.type = 'checkbox';
    readableInput.checked = !!entry.readable;
    readableInput.title = 'Grant read access';
    readableInput.dataset.fieldControl = 'readable';
    readableTd.appendChild(readableInput);
    tr.appendChild(readableTd);

    const editableTd = document.createElement('td');
    editableTd.className = 'checkbox-col';
    const editableInput = document.createElement('input');
    editableInput.type = 'checkbox';
    editableInput.checked = !!entry.editable;
    editableInput.title = 'Grant edit access';
    editableInput.dataset.fieldControl = 'editable';
    editableTd.appendChild(editableInput);
    tr.appendChild(editableTd);

    function syncCreateControls() {
      const createMode = createCheckbox.checked;
      const removeMode = deleteFlagCheckbox.checked;
      labelInput.disabled = !createMode || removeMode;
      typeSelect.disabled = !createMode || removeMode;
      lengthInput.disabled = !createMode || removeMode || !usesLength(typeSelect.value);
      precisionInput.disabled = !createMode || removeMode || !usesPrecisionScale(typeSelect.value);
      scaleInput.disabled = !createMode || removeMode || !usesPrecisionScale(typeSelect.value);
      createCheckbox.disabled = removeMode;
      if (createMode && !labelInput.value.trim()) {
        labelInput.value = inferLabelFromField(fieldInput.value);
      }
    }

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
    deleteFlagCheckbox.addEventListener('change', () => {
      if (deleteFlagCheckbox.checked) {
        createCheckbox.checked = false;
      }
      syncCreateControls();
      refreshState();
    });
    createCheckbox.addEventListener('change', () => {
      syncCreateControls();
      refreshState();
    });
    fieldInput.addEventListener('input', () => {
      if (createCheckbox.checked && !labelInput.value.trim()) {
        labelInput.value = inferLabelFromField(fieldInput.value);
      }
      refreshState();
    });
    labelInput.addEventListener('input', refreshState);
    typeSelect.addEventListener('change', () => {
      if (usesLength(typeSelect.value)) {
        setNumberInput(lengthInput, defaultLengthForType(typeSelect.value), defaultLengthForType(typeSelect.value));
      }
      if (typeSelect.value === 'Number') {
        setNumberInput(scaleInput, scaleInput.value, 0);
      } else if (usesPrecisionScale(typeSelect.value)) {
        setNumberInput(scaleInput, scaleInput.value, 2);
      }
      syncCreateControls();
      refreshState();
    });
    lengthInput.addEventListener('input', refreshState);
    precisionInput.addEventListener('input', refreshState);
    scaleInput.addEventListener('input', refreshState);

    fieldRowsEl.appendChild(tr);
    syncCreateControls();
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
      const deleteFlag = tr.querySelector('[data-field-control="remove"]');
      const create = tr.querySelector('[data-field-control="create"]');
      const field = tr.querySelector('[data-field-control="field"]');
      const label = tr.querySelector('[data-field-control="label"]');
      const type = tr.querySelector('[data-field-control="type"]');
      const length = tr.querySelector('[data-field-control="length"]');
      const precision = tr.querySelector('[data-field-control="precision"]');
      const scale = tr.querySelector('[data-field-control="scale"]');
      const readable = tr.querySelector('[data-field-control="readable"]');
      const editable = tr.querySelector('[data-field-control="editable"]');
      if (!field.value.trim()) {
        continue;
      }
      const entry = {
        field: field.value.trim(),
        readable: !!(readable && readable.checked),
        editable: !!(editable && editable.checked),
        remove: !!(deleteFlag && deleteFlag.checked)
      };
      if (create && create.checked) {
        entry.create = true;
        entry.label = label && label.value.trim() ? label.value.trim() : inferLabelFromField(field.value);
        entry.type = type && type.value ? type.value : 'Text';
        if (usesLength(entry.type)) {
          entry.length = Number(
            length && length.value ? length.value : defaultLengthForType(entry.type)
          );
        }
        if (usesPrecisionScale(entry.type)) {
          entry.precision = Number(precision && precision.value ? precision.value : 18);
          entry.scale = Number(scale && scale.value ? scale.value : entry.type === 'Number' ? 0 : 2);
        }
      }
      entries.push(entry);
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

  function parseQualifiedFieldName(value) {
    const parts = (value || '').trim().split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return null;
    }
    return { objectApiName: parts[0], fieldApiName: parts[1] };
  }

  function isKnownStandardOrSourceField(fieldName) {
    const parsed = parseQualifiedFieldName(fieldName);
    if (!parsed) {
      return false;
    }
    if (availableFieldSet.has(fieldName.toLowerCase())) {
      return true;
    }
    return !parsed.fieldApiName.endsWith('__c');
  }

  function clearRowValidation(tr) {
    for (const input of Array.from(tr.querySelectorAll('input, select'))) {
      input.classList.remove('invalid');
      input.title = input.dataset.originalTitle || input.title || '';
    }
  }

  function markInvalid(control, message) {
    if (!control) {
      return;
    }
    if (!control.dataset.originalTitle) {
      control.dataset.originalTitle = control.title || '';
    }
    control.classList.add('invalid');
    control.title = message;
  }

  function analyzeFields() {
    const names = new Map();
    let duplicateCount = 0;
    let invalidCount = 0;
    let createCount = 0;
    const availableObjectSet = new Set(availableObjects.map((name) => name.toLowerCase()));

    for (const tr of Array.from(fieldRowsEl.children)) {
      clearRowValidation(tr);
      const input = tr.querySelector('[data-field-control="field"]');
      const create = tr.querySelector('[data-field-control="create"]');
      const remove = tr.querySelector('[data-field-control="remove"]');
      const label = tr.querySelector('[data-field-control="label"]');
      const type = tr.querySelector('[data-field-control="type"]');
      const length = tr.querySelector('[data-field-control="length"]');
      const precision = tr.querySelector('[data-field-control="precision"]');
      const scale = tr.querySelector('[data-field-control="scale"]');
      const value = input ? input.value.trim() : '';
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

      const parsed = parseQualifiedFieldName(value);
      if (!parsed) {
        invalidCount += 1;
        markInvalid(input, 'Use Object.Field format, including the dot.');
        continue;
      }

      const createMode = !!(create && create.checked);
      const removeMode = !!(remove && remove.checked);
      if (createMode) {
        createCount += 1;
        if (!parsed.fieldApiName.endsWith('__c')) {
          invalidCount += 1;
          markInvalid(input, 'Created fields must use a custom API name ending in __c.');
        }
        if (!availableObjectSet.has(parsed.objectApiName.toLowerCase())) {
          invalidCount += 1;
          markInvalid(input, 'Object was not found in force-app/main/default/objects.');
        }
        if (availableFieldSet.has(key)) {
          invalidCount += 1;
          markInvalid(input, 'This field already exists in source metadata.');
        }
        if (!label || !label.value.trim()) {
          invalidCount += 1;
          markInvalid(label, 'Label is required when creating a field.');
        }
        if (!type || !type.value) {
          invalidCount += 1;
          markInvalid(type, 'Type is required when creating a field.');
        }
        if (usesLength(type.value)) {
          const rawLength = Number(length && length.value);
          const minLength = type.value === 'LongTextArea' || type.value === 'Html' ? 256 : 1;
          const maxLength = type.value === 'Text' || type.value === 'TextArea' ? 255 : 131072;
          if (!Number.isFinite(rawLength) || rawLength < minLength || rawLength > maxLength) {
            invalidCount += 1;
            markInvalid(length, 'Length is outside the valid range for this field type.');
          }
        }
        if (usesPrecisionScale(type.value)) {
          const rawPrecision = Number(precision && precision.value);
          const rawScale = Number(scale && scale.value);
          if (!Number.isFinite(rawPrecision) || rawPrecision < 1 || rawPrecision > 18) {
            invalidCount += 1;
            markInvalid(precision, 'Precision must be between 1 and 18.');
          }
          if (
            !Number.isFinite(rawScale) ||
            rawScale < 0 ||
            rawScale > 17 ||
            rawScale >= rawPrecision
          ) {
            invalidCount += 1;
            markInvalid(scale, 'Scale must be between 0 and 17 and less than precision.');
          }
        }
      } else if (!removeMode && !isKnownStandardOrSourceField(value)) {
        invalidCount += 1;
        markInvalid(input, 'Custom field was not found in source metadata. Check Create to add it.');
      }
    }

    return {
      fieldCount: collectFieldData().length,
      duplicateCount,
      invalidCount,
      createCount
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
    } else if (fieldState.invalidCount > 0) {
      message = 'Fix invalid field names or creation settings before applying.';
      isError = true;
    } else if (fieldState.fieldCount === 0) {
      message = 'Add at least one field rule.';
    } else if (targetCount === 0 && fieldState.createCount === 0) {
      message = 'Select at least one profile or permission set.';
    }

    if (validationMessage) {
      validationMessage.textContent = message;
      validationMessage.classList.toggle('error', isError);
    }
    if (runApplyBtn) {
      runApplyBtn.disabled =
        fieldState.fieldCount === 0 ||
        (targetCount === 0 && fieldState.createCount === 0) ||
        fieldState.duplicateCount > 0 ||
        fieldState.invalidCount > 0;
    }
  }

  addRowBtn.addEventListener('click', () => {
    createFieldRow({ field: '', readable: false, editable: false });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'load') {
      const data = message.data || {};
      availableObjects = Array.isArray(data.availableObjects) ? data.availableObjects : [];
      availableFieldSet = new Set(
        (Array.isArray(data.availableFields) ? data.availableFields : []).map((name) =>
          String(name).toLowerCase()
        )
      );
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
