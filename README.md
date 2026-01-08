## SF-FLS-MANAGER

> Salesforce FLS Commit Manager is a VS Code extension that lets you review and update Field-Level Security (FLS) for many profiles and permission sets at once – without hand-editing XML.
> 
> It’s built for Salesforce devs and admins working with source-tracked projects (`force-app/...`) who want a clear, repeatable way to apply the same FLS rules across multiple targets.

## Quick start

1. Open your Salesforce DX project in VS Code.
2. Install / run the **SF-FLS-MANAGER** extension.
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run  
   **Salesforce: Open FLS Commit Manager**.
4. In **Step 1**, add the fields and access levels you care about.
5. In **Step 2**, tick the profiles and permission sets you want to update.
6. Click **Run FLS Commit**.
7. Review the Git diff and commit when you’re happy.

<img width="3320" height="1908" alt="image" src="https://github.com/user-attachments/assets/0ca15d66-5835-4372-8fb2-d084af9de3ca" />

---

### What it does

- Central place to define FLS rules for fields.
- One click to push those rules to:
  - Multiple **profiles** (`*.profile-meta.xml`)
  - Multiple **permission sets** (`*.permissionset-meta.xml`)
- Simple “add/update vs remove” switch per field.
- Clean, minimal diffs – files are only changed when something in FLS actually changes.

The extension scans your workspace for:

- Profiles: `**/force-app/main/default/profiles/**/*.profile-meta.xml`
- Permission sets: `**/force-app/main/default/permissionsets/**/*.permissionset-meta.xml`

---

### Step 1 – Add / remove fields

Describe *what* FLS you want:

- Add one row per field:
  - **Field API Name** – e.g. `Account.Type`, `Contact.Test__c`.
  - **Readable** – grant read access.
  - **Editable** – grant edit access. Turning this on automatically turns on **Readable**.
- **Delete** column:
  - When checked, this rule means “remove this field permission” from the selected targets.
  - Use this when you want to strip access that may already exist.
- Trash icon (first column) deletes the row from the configuration entirely.

On the right you’ll see a **Preview of Selections** that shows which profiles and permission sets are currently selected in Step 2.

All of this is stored in a single config file at the workspace root:

- `fls.config.json`

You can commit this file and share it with your team.

---

### Step 2 – Pick where to apply it

Decide *where* the rules from Step 1 will run:

- A search box filters both lists by name.
- **Profiles** and **Permission Sets** each have:
  - A checkbox column to include/exclude each item (with “check all” in the header).
  - A **Name** column (taken from the file name, e.g.  
    `Sales Manager.profile-meta.xml` → `Sales Manager`).
- All checkboxes start **unchecked** every time you open the manager, so you always make an explicit choice.
- As you change selections, the preview in Step 1 updates.

When ready, click **Run FLS Commit**:

- Your current rules and selections are saved to `fls.config.json`.
- The extension updates just the selected profiles and permission sets.
- A notification tells you how many of each were updated and how many fields per target.

---

### How changes are applied (simple view)

You don’t need to touch XML, but here’s what happens under the hood:

- For every selected profile or permission set:
  - For each field row **without** Delete checked:
    - If the field permission is missing, it’s added.
    - If it exists, readable/editable are updated to match your checkboxes.
  - For each field row **with** Delete checked:
    - If the field permission exists, it’s removed.
    - If it doesn’t exist, that file is left exactly as-is.
- Files are only rewritten when at least one permission actually changed, keeping diffs small and meaningful.

---

### Development (VS Code extension)

- Install dependencies: `npm install`
- Build once: `npm run compile`
- Watch mode: `npm run watch`
- Run the extension:
  - In VS Code, add an "Extension" debug configuration if you don't have one yet.
  - Start debugging to launch the Extension Development Host.

Build output is generated in `out/` and should not be committed.

---

### Troubleshooting

- **“I don’t see any profiles or permission sets”**
  - Check that your project uses the standard SFDX layout under `force-app/main/default/...`.
  - Make sure you have `*.profile-meta.xml` and/or `*.permissionset-meta.xml` files.

- **“Run did nothing”**
  - Confirm you have at least one field in Step 1.
  - Confirm at least one profile or permission set is checked in Step 2.
  - Remember: if a field is marked Delete and it doesn’t exist in a file, that file won’t change.

- **“I want to see what will change”**
  - Use Git (or your VCS) to review the diff after running **Run FLS Commit**.
  - If you don’t like the result, simply discard the changes and adjust the rules or selections.

If behavior ever looks off, your source control is your safety net – roll back, tweak the configuration in the manager, and run again. 
