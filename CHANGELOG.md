# Change Log

## Unreleased

- Added optional custom field creation before FLS updates, supporting Text, Text Area, Long Text Area, Rich Text Area, Number, URL, Currency, Checkbox, Email, Date, DateTime, Percent, and Phone.
- Added field API validation for missing `Object.Field` dots, duplicate rows, existing custom fields, and create-field settings.
- Moved the Fields panel to a full-width top row, with Selected Targets and Targets below it in a 40/60 split.
- Improved field creation controls with clearer disabled states and automatic text length defaults.
- Added Description and Help Text inputs at the end of new field rows and always emits their metadata tags.
- Swapped Label before Field API Name and added label-based custom field API name generation.
- Added an Object selector so generated field API names use `Object.Words_Only__c` format.

## 0.2.3 - 05/08/2026

- Refreshed the webview layout with a sticky command bar, summary badges, selected target preview, and clearer field and target panels.
- Renamed the run action to **Apply FLS Changes**.
- Added inline validation for duplicate field API names, empty field rules, and missing target selections.
- Disabled apply until there is at least one valid field rule and one selected profile or permission set.
- Added search result counts and header checkboxes that select or clear only visible profile and permission set rows.
- Persisted selected profiles and permission sets in `fls.config.json` alongside field rules.
- Updated the extension icon asset.

## 0.1.1 - 05/08/2026

- Fixed target selection so leaving permission sets unchecked no longer applies FLS changes to every permission set.
- Applied the same explicit-selection behavior to profiles.
- Added a warning when no profiles or permission sets are selected before running.
- Scoped profile and permission set discovery to the active workspace folder.
- De-duplicated profile and permission set names shown in the picker.
- Update Icon.png

## 0.0.1 - 1/8/2026

- Initial release of SF-FLS-MANAGER.
- Added a VS Code webview for configuring field-level security changes.
- Supported adding, updating, and removing field permissions across selected profiles and permission sets.
